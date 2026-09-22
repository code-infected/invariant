/**
 * `invariant ingest`: import trial trace files written by an out-of-process adapter
 * (adapters/langgraph today) into the trace store as one batch.
 *
 * The files are the adapter's whole contract with the harness (schema/trial-trace.ts).
 * Everything is checked before anything is written, so a bad file never leaves half a
 * batch behind:
 *
 *   shape      every file parses against TrialTraceSchema (Zod; the same definition as the
 *              checked-in schemas/trial-trace.v1.schema.json adapters validate against).
 *   identity   task and tier match --task/--tier; every file carries the same batch block.
 *   fixture    each variant is in tasks/<task>.variants.json at the same fixture_version,
 *              and the text the agent was sent is the fixture's text, byte for byte. A
 *              trial run on a phrasing nobody reviewed is not a trial of this task.
 *   matrix     exactly one file per (variant, trial) cell the batch block declares, no gaps
 *              and no duplicates, so the batch reads like one written by `invariant run`.
 *   sandbox    every call to a tool the task declares dangerous is is_sandboxed, and nothing
 *              else is. An unsandboxed dangerous call means the real side effect ran; that
 *              trace is refused, not scored.
 *   sequence   tool calls are in sequence_index order, 0..n-1.
 *
 * Then the batch is written through the ordinary TraceStore API (createBatch, recordRun,
 * recordToolCall, deployment fingerprint, raw trace, completeRun, finishBatch), which is
 * what makes an ingested batch indistinguishable to `score`, `gate` and the dashboard. The
 * fingerprint hash is computed here from the components in the file, with the same code
 * the MCP path uses, so no adapter has to reimplement the hashing recipe. If a write fails
 * part way, the batch is left without finished_at, and score and gate refuse an unfinished
 * batch.
 *
 * Each file is one attempt that counts: v1 has no infra-retry chain (runs.attempt is 1,
 * nothing superseded). A cell that ended infra_error is ingested as such and excluded from
 * scoring like any other.
 */
import fs from "node:fs";
import path from "node:path";
import { computeDeploymentFingerprint, isScriptedStandIn, openTraceStore, type Tier } from "@invariant/trace-store";
import { canonicalJson } from "@invariant/scoring";
import { loadValidTask, type LoadedTask } from "../lib/load-tasks.js";
import { INVARIANT_DIR, REPO_ROOT } from "../lib/paths.js";
import { selectTier } from "../lib/tier.js";
import { TrialTraceSchema, type TrialTrace } from "../schema/trial-trace.js";
import { syncTask } from "./run.js";

export interface IngestOptions {
  task: string;
  tier: Tier;
  /** Trace files, or directories whose *.json files are all read (not recursive). */
  paths: string[];
  json: boolean;
}

export interface IngestDeps {
  /** Trace store directory; defaults to <repo>/.invariant. */
  storeRoot?: string;
  out?: (line: string) => void;
  err?: (line: string) => void;
}

export interface IngestResult {
  batch_id: string;
  task: string;
  tier: Tier;
  batch_key: string;
  files: string[];
  runs: number;
  statuses: Record<string, number>;
  tool_calls: number;
  sandboxed_calls: number;
  fingerprints: string[];
  /** Every fingerprint reported the scripted stand-in marker: SYNTHETIC trials, not a model. */
  synthetic: boolean;
  adapters: string[];
  warnings: string[];
}

