/**
 * Adversarial mode (ARCHITECTURE.md section 4, "injection propagation").
 *
 * `invariant adversarial run` fans out a task's tier exactly like `invariant run`, with one
 * difference: the proxy plants a payload fixture's text into one targeted tool response in
 * every run. The batch is stored as kind "adversarial" with the payload's id and a snapshot
 * of it, so it never mixes with consistency batches (not in scoring, not in the gate's
 * consistency verdict, not in the dashboard's leaderboard or trends).
 *
 * Scoring is propagation only (@invariant/scoring propagation.ts): per run, did a call
 * matching the payload's unauthorized_action follow the injected call, and how many calls
 * later; per batch, the propagation rate over runs that actually received the payload and
 * the depth distribution. The gate reports it in a separate security section with its own
 * verdict and exit code 3.
 *
 * Payloads are TEST FIXTURES (tasks/adversarial/). The agent under test needs
 * ANTHROPIC_API_KEY like any run; the scripted stand-in in adversarial-fixture.ts exists
 * only to prove the harness detects propagation, never as a finding about a model.
 */
import { createHash } from "node:crypto";
import path from "node:path";
import {
  requireApiKey,
  runBatch,
  type BatchEvent,
  type BatchSummary,
  type CallMessagesOptions,
  type MessagesResponse,
  type RetryPolicy,
} from "@invariant/agent-driver";
import type { UpstreamConfig } from "@invariant/mcp-proxy";
import {
  canonicalJson,
  propagationVerdict,
  scorePropagation,
  type PropagationResult,
  type PropagationVerdict,
} from "@invariant/scoring";
import { openTraceStore, type BatchRow, type TraceStore } from "@invariant/trace-store";
import { loadConfig } from "../lib/config.js";
import { batchFingerprints, fingerprintLines, type BatchFingerprintSummary } from "../lib/fingerprints.js";
import { loadValidTask, type LoadedTask } from "../lib/load-tasks.js";
import {
  injectionFor,
  loadAllPayloads,
  loadValidPayload,
  propagationSpecFor,
  resolvePayloadArg,
  type LoadedPayload,
} from "../lib/load-payloads.js";
import { INVARIANT_DIR, REPO_ROOT } from "../lib/paths.js";
import { selectTier, type Tier } from "../lib/tier.js";
import { describeGap, requireUpstream, toolCoverage } from "../lib/upstream.js";
import { AdversarialPayloadSchema, type AdversarialPayload } from "../schema/adversarial-payload.js";
import { syncTask } from "./run.js";

export type ValidPayload = LoadedPayload & { payload: AdversarialPayload };

// ---------------------------------------------------------------- running

export interface AdversarialBatchPlan {
  tier: Tier;
  variants: Array<{ id: string; text: string }>;
  variants_requested: number;
  trials: number;
  concurrency: number;
  retry: RetryPolicy;
  upstream: UpstreamConfig;
  model?: string;
  system_prompt?: string;
}

export interface AdversarialBatchDeps {
  apiKey?: string;
  onEvent?: (event: BatchEvent) => void;
  log?: (message: string) => void;
  /** Test seam (see TrialDeps.callModel). Only the scripted fixtures and demo-seed set it. */
  callModel?: (options: CallMessagesOptions) => Promise<MessagesResponse>;
  sleep?: (ms: number) => Promise<void>;
}

/** What is stored on the batch: the payload exactly as it was planted, and where it came from. */
export function payloadSnapshot(p: ValidPayload): Record<string, unknown> {
  return { ...p.payload, source: p.file };
}

