import { createHash } from "node:crypto";
import path from "node:path";
import { openTraceStore, type BatchRow, type TraceStore } from "@invariant/trace-store";
import {
  canonicalJson,
  createAnthropicJudge,
  DEFAULT_JUDGE_MODEL,
  scoreBatch,
  unavailableJudge,
  type BatchRunInput,
  type BatchScore,
  type EmbedFn,
  type JudgeFn,
  type ScoringTask,
  type Verdict,
} from "@invariant/scoring";
import { loadConfig } from "../lib/config.js";
import { loadValidTask, type LoadedTask } from "../lib/load-tasks.js";
import { INVARIANT_DIR, REPO_ROOT } from "../lib/paths.js";
import { batchFingerprints, fingerprintLines, mixedFingerprintWarning, type BatchFingerprintSummary } from "../lib/fingerprints.js";
import type { InvariantConfig } from "../schema/config.js";

export interface ScoreOptions {
  /** Score this batch. */
  batch?: string;
  /** Or: score this task's most recent finished batch. */
  task?: string;
  json: boolean;
}

export interface ScoreDeps {
  /** Trace store directory; defaults to <repo>/.invariant. */
  storeRoot?: string;
  config?: InvariantConfig;
  /** Overrides the judge built from ANTHROPIC_API_KEY. Test seam, like TrialDeps.callModel. */
  judge?: JudgeFn;
  /** Embedding pre-filter. Nothing in the CLI sets it yet: see OutcomeOptions.embed. */
  embed?: EmbedFn;
  /** Where the report goes; defaults to stdout. */
  out?: (line: string) => void;
  err?: (line: string) => void;
}

export interface JudgeSettings {
  model: string;
  temperature: number;
  votes: number;
  /** False when no ANTHROPIC_API_KEY was set (and no judge was injected). */
  available: boolean;
  injected: boolean;
}

export interface StoredScore {
  batch: BatchRow;
  score: BatchScore;
  score_id: string;
  labels: Map<string, string>;
  judge: JudgeSettings;
  /** Deployment fingerprints across the batch's run matrix. */
  fingerprints: BatchFingerprintSummary;
  warnings: string[];
}

export function scoringTask(task: LoadedTask): ScoringTask {
  return {
    name: task.spec.name,
    success_rubric: task.spec.success_rubric,
    dangerous_tools: task.spec.tools.dangerous.map((d) => d.name),
    volatile_fields: task.spec.volatile_fields,
    thresholds: task.spec.thresholds,
  };
}

/**
 * The spec used for scoring is tasks/<name>.yaml as it is now (the reviewed source of
 * truth, and where thresholds are set). The store keeps a copy from the last time the task
 * ran; if the parts that change what gets scored differ, say so rather than silently
 * scoring an old batch against new rules.
 */
export function specDrift(store: TraceStore, taskId: string, task: LoadedTask): string[] {
  const row = store.getTask(taskId);
  if (!row) return [];
  const changed: string[] = [];
  if (row.success_rubric !== task.spec.success_rubric) changed.push("success_rubric");
  if (canonicalJson(row.dangerous_tools) !== canonicalJson(task.spec.tools.dangerous)) changed.push("tools.dangerous");
  if (canonicalJson(row.volatile_fields) !== canonicalJson(task.spec.volatile_fields)) changed.push("volatile_fields");
  if (canonicalJson(row.thresholds) !== canonicalJson(task.spec.thresholds)) changed.push("thresholds");
  if (changed.length === 0) return [];
  return [
    `tasks/${task.spec.name}.yaml differs from the copy recorded when this task last ran ` +
      `(${changed.join(", ")}); scoring uses tasks/${task.spec.name}.yaml as it is now.`,
  ];
}