/** Ingest refused the input. `problems` lists every reason, one per line; nothing was written. */
export class IngestError extends Error {
  constructor(readonly problems: string[]) {
    super(`refusing to ingest, nothing was written:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.name = "IngestError";
  }
}

interface LoadedFile {
  file: string;
  trace: TrialTrace;
}

export function expandPaths(paths: string[]): string[] {
  const files: string[] = [];
  for (const p of paths) {
    const abs = path.resolve(p);
    if (!fs.existsSync(abs)) throw new IngestError([`${p}: no such file or directory`]);
    if (fs.statSync(abs).isDirectory()) {
      files.push(
        ...fs
          .readdirSync(abs)
          .filter((f) => f.endsWith(".json"))
          .sort()
          .map((f) => path.join(abs, f))
      );
    } else {
      files.push(abs);
    }
  }
  if (files.length === 0) throw new IngestError([`no .json trace files in ${paths.join(", ")}`]);
  return [...new Set(files)];
}

function display(file: string): string {
  const rel = path.relative(process.cwd(), file);
  return rel.startsWith("..") ? file : rel;
}

/** Parse and shape-check every file. Returns the traces or throws with every problem found. */
export function parseTraceFiles(files: string[]): LoadedFile[] {
  const problems: string[] = [];
  const loaded: LoadedFile[] = [];
  for (const file of files) {
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (err) {
      problems.push(`${display(file)}: not valid JSON (${err instanceof Error ? err.message : String(err)})`);
      continue;
    }
    const result = TrialTraceSchema.safeParse(raw);
    if (!result.success) {
      for (const issue of result.error.issues) {
        problems.push(`${display(file)}: ${issue.path.length ? issue.path.join(".") : "(root)"}: ${issue.message}`);
      }
      continue;
    }
    loaded.push({ file, trace: result.data });
  }
  if (problems.length > 0) throw new IngestError(problems);
  return loaded;
}

/** The checks that need the task, the fixture, or the other files. Returns problems and warnings. */
export function checkBatch(
  files: LoadedFile[],
  task: LoadedTask,
  tier: Tier
): { problems: string[]; warnings: string[] } {
  const problems: string[] = [];
  const warnings: string[] = [];
  const fixture = task.fixture!;
  const fixtureText = new Map(fixture.variants.map((v) => [v.id, v.text]));
  const dangerous = new Set(task.spec.tools.dangerous.map((d) => d.name));

  const batch = files[0]!.trace.batch;
  const batchKey = canonicalJson(batch);
  for (const { file, trace } of files) {
    const f = display(file);
    if (trace.task !== task.spec.name) problems.push(`${f}: task is "${trace.task}", expected "${task.spec.name}" (--task)`);
    if (trace.tier !== tier) problems.push(`${f}: tier is "${trace.tier}", expected "${tier}" (--tier)`);
    if (canonicalJson(trace.batch) !== batchKey) {
      problems.push(`${f}: batch block differs from ${display(files[0]!.file)}'s; one ingest is one batch (key ${batch.key})`);
    }
    const expectedText = fixtureText.get(trace.variant.id);
    if (expectedText === undefined) {
      problems.push(`${f}: variant "${trace.variant.id}" is not in tasks/${task.spec.name}.variants.json`);
    } else if (trace.variant.text !== expectedText) {
      problems.push(`${f}: variant ${trace.variant.id} text differs from tasks/${task.spec.name}.variants.json; the agent was not sent the reviewed phrasing`);
    }
    if (trace.variant.fixture_version !== fixture.fixture_version) {
      problems.push(`${f}: fixture_version ${trace.variant.fixture_version}, but tasks/${task.spec.name}.variants.json is version ${fixture.fixture_version}`);
    }
    if (!batch.variant_labels.includes(trace.variant.id)) {
      problems.push(`${f}: variant ${trace.variant.id} is not one of the batch's variant_labels [${batch.variant_labels.join(", ")}]`);
    }
    if (trace.trial > batch.trials_per_variant) {
      problems.push(`${f}: trial ${trace.trial} exceeds the batch's trials_per_variant (${batch.trials_per_variant})`);
    }
    if (trace.status === "infra_error" && trace.error === null) problems.push(`${f}: status infra_error needs an error`);
    if (trace.status !== "infra_error" && trace.error !== null) problems.push(`${f}: status ${trace.status} must have error null`);
    const okStops = { ok: ["reply_to_user", "end_turn"], timeout: ["max_turns", "wall_clock_timeout"], infra_error: ["error"] };
    if (!okStops[trace.status].includes(trace.stop_reason)) {
      problems.push(`${f}: stop_reason ${trace.stop_reason} does not fit status ${trace.status}`);
    }
    trace.tool_calls.forEach((call, i) => {
      if (call.sequence_index !== i) {
        problems.push(`${f}: tool_calls[${i}] has sequence_index ${call.sequence_index}; calls must be in order 0..n-1`);
      }
      if (dangerous.has(call.tool_name) && !call.is_sandboxed) {
        problems.push(
          `${f}: tool_calls[${i}] ${call.tool_name} is declared dangerous in tasks/${task.spec.name}.yaml but was NOT sandboxed: ` +
            `the real side effect ran. Refusing to record it as a test trial.`
        );
      }
      if (!dangerous.has(call.tool_name) && call.is_sandboxed) {
        problems.push(`${f}: tool_calls[${i}] ${call.tool_name} is marked sandboxed but the task does not declare it dangerous`);
      }
    });
  }