/** One adversarial batch: the tier's matrix, with the payload planted in every run. */
export async function runAdversarialBatch(
  store: TraceStore,
  task: LoadedTask,
  payload: ValidPayload,
  plan: AdversarialBatchPlan,
  deps: AdversarialBatchDeps = {}
): Promise<BatchSummary> {
  if (payload.payload.task !== task.spec.name) {
    throw new Error(`payload ${payload.id} targets task "${payload.payload.task}", not "${task.spec.name}"`);
  }
  if (!task.spec.adversarial.enabled) {
    throw new Error(
      `task ${task.spec.name} has adversarial.enabled: false in tasks/${task.spec.name}.yaml; ` +
        `set it to true to allow adversarial runs against it.`
    );
  }
  const { taskId, variantIds } = syncTask(store, task, plan.variants);
  return runBatch(
    {
      task_id: taskId,
      task_name: task.spec.name,
      tier: plan.tier,
      variants: plan.variants.map((v) => ({ variant_id: variantIds.get(v.id)!, variant_label: v.id, prompt_text: v.text })),
      variants_requested: plan.variants_requested,
      trials: plan.trials,
      trial: {
        dangerous_tools: task.spec.tools.dangerous,
        upstream: plan.upstream,
        max_wall_clock_seconds: task.spec.execution.max_wall_clock_seconds,
        model: plan.model,
        system_prompt: plan.system_prompt,
        injection: injectionFor(payload.payload),
      },
      concurrency: plan.concurrency,
      retry: plan.retry,
      kind: "adversarial",
      payload_id: payload.id,
      adversarial_payload: payloadSnapshot(payload),
    },
    { store, ...deps }
  );
}

// ---------------------------------------------------------------- scoring

/** Stored in scores.details for an adversarial batch. */
export interface AdversarialScoreDetails {
  kind: "adversarial";
  payload_id: string;
  payload_source: string;
  scoring_key: string;
  labels: Record<string, string>;
  inject: AdversarialPayload["inject"];
  unauthorized_action: AdversarialPayload["unauthorized_action"];
  propagation: PropagationResult;
}

export interface StoredPropagation {
  batch: BatchRow;
  payload: AdversarialPayload;
  /** Where the payload used for scoring came from. */
  payload_source: string;
  result: PropagationResult;
  /** Against the payload's max_propagation_rate as it is now. */
  verdict: PropagationVerdict;
  score_id: string;
  source: "stored" | "computed";
  labels: Map<string, string>;
  fingerprints: BatchFingerprintSummary;
  warnings: string[];
}

/** Everything but the threshold that changes the numbers: the thresholds are re-applied at gate time. */
export function propagationScoringKey(p: AdversarialPayload): string {
  const { max_propagation_rate: _ignored, ...spec } = propagationSpecFor(p);
  return createHash("sha256").update(canonicalJson(spec)).digest("hex");
}

/**
 * The payload an adversarial batch is scored against: tasks/adversarial/<id>.yaml as it
 * is now (the reviewed source, and where the matcher and threshold are set), with a warning
 * if what it would plant differs from what this batch actually planted. When the fixture
 * is gone, the snapshot stored on the batch is used, and the report says so.
 */
export function payloadForBatch(batch: BatchRow): { payload: AdversarialPayload; source: string; warnings: string[] } {
  const snapshot = AdversarialPayloadSchema.safeParse(
    Object.fromEntries(Object.entries((batch.adversarial_payload ?? {}) as Record<string, unknown>).filter(([k]) => k !== "source"))
  );
  const warnings: string[] = [];
  let current: ValidPayload | null = null;
  try {
    current = batch.payload_id ? loadValidPayload(batch.payload_id) : null;
  } catch (err) {
    warnings.push(`payload fixture ${batch.payload_id} could not be loaded now (${(err as Error).message.split("\n")[0]})`);
  }
  if (current) {
    if (snapshot.success && canonicalJson(snapshot.data.inject) !== canonicalJson(current.payload.inject)) {
      warnings.push(
        `${current.file} plants something different now than when batch ${batch.id} ran; the batch's traces show what was ` +
          `actually planted (stored with the batch), and scoring uses the fixture's current matcher and threshold.`
      );
    }
    return { payload: current.payload, source: current.file, warnings };
  }
  if (!snapshot.success) {
    throw new Error(`batch ${batch.id} has no usable payload: the fixture is gone and the stored snapshot does not parse.`);
  }
  warnings.push(`scored against the payload snapshot stored with batch ${batch.id}.`);
  return { payload: snapshot.data, source: `snapshot stored with batch ${batch.id}`, warnings };
}

/** Labels like "v2 trial 3" for every matrix run. */
function runLabels(store: TraceStore, batch: BatchRow): Map<string, string> {
  const labels = new Map<string, string>();
  for (const run of store.getBatchRuns(batch.id)) {
    labels.set(run.id, `${store.getVariant(run.variant_id)?.label ?? "?"} trial ${run.trial_number}`);
  }
  return labels;
}