/** Resolve which batch to score and the task spec it is scored against. */
export function resolveBatch(store: TraceStore, opts: Pick<ScoreOptions, "batch" | "task">): { batch: BatchRow; task: LoadedTask } {
  if ((opts.batch === undefined) === (opts.task === undefined)) {
    throw new Error("pass exactly one of --batch=<batch_id> or --task=<name> (scores that task's most recent finished batch).");
  }
  if (opts.batch !== undefined) {
    const batch = store.getBatch(opts.batch);
    if (!batch) throw new Error(`no batch with id ${opts.batch} in the trace store.`);
    if (batch.finished_at === null) {
      throw new Error(
        `batch ${batch.id} has not finished (no finished_at): it is still running, or its process died ` +
          `mid-batch, so its run matrix may be partial. Refusing to score a partial matrix.`
      );
    }
    const row = store.getTask(batch.task_id);
    if (!row) throw new Error(`batch ${batch.id} references task ${batch.task_id}, which is not in the store.`);
    return { batch, task: loadValidTask(row.name) };
  }
  const task = loadValidTask(opts.task!);
  const row = store.getTaskByName(task.spec.name);
  const batch = row ? store.getLatestBatch(row.id, { finishedOnly: true }) : null;
  if (!batch) {
    throw new Error(`no finished batch for task "${task.spec.name}" in the trace store. Run one first: invariant run --task=${task.spec.name} --tier=smoke`);
  }
  return { batch, task };
}

export function buildJudge(config: InvariantConfig, deps: ScoreDeps): { judge: JudgeFn; settings: JudgeSettings } {
  const settings = {
    model: config.judge.model ?? DEFAULT_JUDGE_MODEL,
    temperature: config.judge.temperature,
    votes: config.judge.votes,
  };
  if (deps.judge) return { judge: deps.judge, settings: { ...settings, available: true, injected: true } };
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    // Not an error yet: if every answer in the batch is identical, no pair needs a judge.
    return { judge: unavailableJudge(), settings: { ...settings, available: false, injected: false } };
  }
  return {
    judge: createAnthropicJudge({ apiKey, ...settings, retry: config.providers.retry }),
    settings: { ...settings, available: true, injected: false },
  };
}

/**
 * A hash of everything besides the run matrix that changes the scores (not the verdicts):
 * the rubric, dangerous tools and volatile fields from the task spec, and the judge
 * settings. Thresholds are left out on purpose; they only change verdicts, and the gate
 * re-applies the current thresholds to a stored score. Stored with every score so the
 * gate can reuse a score only when it would compute the same numbers again.
 */
export function scoringKey(task: LoadedTask, judge: JudgeSettings, config: InvariantConfig, deps: Pick<ScoreDeps, "embed">): string {
  const inputs = {
    success_rubric: task.spec.success_rubric,
    dangerous_tools: task.spec.tools.dangerous.map((d) => d.name),
    volatile_fields: task.spec.volatile_fields,
    judge: { model: judge.model, temperature: judge.temperature, votes: judge.votes, injected: judge.injected },
    prefilter: deps.embed
      ? { high: config.judge.embedding_prefilter_threshold_high, low: config.judge.embedding_prefilter_threshold_low }
      : null,
  };
  return createHash("sha256").update(canonicalJson(inputs)).digest("hex");
}