  if (new Set(batch.variant_labels).size !== batch.variant_labels.length) problems.push(`batch variant_labels repeat a label`);
  for (const label of batch.variant_labels) {
    if (!fixtureText.has(label)) problems.push(`batch variant_labels: "${label}" is not in tasks/${task.spec.name}.variants.json`);
  }

  // Exactly one file per declared cell.
  const cells = new Map<string, string[]>();
  for (const { file, trace } of files) {
    const key = `${trace.variant.id} trial ${trace.trial}`;
    cells.set(key, [...(cells.get(key) ?? []), display(file)]);
  }
  for (const [key, fs_] of cells) if (fs_.length > 1) problems.push(`${key} appears in ${fs_.length} files: ${fs_.join(", ")}`);
  const missing: string[] = [];
  for (let trial = 1; trial <= batch.trials_per_variant; trial++) {
    for (const label of batch.variant_labels) if (!cells.has(`${label} trial ${trial}`)) missing.push(`${label} trial ${trial}`);
  }
  if (missing.length > 0) problems.push(`the run matrix is incomplete, no file for: ${missing.join(", ")}`);

  const selection = selectTier(task.spec, fixture, tier);
  const tierLabels = selection.variants.map((v) => v.id);
  if (batch.trials_per_variant !== selection.trials || canonicalJson(batch.variant_labels) !== canonicalJson(tierLabels)) {
    warnings.push(
      `this batch is [${batch.variant_labels.join(", ")}] x ${batch.trials_per_variant} trial(s), not the ${tier} tier's ` +
        `[${tierLabels.join(", ")}] x ${selection.trials} from tasks/${task.spec.name}.yaml; it is recorded with its real shape`
    );
  }
  return { problems, warnings };
}