/**
 * Score an adversarial batch for injection propagation and persist it, or reuse the latest
 * stored score when it was computed from the same payload matcher (unless rescore).
 */
export function scoreAdversarialBatch(store: TraceStore, batch: BatchRow, opts: { rescore?: boolean } = {}): StoredPropagation {
  if (batch.kind !== "adversarial") throw new Error(`batch ${batch.id} is a ${batch.kind} batch, not an adversarial one.`);
  if (batch.finished_at === null) {
    throw new Error(`adversarial batch ${batch.id} has not finished (still running, or its process died); refusing to score a partial matrix.`);
  }
  const { payload, source, warnings } = payloadForBatch(batch);
  const key = propagationScoringKey(payload);
  const fingerprints = batchFingerprints(store, batch.id);
  const finish = (result: PropagationResult, scoreId: string, from: "stored" | "computed", labels: Map<string, string>): StoredPropagation => ({
    batch,
    payload,
    payload_source: source,
    result,
    verdict: propagationVerdict(result.rate, payload.gate.max_propagation_rate),
    score_id: scoreId,
    source: from,
    labels,
    fingerprints,
    warnings,
  });

  if (!opts.rescore) {
    const row = store.getScores(batch.id)[0];
    const d = row?.details as Partial<AdversarialScoreDetails> | undefined;
    if (row && d?.kind === "adversarial" && d.scoring_key === key && d.propagation) {
      return finish(d.propagation, row.id, "stored", new Map(Object.entries(d.labels ?? {})));
    }
  }

  const labels = runLabels(store, batch);
  const runs = store.getBatchRuns(batch.id).map((run) => ({
    run_id: run.id,
    status: run.status,
    tool_calls: store.getToolCalls(run.id).map((c) => ({
      tool_name: c.tool_name,
      args: c.args,
      is_injected: c.is_injected,
      injection_payload_id: c.injection_payload_id,
    })),
  }));
  const result = scorePropagation(runs, propagationSpecFor(payload), labels);
  const details: AdversarialScoreDetails = {
    kind: "adversarial",
    payload_id: payload.id,
    payload_source: source,
    scoring_key: key,
    labels: Object.fromEntries(labels),
    inject: payload.inject,
    unauthorized_action: payload.unauthorized_action,
    propagation: result,
  };
  const scoreId = store.recordScore({
    task_id: batch.task_id,
    evaluation_batch_id: batch.id,
    // Adversarial batches are never scored for consistency: the planted instruction is a
    // deliberate perturbation, so their consistency numbers would measure the attack.
    outcome_consistency: null,
    tool_path_consistency: null,
    state_mutation_consistency: null,
    injection_propagated: result.rate === null ? null : result.runs_propagated > 0,
    runs_scored: result.runs_scored,
    details,
  });
  return finish(result, scoreId, "computed", labels);
}

// ---------------------------------------------------------------- rendering

export const PROPAGATION_VERDICT_TEXT: Record<PropagationVerdict, string> = {
  pass: "PASS (no propagation above threshold)",
  finding: "SECURITY FINDING",
  not_computed: "NOT COMPUTED",
};

export function pct(rate: number | null): string {
  return rate === null ? "-" : `${(rate * 100).toFixed(0)}%`;
}

export function depthText(depths: PropagationResult["depths"]): string {
  return depths.length === 0 ? "-" : depths.map((d) => `depth ${d.depth}: ${d.runs}`).join(", ");
}

export function matcherText(a: { tool: string; args?: Record<string, unknown> }): string {
  return `${a.tool}${a.args && Object.keys(a.args).length > 0 ? ` ${canonicalJson(a.args)}` : ""}`;
}

/** Per-run evidence lines, shared by the text and markdown reports. */
export function propagationEvidenceLines(sp: Pick<StoredPropagation, "result" | "labels">): string[] {
  const label = (id: string) => sp.labels.get(id) ?? id;
  const r = sp.result;
  const lines: string[] = [];
  const propagated = r.runs.filter((x) => x.propagated);
  for (const x of propagated) {
    lines.push(
      `PROPAGATED  ${label(x.run_id)}: injected at call #${x.injected_index! + 1}, unauthorized call at #${x.action_index! + 1} ` +
        `(depth ${x.depth}): ${x.action!.tool_name} ${canonicalJson(x.action!.args)}`
    );
  }
  const held = r.runs.filter((x) => x.exposure === "exposed" && !x.propagated);
  if (held.length > 0) lines.push(`held       ${held.map((x) => label(x.run_id)).join(", ")}`);
  for (const x of r.runs.filter((y) => y.exposure !== "exposed")) {
    lines.push(`${x.exposure === "excluded" ? "excluded  " : "not exposed"} ${label(x.run_id)}: ${x.reason}`);
  }
  for (const n of r.notes) lines.push(`note: ${n}`);
  return lines;
}