/** Load a batch's matrix from the store, score it, and persist the scores. */
export async function scoreStoredBatch(
  store: TraceStore,
  batch: BatchRow,
  task: LoadedTask,
  config: InvariantConfig,
  deps: ScoreDeps = {}
): Promise<StoredScore> {
  const labels = new Map<string, string>();
  const runs: BatchRunInput[] = store.getBatchRuns(batch.id).map((run) => {
    const variant = store.getVariant(run.variant_id);
    labels.set(run.id, `${variant?.label ?? "?"} trial ${run.trial_number}`);
    return {
      run_id: run.id,
      status: run.status,
      final_output: run.final_output,
      tool_calls: store.getToolCalls(run.id).map((c) => ({ tool_name: c.tool_name, args: c.args })),
    };
  });

  const { judge, settings } = buildJudge(config, deps);
  const score = await scoreBatch(runs, scoringTask(task), {
    judge,
    embed: deps.embed,
    prefilter: {
      high: config.judge.embedding_prefilter_threshold_high,
      low: config.judge.embedding_prefilter_threshold_low,
    },
  });

  const scoreId = store.recordScore({
    task_id: batch.task_id,
    evaluation_batch_id: batch.id,
    outcome_consistency: score.outcome.score,
    tool_path_consistency: score.tool_path.score,
    state_mutation_consistency: score.state_mutation.score,
    runs_scored: score.runs_scored,
    details: {
      spec_source: `tasks/${task.spec.name}.yaml`,
      scoring_key: scoringKey(task, settings, config, deps),
      judge: { model: settings.model, temperature: settings.temperature, votes: settings.votes, injected: settings.injected },
      labels: Object.fromEntries(labels),
      ...score,
    },
  });

  const fingerprints = batchFingerprints(store, batch.id);
  const warnings = specDrift(store, batch.task_id, task);
  const mixed = mixedFingerprintWarning(batch.id, fingerprints);
  if (mixed) warnings.push(mixed);
  return { batch, score, score_id: scoreId, labels, judge: settings, fingerprints, warnings };
}

export async function runScore(opts: ScoreOptions, deps: ScoreDeps = {}): Promise<void> {
  const out = deps.out ?? ((line: string) => console.log(line));
  const err = deps.err ?? ((line: string) => console.error(line));
  const config = deps.config ?? loadConfig();
  const store = openTraceStore({ root: deps.storeRoot ?? INVARIANT_DIR });
  let stored: StoredScore;
  try {
    const { batch, task } = resolveBatch(store, opts);
    stored = await scoreStoredBatch(store, batch, task, config, deps);
  } finally {
    store.close();
  }
  for (const w of stored.warnings) err(`warning: ${w}`);

  if (opts.json) {
    out(JSON.stringify(scoreJson(stored), null, 2));
  } else {
    for (const line of renderReport(stored)) out(line);
    out(`  saved        : score ${stored.score_id} in ${path.relative(REPO_ROOT, path.join(deps.storeRoot ?? INVARIANT_DIR, "trace.db"))}`);
  }

  // Nonzero only when scoring itself is incomplete (an axis has no score). A score below
  // its threshold is a finding, not a failure of this command; turning that into an exit
  // code is `invariant gate`'s job.
  const s = stored.score;
  if ([s.state_mutation, s.tool_path, s.outcome].some((axis) => axis.score === null)) {
    process.exitCode = 1;
  }
}

function fmt(score: number | null): string {
  return score === null ? "-" : score.toFixed(3);
}

function verdictText(v: Verdict, error?: string): string {
  if (error !== undefined) return "NOT COMPUTED";
  return v === "pass" ? "pass" : v === "fail" ? "FAIL" : "n/a";
}

function truncate(text: string, max = 90): string {
  const flat = text.replace(/\s+/g, " ");
  return flat.length <= max ? flat : flat.slice(0, max - 1) + "…";
}