export function ingestTraceFiles(opts: Omit<IngestOptions, "json">, deps: Pick<IngestDeps, "storeRoot"> = {}): IngestResult {
  const task = loadValidTask(opts.task);
  const files = parseTraceFiles(expandPaths(opts.paths));
  const { problems, warnings } = checkBatch(files, task, opts.tier);
  if (problems.length > 0) throw new IngestError(problems);

  const batch = files[0]!.trace.batch;
  const fixture = task.fixture!;
  const variants = batch.variant_labels.map((label) => fixture.variants.find((v) => v.id === label)!);
  // Trial-major, like the batch runner, so run rows land in the order `invariant run` writes them.
  const order = new Map(batch.variant_labels.map((l, i) => [l, i]));
  const ordered = [...files].sort(
    (a, b) => a.trace.trial - b.trace.trial || order.get(a.trace.variant.id)! - order.get(b.trace.variant.id)!
  );

  const store = openTraceStore({ root: deps.storeRoot ?? INVARIANT_DIR });
  let batchId: string | null = null;
  try {
    const { taskId, variantIds } = syncTask(store, task, variants);
    batchId = store.createBatch({
      task_id: taskId,
      tier: opts.tier,
      trials_per_variant: batch.trials_per_variant,
      variants_requested: batch.variants_requested,
      variant_labels: batch.variant_labels,
    });

    const statuses: Record<string, number> = {};
    const hashes: string[] = [];
    const versions: string[] = [];
    let toolCalls = 0;
    let sandboxed = 0;
    for (const { file, trace } of ordered) {
      const runId = store.recordRun({
        task_id: taskId,
        variant_id: variantIds.get(trace.variant.id)!,
        trial_number: trace.trial,
        batch_id: batchId,
        attempt: 1,
        status: "running",
      });
      for (const call of trace.tool_calls) {
        store.recordToolCall({
          run_id: runId,
          sequence_index: call.sequence_index,
          tool_name: call.tool_name,
          args: call.args,
          response: call.response,
          is_sandboxed: call.is_sandboxed,
          called_at: call.timestamp,
        });
        toolCalls++;
        if (call.is_sandboxed) sandboxed++;
      }
      if (trace.fingerprint !== null) {
        const fp = computeDeploymentFingerprint(trace.fingerprint);
        store.recordDeploymentFingerprint(fp);
        store.setRunFingerprint(runId, fp.hash);
        if (!hashes.includes(fp.hash)) hashes.push(fp.hash);
        versions.push(fp.model_version);
      }
      const ref = store.writeRawTrace(runId, {
        run_id: runId,
        batch_id: batchId,
        ingested: { from: file, at: new Date().toISOString(), adapter: trace.adapter },
        ...trace,
      });
      store.completeRun({
        run_id: runId,
        status: trace.status,
        final_output: trace.final_output,
        latency_ms: trace.latency_ms,
        // Tokens, not dollars, as in the MCP path (see run-trial.ts).
        token_cost: trace.usage.input_tokens + trace.usage.output_tokens,
        trace_blob_ref: ref,
      });
      statuses[trace.status] = (statuses[trace.status] ?? 0) + 1;
    }
    store.finishBatch(batchId);

    return {
      batch_id: batchId,
      task: task.spec.name,
      tier: opts.tier,
      batch_key: batch.key,
      files: ordered.map((f) => f.file),
      runs: ordered.length,
      statuses,
      tool_calls: toolCalls,
      sandboxed_calls: sandboxed,
      fingerprints: hashes,
      synthetic: versions.length > 0 && versions.every((v) => isScriptedStandIn(v)),
      adapters: [...new Set(files.map((f) => `${f.trace.adapter.name} ${f.trace.adapter.version}`))],
      warnings,
    };
  } catch (err) {
    if (batchId !== null && !(err instanceof IngestError)) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`ingest failed part way (${message}); batch ${batchId} was left unfinished, and score/gate refuse unfinished batches.`);
    }
    throw err;
  } finally {
    store.close();
  }
}

export function runIngest(opts: IngestOptions, deps: IngestDeps = {}): IngestResult {
  const out = deps.out ?? ((line: string) => console.log(line));
  const err = deps.err ?? ((line: string) => console.error(line));
  const result = ingestTraceFiles(opts, deps);
  for (const w of result.warnings) err(`warning: ${w}`);
  if (opts.json) {
    out(JSON.stringify(result, null, 2));
    return result;
  }
  const counts = Object.entries(result.statuses)
    .map(([s, n]) => `${n} ${s}`)
    .join(", ");
  out(`ingested ${result.runs} run(s) of ${result.task} (${result.tier} tier) from ${result.adapters.join(", ")}`);
  out(`  batch        : ${result.batch_id}  (adapter batch key ${result.batch_key})`);
  out(`  runs         : ${counts}`);
  out(`  tool calls   : ${result.tool_calls}, ${result.sandboxed_calls} sandboxed`);
  out(
    `  deployment   : ${result.fingerprints.length === 0 ? "no fingerprint (no model response)" : result.fingerprints.map((h) => h.slice(0, 12)).join(", ")}` +
      (result.synthetic ? "  SYNTHETIC (scripted stand-in, not a model)" : "")
  );
  out(`  trace store  : ${path.relative(REPO_ROOT, path.join(deps.storeRoot ?? INVARIANT_DIR, "trace.db"))}`);
  out(`  next         : invariant score --batch=${result.batch_id}`);
  return result;
}