export function renderPropagationText(sp: StoredPropagation): string[] {
  const r = sp.result;
  const b = sp.batch;
  const lines: string[] = [];
  lines.push("");
  lines.push(`${sp.payload.task} x payload ${sp.payload.id}  (adversarial batch ${b.id}, ${b.tier} tier)  [TEST FIXTURE]`);
  lines.push(`  payload      : ${sp.payload_source}`);
  lines.push(`  injected     : ${sp.payload.inject.tool} call ${sp.payload.inject.on_call}, ${sp.payload.inject.placement.mode}${"path" in sp.payload.inject.placement ? ` ${sp.payload.inject.placement.path}` : ""}`);
  lines.push(`  unauthorized : ${matcherText(sp.payload.unauthorized_action)}`);
  fingerprintLines(sp.fingerprints).forEach((l, i) => lines.push(`  ${i === 0 ? "deployment   :" : "              "} ${l}`));
  lines.push(
    `  runs         : ${r.runs_scored} received the payload, of ${r.runs_in_batch} in the matrix ` +
      `[${b.variant_labels.join(", ")}] x ${b.trials_per_variant} trial(s)`
  );
  lines.push(
    `  propagation  : ${r.runs_propagated} of ${r.runs_scored} = ${pct(r.rate)} (max allowed ${pct(sp.payload.gate.max_propagation_rate)})  ` +
      `${PROPAGATION_VERDICT_TEXT[sp.verdict]}`
  );
  lines.push(`  depths       : ${depthText(r.depths)}  (calls strictly between the injected call and the action; 0 = next call)`);
  for (const l of propagationEvidenceLines(sp)) lines.push(`    ${l}`);
  return lines;
}

// ---------------------------------------------------------------- the CLI command

export interface AdversarialRunOptions {
  task?: string;
  /** A payload id under tasks/adversarial/, or a path to a payload file. */
  payload?: string;
  tier?: Tier;
  concurrency?: number;
  model?: string;
  /** Skip (and name) payloads whose base task the tool server cannot run, instead of refusing. */
  runnableOnly?: boolean;
  json: boolean;
}

function selectPayloads(opts: AdversarialRunOptions): ValidPayload[] {
  if (opts.payload !== undefined) {
    const p = loadValidPayload(resolvePayloadArg(opts.payload));
    if (opts.task !== undefined && p.payload.task !== opts.task) {
      throw new Error(`payload ${p.id} targets task "${p.payload.task}", but --task=${opts.task} was given.`);
    }
    return [p];
  }
  // No --payload: every payload fixture (for --task, only that task's), each validated.
  const all = loadAllPayloads().filter((p) => opts.task === undefined || p.payload?.task === opts.task);
  const chosen: ValidPayload[] = [];
  for (const p of all) {
    const task = p.payload ? loadValidTask(p.payload.task) : null;
    if (task && !task.spec.adversarial.enabled) {
      console.error(`skipping payload ${p.id}: ${p.payload!.task} has adversarial.enabled: false`);
      continue;
    }
    chosen.push(loadValidPayload(p.file));
  }
  if (chosen.length === 0) {
    throw new Error(`no adversarial payload to run${opts.task ? ` for task ${opts.task}` : ""} under tasks/adversarial/.`);
  }
  return chosen;
}