export function renderReport(stored: StoredScore): string[] {
  const { batch, score: s, labels } = stored;
  const name = (ids: string[]) => ids.map((id) => labels.get(id) ?? id).join(", ");
  const lines: string[] = [];

  lines.push("");
  lines.push(`${s.task}  (batch ${batch.id}, ${batch.tier} tier)`);
  lines.push(
    `  runs         : ${s.runs_scored} scored of ${s.runs_in_batch} in the matrix ` +
      `[${batch.variant_labels.join(", ")}] x ${batch.trials_per_variant} trial(s)`
  );
  const fpLines = fingerprintLines(stored.fingerprints);
  fpLines.forEach((l, i) => lines.push(`  ${i === 0 ? "deployment   :" : "              "} ${l}`));
  if (stored.fingerprints.mixed) lines.push(`                 WARNING: more than one deployment fingerprint in this batch (see warning above)`);
  if (s.excluded.length > 0) {
    lines.push(`  excluded     : ${s.excluded.length} run(s) with no behavioural answer, not counted on any axis`);
    for (const e of s.excluded) lines.push(`                 ${labels.get(e.run_id) ?? e.run_id}: ${e.status}`);
  }
  lines.push("");
  lines.push("  axis              score   threshold   result");
  const row = (label: string, axis: BatchScore["state_mutation"] | BatchScore["tool_path"] | BatchScore["outcome"]) =>
    `  ${label.padEnd(16)}  ${fmt(axis.score).padStart(5)}   >= ${axis.threshold.toFixed(3)}    ${verdictText(axis.verdict, axis.error)}`;
  lines.push(row("state-mutation", s.state_mutation));
  lines.push(row("tool-path", s.tool_path));
  lines.push(row("outcome", s.outcome));

  const sm = s.state_mutation.result!;
  lines.push("");
  lines.push(
    `  state-mutation: ${sm.groups.length} distinct mutation signature(s); ` +
      `largest group ${sm.groups[0]?.run_ids.length ?? 0} of ${sm.runs_scored}`
  );
  for (const g of sm.groups) {
    const sig =
      g.signature.length === 0 ? "(no dangerous calls)" : g.signature.map((c) => `${c.tool_name} ${canonicalJson(c.args)}`).join(" ; ");
    lines.push(`    ${String(g.run_ids.length).padStart(3)} run(s)  ${sig}`);
    lines.push(`                [${name(g.run_ids)}]`);
  }
  for (const n of sm.notes) lines.push(`    note: ${n}`);

  const tp = s.tool_path.result!;
  lines.push("");
  lines.push(
    `  tool-path: ${tp.distinct_paths.length} distinct path(s) over ${tp.pairs} pair(s)` +
      (tp.min_pair ? `; least similar pair ${tp.min_pair.similarity.toFixed(3)} (${name([tp.min_pair.a])} vs ${name([tp.min_pair.b])})` : "")
  );
  for (const p of tp.distinct_paths) {
    lines.push(`    ${String(p.run_ids.length).padStart(3)} run(s)  ${p.path.length === 0 ? "(no tool calls)" : p.path.join(" > ")}`);
  }
  for (const n of tp.notes) lines.push(`    note: ${n}`);

  lines.push("");
  if (s.outcome.error !== undefined) {
    lines.push(`  outcome: not computed.`);
    lines.push(`    ${s.outcome.error}`);
  } else {
    const oc = s.outcome.result!;
    const judge = stored.judge;
    lines.push(
      `  outcome: ${oc.clusters.length} cluster(s) from ${oc.nodes.length} distinct answer(s); ` +
        `${oc.judged_pairs} pair(s) judged` +
        (oc.judged_pairs > 0
          ? ` by ${judge.injected ? "an injected judge" : judge.model} (temperature ${judge.temperature}, majority of ${judge.votes})`
          : "") +
        `; embedding pre-filter ${oc.prefilter === "embedding" ? "on" : "off"}`
    );
    oc.clusters.forEach((c, i) => {
      const sample = oc.nodes[c.nodes[0]!]!.text;
      lines.push(`    cluster ${i + 1}: ${c.run_ids.length} run(s)  ${sample === null ? "(timed out)" : `"${truncate(sample)}"`}`);
      lines.push(`                [${name(c.run_ids)}]`);
    });
    for (const n of oc.notes) lines.push(`    note: ${n}`);
  }
  lines.push("");
  lines.push(
    "  Pass/fail is per axis against tasks/" + s.task + ".yaml thresholds. Informational: `invariant gate` turns it into an exit code."
  );
  return lines;
}

function scoreJson(stored: StoredScore): unknown {
  return {
    batch_id: stored.batch.id,
    score_id: stored.score_id,
    tier: stored.batch.tier,
    judge: stored.judge,
    labels: Object.fromEntries(stored.labels),
    deployment_fingerprints: stored.fingerprints,
    warnings: stored.warnings,
    ...stored.score,
  };
}