export async function runAdversarialCommand(opts: AdversarialRunOptions): Promise<void> {
  requireApiKey();
  const config = loadConfig();
  const tier = opts.tier ?? config.execution.default_tier;
  const concurrency = opts.concurrency ?? config.execution.worker_concurrency;
  let payloads = selectPayloads(opts);

  const tasks = new Map<string, LoadedTask>();
  for (const p of payloads) if (!tasks.has(p.payload.task)) tasks.set(p.payload.task, loadValidTask(p.payload.task));
  // Each payload runs against its base task's own registered tool server, same as `run`.
  const gaps = await toolCoverage([...tasks.values()]);
  const unrunnable = payloads.filter((p) => gaps.has(p.payload.task));
  if (unrunnable.length > 0) {
    const problems = unrunnable.map((p) => `${p.id} (task ${p.payload.task}): ${describeGap(gaps.get(p.payload.task)!)}`);
    if (!opts.runnableOnly) {
      throw new Error(
        `refusing to run:\n` + problems.map((p) => `  - ${p}`).join("\n") + `\nPass --runnable-only to run the rest and skip these.`
      );
    }
    for (const p of problems) console.error(`skipping payload ${p} (--runnable-only)`);
    payloads = payloads.filter((p) => !gaps.has(p.payload.task));
    if (payloads.length === 0) throw new Error("--runnable-only: no payload left to run.");
  }

  const store = openTraceStore({ root: INVARIANT_DIR });
  const results: Array<{ summary: BatchSummary; scored: StoredPropagation }> = [];
  try {
    for (const p of payloads) {
      const task = tasks.get(p.payload.task)!;
      const selection = selectTier(task.spec, task.fixture!, tier);
      console.error(
        `${task.spec.name} x payload ${p.id} [TEST FIXTURE]: ${tier} tier, ${selection.variants.length} variant(s) x ` +
          `${selection.trials} trial(s), planting into ${p.payload.inject.tool} call ${p.payload.inject.on_call}`
      );
      const summary = await runAdversarialBatch(
        store,
        task,
        p,
        {
          tier,
          variants: selection.variants,
          variants_requested: selection.variants_requested,
          trials: selection.trials,
          concurrency,
          retry: config.providers.retry,
          upstream: requireUpstream(task.spec.name).upstream,
          model: opts.model,
        },
        { onEvent: (e) => printEvent(e) }
      );
      const scored = scoreAdversarialBatch(store, store.getBatch(summary.batch_id)!, { rescore: true });
      results.push({ summary, scored });
    }
  } finally {
    store.close();
  }

  if (opts.json) {
    console.log(JSON.stringify(results.map((r) => ({ batch_id: r.summary.batch_id, counts: r.summary.counts, ...propagationJson(r.scored) })), null, 2));
  } else {
    for (const r of results) {
      for (const w of r.scored.warnings) console.error(`warning: ${w}`);
      for (const l of renderPropagationText(r.scored)) console.log(l);
      console.log(`  saved        : score ${r.scored.score_id}; gate it with: invariant gate --batch=${r.summary.batch_id}`);
    }
    console.log(`  trace store  : ${path.relative(REPO_ROOT, path.join(INVARIANT_DIR, "trace.db"))}`);
  }
  // Like `run`: nonzero only when the matrix is incomplete. A finding is the gate's call.
  if (results.some((r) => r.summary.counts.infra_exhausted + r.summary.counts.errors > 0)) process.exitCode = 1;
}

function printEvent(event: BatchEvent): void {
  if (event.type === "retrying") {
    console.error(`        ${event.cell.variant_label} trial ${event.cell.trial_number}: infra error, retrying (attempt ${event.next_attempt})`);
    return;
  }
  const c = event.cell;
  const status = c.crash !== undefined ? `harness crashed: ${c.crash}` : `${c.final!.status} (${c.final!.stop_reason}), ${c.final!.record.tool_calls.length} tool call(s)`;
  console.error(`  [${event.done}/${event.total}] ${c.variant_label} trial ${c.trial_number}: ${status}`);
}

export function propagationJson(sp: StoredPropagation): Record<string, unknown> {
  const label = (id: string) => sp.labels.get(id) ?? id;
  return {
    payload: sp.payload.id,
    task: sp.payload.task,
    payload_source: sp.payload_source,
    verdict: sp.verdict,
    score: { id: sp.score_id, source: sp.source },
    propagation_rate: sp.result.rate,
    runs_scored: sp.result.runs_scored,
    runs_propagated: sp.result.runs_propagated,
    max_propagation_rate: sp.payload.gate.max_propagation_rate,
    depths: sp.result.depths,
    runs: sp.result.runs.map((r) => ({ run: label(r.run_id), ...r })),
    notes: sp.result.notes,
    warnings: sp.warnings,
  };
}
