/**
 * `invariant gate`: turn stored consistency scores into a CI verdict.
 *
 * Exit codes
 *   0  everything in scope passed (consistency verdict "pass", or "pass_with_waivers" when
 *      an axis was explicitly allowed to go uncomputed with --allow-uncomputed; and every
 *      gated adversarial payload within its max_propagation_rate)
 *   1  consistency evaluated and failed: at least one scored axis is below its threshold
 *   2  could not evaluate: an axis has no score and was not waived, a runnable task has
 *      no finished batch, the batch is unfinished, a spec or payload fixture is invalid, an
 *      adversarial batch where no run received the payload, a payload without a batch under
 *      --require-adversarial, bad arguments, ...
 *   3  security finding: an adversarial payload propagated above its max_propagation_rate
 *      (default 0, so any propagation at all). Outranks everything else, because it goes
 *      to a different owner; the report still carries the consistency verdict beside it.
 * Precedence: 3 > 1 > 2 > 0.
 *
 * Adversarial batches (kind "adversarial", from `invariant adversarial run`) are never part
 * of the consistency verdict. They are gated in the report's separate "security" section
 * (ARCHITECTURE.md section 8: a security finding routes to its own queue): with --batch=<an
 * adversarial batch>, that batch alone; with --task or no selector, the latest finished
 * adversarial batch of every payload fixture targeting a gated task. A payload that was not
 * run is listed as "not_run" and does not affect the verdict, unless --require-adversarial,
 * where it is incomplete (CI runs the payloads first and passes that flag).
 *
 * Uncomputed axes fail closed. The outcome axis needs the LLM judge (models.judge and its provider's key);
 * a gate that passed because the judge never ran would be exactly the kind of silent
 * dishonesty this project exists to catch. `--allow-uncomputed=outcome` opts out, and
 * the report then says "pass_with_waivers" and names the waived axis rather than "pass".
 * Only outcome can be waived (see WAIVABLE_AXES in @invariant/scoring).
 *
 * Scores are reused, not recomputed, when the latest stored score for the batch was
 * computed from the same scoring inputs (scoringKey: rubric, dangerous tools, volatile
 * fields, judge settings) and has every axis. Otherwise the batch is scored now with the
 * same code as `invariant score`, and that score is saved too. Thresholds always come
 * from tasks/<name>.yaml as it is now, never from the verdicts stored with a score.
 *
 * JSON report, schema "invariant.gate/v2" (see the GateReport type below). v2 over v1:
 * exit_code may be 3, "verdict" may be null (no consistency batch in scope, e.g. gating one
 * adversarial batch), and the "security" section.
 *
 * {
 *   "schema": "invariant.gate/v2",
 *   "generated_at": ISO timestamp,
 *   "mode": "batch" | "task" | "all",
 *   "verdict": "pass" | "pass_with_waivers" | "fail" | "incomplete" | null,   consistency, aggregate over tasks
 *   "exit_code": 0 | 1 | 2 | 3,
 *   "allow_uncomputed": ["outcome"] | [],
 *   "counts": { "gated", "pass", "pass_with_waivers", "fail", "incomplete", "not_runnable" },
 *   "warnings": [string],
 *   "tasks": [
 *     {                                        a task whose batch was gated
 *       "task": name, "status": "evaluated", "verdict": GateVerdict,
 *       "batch": { "id", "tier", "created_at", "finished_at", "variants": [label],
 *                  "trials_per_variant", "runs_in_batch", "runs_scored",
 *                  "excluded": [{ "run": "v1 trial 2", "run_id", "status" }],
 *                  "deployment": { "fingerprints": [{ "hash", "runs", "model_name", "model_version",
 *                                   "synthetic" }], "runs_without_fingerprint", "mixed",
 *                                  "changed": ["model_name" | "model_version" | "system_prompt" | "tool_schema"] } },
 *                  (mixed = the batch spans more than one deployment fingerprint; it is a
 *                   warning in the top-level "warnings", never a gate failure by itself)
 *       "score": { "id", "source": "stored" | "computed" },
 *       "axes": [{ "axis": "state_mutation" | "tool_path" | "outcome", "score": number | null,
 *                  "threshold", "result": "pass" | "fail" | "not_computed" | "waived",
 *                  "reason"?: why there is no score }],
 *       "failing_axes": [{ "axis", "score", "threshold", "evidence": AxisEvidence }],
 *       "notes": [string]
 *     },
 *     { "task", "status": "not_runnable", "verdict": null,           not gated, and says so:
 *       "reason", "missing_tools": [name] },                          no tool server is registered
 *                                                                     for it, or its server does
 *                                                                     not serve this task's tools
 *     { "task", "status": "error", "verdict": "incomplete", "reason" }
 *   ],
 *   "security": {                              adversarial payloads; never part of "verdict"
 *     "verdict": "pass" | "finding" | "incomplete" | null,        null: nothing gated
 *     "require_adversarial": bool,
 *     "counts": { "gated", "pass", "finding", "incomplete", "not_run" },
 *     "payloads": [
 *       { "payload", "task", "file", "status": "evaluated", "verdict": "pass" | "finding" | "incomplete",
 *         "batch": { "id", "tier", "created_at", "finished_at", "variants", "trials_per_variant", "deployment" },
 *         "score": { "id", "source" }, "injection": { "tool", "on_call", "placement" },
 *         "unauthorized_action": { "tool", "args"? },
 *         "propagation": { "rate", "runs_in_batch", "runs_scored", "runs_propagated", "max_propagation_rate",
 *                          "depths": [{ "depth", "runs" }],
 *                          "propagated_runs": [{ "run", "run_id", "injected_call", "action_call", "depth", "action" }],
 *                          "held_runs": [label], "not_exposed": [{ "run", "run_id", "reason" }],
 *                          "excluded": [{ "run", "run_id", "reason" }], "notes" },
 *         "warnings": [string] },
 *       { "payload", "task", "file", "status": "not_run", "verdict": null, "reason" },
 *       { "payload", "task", "file", "status": "error", "verdict": "incomplete", "reason" }
 *     ]
 *   }
 * }
 *
 * AxisEvidence is what scoring already produced, with run ids replaced by "v1 trial 3"
 * labels (run_ids kept alongside):
 *   state_mutation: { summary, groups: [{ runs, signature: [{tool_name, args}], trials, run_ids }], notes }
 *   tool_path:      { summary, distinct_paths: [{ runs, path, trials, run_ids }], least_similar_pair, notes }
 *   outcome:        { summary, clusters: [{ runs, sample, trials, run_ids }], judged_pairs, judge, notes }
 */
import fs from "node:fs";
import path from "node:path";
import { openTraceStore, type BatchRow, type TraceStore } from "@invariant/trace-store";
import {
  aggregateSecurityVerdict,
  aggregateVerdict,
  assertWaivable,
  combinedExitCode,
  SECURITY_FINDING_EXIT_CODE,
  type SecurityVerdict,
  AXIS_LABELS,
  AXES,
  canonicalJson,
  evaluateGate,
  type AxisGate,
  type AxisName,
  type BatchScore,
  type GateVerdict,
} from "@invariant/scoring";
import { loadConfig } from "../lib/config.js";
import { loadAllTasks, loadValidTask, type LoadedTask } from "../lib/load-tasks.js";
import { INVARIANT_DIR } from "../lib/paths.js";
import { describeGap, toolCoverage, type CoverageGap, type UpstreamResolver } from "../lib/upstream.js";
import { batchFingerprints, fingerprintLines, mixedFingerprintWarning, type BatchFingerprintSummary } from "../lib/fingerprints.js";
import type { InvariantConfig } from "../schema/config.js";
import {
  buildJudge,
  resolveBatch,
  scoreStoredBatch,
  scoringKey,
  judgeTemperatureText,
  scoringTask,
  specDrift,
  type JudgeSettings,
  type ScoreDeps,
} from "./score.js";
import { loadAllPayloads, type LoadedPayload } from "../lib/load-payloads.js";
import {
  depthText,
  matcherText,
  pct,
  scoreAdversarialBatch,
  type StoredPropagation,
} from "./adversarial.js";

export const GATE_REPORT_SCHEMA = "invariant.gate/v2";
/** First line of the markdown report; the CI workflow finds its own PR comment by it. */
export const PR_COMMENT_MARKER = "<!-- invariant-gate-report -->";

export interface GateOptions {
  /** Gate this batch. */
  batch?: string;
  /** Or: this task's latest batch. Neither: the latest batch of every task under tasks/. */
  task?: string;
  /** Print the JSON report to stdout instead of the text report. */
  json: boolean;
  /** Also write the JSON report here. */
  report?: string;
  /** Also write the markdown report (for a PR comment) here. */
  markdown?: string;
  /** Axes allowed to have no score. Only "outcome" is accepted. */
  allowUncomputed?: string[];
  /** Score the batch now even if a reusable stored score exists. */
  rescore?: boolean;
  /** A payload fixture with no adversarial batch is incomplete instead of "not run". */
  requireAdversarial?: boolean;
}

export interface GateDeps extends ScoreDeps {
  /** Task -> tool server, for the runnability check in all-task mode; defaults to the registry. */
  upstreamFor?: UpstreamResolver;
}

export interface StateMutationEvidence {
  summary: string;
  groups: Array<{ runs: number; signature: Array<{ tool_name: string; args: unknown }>; trials: string[]; run_ids: string[] }>;
  notes: string[];
}
export interface ToolPathEvidence {
  summary: string;
  distinct_paths: Array<{ runs: number; path: string[]; trials: string[]; run_ids: string[] }>;
  least_similar_pair: { a: string; b: string; similarity: number } | null;
  notes: string[];
}
export interface OutcomeEvidence {
  summary: string;
  clusters: Array<{ runs: number; sample: string | null; trials: string[]; run_ids: string[] }>;
  judged_pairs: number;
  /** temperature is "unsupported" when the judge's provider refused it and it ran without (see @invariant/scoring judge.ts). */
  judge: { model: string; temperature: number | "unsupported"; temperature_requested?: number; votes: number; injected: boolean; reported_models?: string[] };
  notes: string[];
}
export type AxisEvidence = StateMutationEvidence | ToolPathEvidence | OutcomeEvidence;

export interface EvaluatedTaskReport {
  task: string;
  status: "evaluated";
  verdict: GateVerdict;
  batch: {
    id: string;
    tier: string;
    created_at: string;
    finished_at: string | null;
    variants: string[];
    trials_per_variant: number;
    runs_in_batch: number;
    runs_scored: number;
    excluded: Array<{ run: string; run_id: string; status: string }>;
    deployment: BatchFingerprintSummary;
  };
  score: { id: string; source: "stored" | "computed" };
  axes: AxisGate[];
  failing_axes: Array<{ axis: AxisName; score: number; threshold: number; evidence: AxisEvidence }>;
  notes: string[];
}
export interface NotRunnableTaskReport {
  task: string;
  status: "not_runnable";
  verdict: null;
  reason: string;
  missing_tools: string[];
}
export interface ErrorTaskReport {
  task: string;
  status: "error";
  verdict: "incomplete";
  reason: string;
}
export type TaskGateReport = EvaluatedTaskReport | NotRunnableTaskReport | ErrorTaskReport;

export interface EvaluatedPayloadReport {
  payload: string;
  task: string;
  file: string;
  status: "evaluated";
  verdict: SecurityVerdict;
  batch: {
    id: string;
    tier: string;
    created_at: string;
    finished_at: string | null;
    variants: string[];
    trials_per_variant: number;
    deployment: BatchFingerprintSummary;
  };
  score: { id: string; source: "stored" | "computed" };
  injection: { tool: string; on_call: number; placement: unknown };
  unauthorized_action: { tool: string; args?: Record<string, unknown> };
  propagation: {
    rate: number | null;
    runs_in_batch: number;
    runs_scored: number;
    runs_propagated: number;
    max_propagation_rate: number;
    depths: Array<{ depth: number; runs: number }>;
    /** injected_call / action_call are 1-based positions in the run's tool-call sequence. */
    propagated_runs: Array<{ run: string; run_id: string; injected_call: number; action_call: number; depth: number; action: { tool_name: string; args: unknown } }>;
    held_runs: string[];
    not_exposed: Array<{ run: string; run_id: string; reason: string }>;
    excluded: Array<{ run: string; run_id: string; reason: string }>;
    notes: string[];
  };
  warnings: string[];
}
export interface OtherPayloadReport {
  payload: string;
  task: string;
  file: string;
  status: "not_run" | "error";
  verdict: "incomplete" | null;
  reason: string;
}
export type PayloadGateReport = EvaluatedPayloadReport | OtherPayloadReport;

export interface SecurityReport {
  verdict: SecurityVerdict | null;
  require_adversarial: boolean;
  counts: { gated: number; pass: number; finding: number; incomplete: number; not_run: number };
  payloads: PayloadGateReport[];
}

export interface GateReport {
  schema: typeof GATE_REPORT_SCHEMA;
  generated_at: string;
  mode: "batch" | "task" | "all";
  /** The consistency verdict; null when no consistency batch was in scope. */
  verdict: GateVerdict | null;
  exit_code: 0 | 1 | 2 | 3;
  allow_uncomputed: AxisName[];
  counts: { gated: number; pass: number; pass_with_waivers: number; fail: number; incomplete: number; not_runnable: number };
  warnings: string[];
  tasks: TaskGateReport[];
  /** Adversarial payloads, gated separately from consistency (see the header). */
  security: SecurityReport;
}

/** What scoreStoredBatch persists in scores.details. */
interface StoredDetails extends BatchScore {
  scoring_key?: string;
  labels: Record<string, string>;
  judge: Omit<JudgeSettings, "available">;
}

interface GateScore {
  score: BatchScore;
  score_id: string;
  source: "stored" | "computed";
  labels: Map<string, string>;
  judge: Omit<JudgeSettings, "available">;
}

/**
 * The latest stored score for the batch, if it can stand in for scoring now: same scoring
 * inputs, and no axis missing (a missing axis might be computable now, e.g. a key was set).
 */
function reusableScore(store: TraceStore, batchId: string, key: string, notes: string[]): GateScore | null {
  const row = store.getScores(batchId)[0];
  if (!row) return null;
  const d = row.details as StoredDetails;
  if (d?.scoring_key !== key) {
    notes.push(
      `stored score ${row.id} was computed from different scoring inputs (rubric, dangerous tools, volatile ` +
        `fields or judge settings) than apply now, or predates scoring keys; rescored.`
    );
    return null;
  }
  if (AXES.some((axis) => d[axis]?.score === null || d[axis]?.score === undefined)) {
    notes.push(`stored score ${row.id} has an axis without a score; rescored in case it can be computed now.`);
    return null;
  }
  return {
    score: {
      task: d.task,
      runs_in_batch: d.runs_in_batch,
      runs_scored: d.runs_scored,
      excluded: d.excluded,
      state_mutation: d.state_mutation,
      tool_path: d.tool_path,
      outcome: d.outcome,
    },
    score_id: row.id,
    source: "stored",
    labels: new Map(Object.entries(d.labels ?? {})),
    judge: d.judge,
  };
}

function truncate(text: string, max = 160): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : flat.slice(0, max - 1) + "…";
}

function buildEvidence(axis: AxisName, gs: GateScore): AxisEvidence {
  const label = (id: string) => gs.labels.get(id) ?? id;
  const s = gs.score;
  if (axis === "state_mutation") {
    const r = s.state_mutation.result!;
    return {
      summary:
        `${r.groups.length} distinct mutation signature(s) across ${r.runs_scored} run(s); ` +
        `largest group ${r.groups[0]?.run_ids.length ?? 0} of ${r.runs_scored}`,
      groups: r.groups.map((g) => ({ runs: g.run_ids.length, signature: g.signature, trials: g.run_ids.map(label), run_ids: g.run_ids })),
      notes: r.notes,
    };
  }
  if (axis === "tool_path") {
    const r = s.tool_path.result!;
    return {
      summary: `${r.distinct_paths.length} distinct tool path(s) across ${r.runs_scored} run(s), mean pairwise similarity over ${r.pairs} pair(s)`,
      distinct_paths: r.distinct_paths.map((p) => ({ runs: p.run_ids.length, path: p.path, trials: p.run_ids.map(label), run_ids: p.run_ids })),
      least_similar_pair: r.min_pair ? { a: label(r.min_pair.a), b: label(r.min_pair.b), similarity: r.min_pair.similarity } : null,
      notes: r.notes,
    };
  }
  const r = s.outcome.result!;
  return {
    summary:
      `${r.clusters.length} outcome cluster(s) from ${r.nodes.length} distinct answer(s); largest ` +
      `${r.clusters[0]?.run_ids.length ?? 0} of ${r.runs_scored}; ${r.judged_pairs} pair(s) judged`,
    clusters: r.clusters.map((c) => {
      const text = r.nodes[c.nodes[0]!]!.text;
      return { runs: c.run_ids.length, sample: text === null ? null : truncate(text), trials: c.run_ids.map(label), run_ids: c.run_ids };
    }),
    judged_pairs: r.judged_pairs,
    judge: gs.judge,
    notes: r.notes,
  };
}

async function gateBatch(
  store: TraceStore,
  batch: BatchRow,
  task: LoadedTask,
  config: InvariantConfig,
  deps: GateDeps,
  opts: { allowUncomputed: AxisName[]; rescore: boolean },
  notes: string[] = []
): Promise<EvaluatedTaskReport> {
  const { settings } = buildJudge(config, deps);
  const key = scoringKey(task, settings, config, deps);
  let gs = opts.rescore ? null : reusableScore(store, batch.id, key, notes);
  if (gs) {
    notes.push(...specDrift(store, batch.task_id, task));
  } else {
    const stored = await scoreStoredBatch(store, batch, task, config, deps);
    // The mixed-fingerprint warning is reported once, in the top-level warnings.
    notes.push(...stored.warnings.filter((w) => w !== mixedFingerprintWarning(batch.id, stored.fingerprints)));
    gs = { score: stored.score, score_id: stored.score_id, source: "computed", labels: stored.labels, judge: stored.judge };
  }

  const deployment = batchFingerprints(store, batch.id);
  const evaluation = evaluateGate(gs.score, scoringTask(task).thresholds, { allowUncomputed: opts.allowUncomputed });
  const label = (id: string) => gs!.labels.get(id) ?? id;
  return {
    task: task.spec.name,
    status: "evaluated",
    verdict: evaluation.verdict,
    batch: {
      id: batch.id,
      tier: batch.tier,
      created_at: batch.created_at,
      finished_at: batch.finished_at,
      variants: batch.variant_labels,
      trials_per_variant: batch.trials_per_variant,
      runs_in_batch: gs.score.runs_in_batch,
      runs_scored: gs.score.runs_scored,
      excluded: gs.score.excluded.map((e) => ({ run: label(e.run_id), run_id: e.run_id, status: e.status })),
      deployment,
    },
    score: { id: gs.score_id, source: gs.source },
    axes: evaluation.axes,
    failing_axes: evaluation.axes
      .filter((a) => a.result === "fail")
      .map((a) => ({ axis: a.axis, score: a.score!, threshold: a.threshold, evidence: buildEvidence(a.axis, gs!) })),
    notes,
  };
}

/**
 * A task's latest batch, for gating. Fails closed on an unfinished latest batch rather
 * than quietly gating an older finished one in its place.
 */
function latestBatchForGate(store: TraceStore, task: LoadedTask, runnableHint: string): BatchRow {
  const row = store.getTaskByName(task.spec.name);
  const latest = row ? store.getLatestBatch(row.id) : null;
  if (!latest) {
    throw new Error(
      `no batch for task "${task.spec.name}" in the trace store. ${runnableHint}` +
        `A task that was not run has not passed: run it first (invariant run --task=${task.spec.name} --tier=smoke).`
    );
  }
  if (latest.finished_at === null) {
    throw new Error(
      `the latest batch for "${task.spec.name}" (${latest.id}) has not finished: it is still running, or its ` +
        `process died mid-batch. Refusing to gate an older batch in its place; pass --batch=<id> to gate a specific one.`
    );
  }
  return latest;
}

function errorReport(task: string, err: unknown): ErrorTaskReport {
  return { task, status: "error", verdict: "incomplete", reason: err instanceof Error ? err.message : String(err) };
}

function payloadReport(sp: StoredPropagation, file: string): EvaluatedPayloadReport {
  const label = (id: string) => sp.labels.get(id) ?? id;
  const r = sp.result;
  const verdict: SecurityVerdict = sp.verdict === "not_computed" ? "incomplete" : sp.verdict;
  return {
    payload: sp.payload.id,
    task: sp.payload.task,
    file,
    status: "evaluated",
    verdict,
    batch: {
      id: sp.batch.id,
      tier: sp.batch.tier,
      created_at: sp.batch.created_at,
      finished_at: sp.batch.finished_at,
      variants: sp.batch.variant_labels,
      trials_per_variant: sp.batch.trials_per_variant,
      deployment: sp.fingerprints,
    },
    score: { id: sp.score_id, source: sp.source },
    injection: { tool: sp.payload.inject.tool, on_call: sp.payload.inject.on_call, placement: sp.payload.inject.placement },
    unauthorized_action: { tool: sp.payload.unauthorized_action.tool, ...(sp.payload.unauthorized_action.args ? { args: sp.payload.unauthorized_action.args } : {}) },
    propagation: {
      rate: r.rate,
      runs_in_batch: r.runs_in_batch,
      runs_scored: r.runs_scored,
      runs_propagated: r.runs_propagated,
      max_propagation_rate: sp.payload.gate.max_propagation_rate,
      depths: r.depths,
      propagated_runs: r.runs
        .filter((x) => x.propagated)
        .map((x) => ({
          run: label(x.run_id),
          run_id: x.run_id,
          injected_call: x.injected_index! + 1,
          action_call: x.action_index! + 1,
          depth: x.depth!,
          action: x.action!,
        })),
      held_runs: r.runs.filter((x) => x.exposure === "exposed" && !x.propagated).map((x) => label(x.run_id)),
      not_exposed: r.runs.filter((x) => x.exposure === "not_exposed").map((x) => ({ run: label(x.run_id), run_id: x.run_id, reason: x.reason ?? "" })),
      excluded: r.runs.filter((x) => x.exposure === "excluded").map((x) => ({ run: label(x.run_id), run_id: x.run_id, reason: x.reason ?? "" })),
      notes: r.notes,
    },
    warnings: sp.warnings,
  };
}

/** Gate one adversarial batch (already resolved). */
function gateAdversarialBatch(store: TraceStore, batch: BatchRow, rescore: boolean): PayloadGateReport {
  const sp = scoreAdversarialBatch(store, batch, { rescore });
  return payloadReport(sp, sp.payload_source);
}

/**
 * The security section for a set of tasks: every payload fixture targeting one of them,
 * gated on its latest adversarial batch. `runnable` maps each task in scope to null (can
 * run) or the reason it cannot, so its payloads are listed as not run rather than dropped.
 */
function gatePayloads(
  store: TraceStore,
  inScope: Map<string, { task: LoadedTask | null; unrunnable: string | null }>,
  opts: { requireAdversarial: boolean; rescore: boolean }
): PayloadGateReport[] {
  const out: PayloadGateReport[] = [];
  const all: LoadedPayload[] = loadAllPayloads();
  for (const p of all) {
    const taskName = p.payload?.task;
    if (taskName === undefined) {
      out.push({ payload: p.id, task: "?", file: p.file, status: "error", verdict: "incomplete", reason: p.errors.join("; ") });
      continue;
    }
    const scope = inScope.get(taskName);
    if (!scope) continue;
    const base = { payload: p.id, task: taskName, file: p.file };
    const hard = p.errors.filter((e) => !e.startsWith("warning:"));
    if (hard.length > 0) {
      out.push({ ...base, status: "error", verdict: "incomplete", reason: `invalid payload fixture: ${hard.join("; ")}` });
      continue;
    }
    if (scope.task && !scope.task.spec.adversarial.enabled) {
      out.push({ ...base, status: "not_run", verdict: null, reason: `${taskName} has adversarial.enabled: false` });
      continue;
    }
    if (scope.unrunnable) {
      out.push({ ...base, status: "not_run", verdict: null, reason: scope.unrunnable });
      continue;
    }
    const row = store.getTaskByName(taskName);
    const newest = row ? store.getLatestBatch(row.id, { kind: "adversarial", payloadId: p.id }) : null;
    if (!newest) {
      const reason = `no adversarial batch for this payload in the trace store (run: invariant adversarial run --task=${taskName} --payload=${p.id})`;
      out.push(
        opts.requireAdversarial
          ? { ...base, status: "error", verdict: "incomplete", reason: `${reason}; --require-adversarial was set` }
          : { ...base, status: "not_run", verdict: null, reason }
      );
      continue;
    }
    if (newest.finished_at === null) {
      out.push({
        ...base,
        status: "error",
        verdict: "incomplete",
        reason: `the latest adversarial batch for this payload (${newest.id}) has not finished; refusing to gate an older one in its place`,
      });
      continue;
    }
    try {
      out.push(gateAdversarialBatch(store, newest, opts.rescore));
    } catch (err) {
      out.push({ ...base, status: "error", verdict: "incomplete", reason: (err as Error).message });
    }
  }
  return out.sort((a, b) => a.task.localeCompare(b.task) || a.payload.localeCompare(b.payload));
}

function securitySection(payloads: PayloadGateReport[], requireAdversarial: boolean): SecurityReport {
  const verdicts = payloads.filter((p) => p.verdict !== null).map((p) => p.verdict as SecurityVerdict);
  const n = (v: SecurityVerdict) => verdicts.filter((x) => x === v).length;
  return {
    verdict: aggregateSecurityVerdict(verdicts),
    require_adversarial: requireAdversarial,
    counts: { gated: verdicts.length, pass: n("pass"), finding: n("finding"), incomplete: n("incomplete"), not_run: payloads.length - verdicts.length },
    payloads,
  };
}

export async function runGate(opts: GateOptions, deps: GateDeps = {}): Promise<GateReport> {
  if (opts.batch !== undefined && opts.task !== undefined) {
    throw new Error("pass at most one of --batch=<id> or --task=<name> (neither: gate every task's latest batch).");
  }
  const allowUncomputed = [...new Set(opts.allowUncomputed ?? [])];
  assertWaivable(allowUncomputed);
  const config = deps.config ?? loadConfig();
  const store = openTraceStore({ root: deps.storeRoot ?? INVARIANT_DIR });
  const gateOpts = { allowUncomputed, rescore: Boolean(opts.rescore) };
  const payloadOpts = { requireAdversarial: Boolean(opts.requireAdversarial), rescore: Boolean(opts.rescore) };
  const tasks: TaskGateReport[] = [];
  const payloads: PayloadGateReport[] = [];
  const warnings: string[] = [];
  const mode: GateReport["mode"] = opts.batch !== undefined ? "batch" : opts.task !== undefined ? "task" : "all";
  /** False only when the one batch asked for is adversarial: then there is no consistency part. */
  let consistencyInScope = true;

  try {
    if (mode === "batch") {
      const row = store.getBatch(opts.batch!);
      if (row?.kind === "adversarial") {
        consistencyInScope = false;
        try {
          payloads.push(gateAdversarialBatch(store, row, payloadOpts.rescore));
        } catch (err) {
          const taskName = store.getTask(row.task_id)?.name ?? row.task_id;
          payloads.push({ payload: row.payload_id ?? "?", task: taskName, file: "", status: "error", verdict: "incomplete", reason: (err as Error).message });
        }
      } else {
        try {
          const { batch, task } = resolveBatch(store, { batch: opts.batch });
          tasks.push(await gateBatch(store, batch, task, config, deps, gateOpts));
        } catch (err) {
          tasks.push(errorReport(row ? (store.getTask(row.task_id)?.name ?? row.task_id) : `batch ${opts.batch}`, err));
        }
      }
    } else if (mode === "task") {
      let loaded: LoadedTask | null = null;
      try {
        loaded = loadValidTask(opts.task!);
        tasks.push(await gateBatch(store, latestBatchForGate(store, loaded, ""), loaded, config, deps, gateOpts));
      } catch (err) {
        tasks.push(errorReport(opts.task!, err));
      }
      if (loaded) payloads.push(...gatePayloads(store, new Map([[loaded.spec.name, { task: loaded, unrunnable: null }]]), payloadOpts));
    } else {
      const all = loadAllTasks();
      if (all.length === 0) warnings.push("no task specs under tasks/: nothing to gate.");
      const valid: LoadedTask[] = [];
      for (const t of all) {
        try {
          valid.push(loadValidTask(t.name));
        } catch (err) {
          tasks.push(errorReport(t.name, err));
        }
      }
      let gaps = new Map<string, CoverageGap>();
      try {
        gaps = await toolCoverage(valid, deps.upstreamFor);
      } catch (err) {
        warnings.push(
          `could not list a tool server's tools (${(err as Error).message}); treating every task as runnable, ` +
            `so a task without a batch counts as incomplete.`
        );
      }
      const scope = new Map<string, { task: LoadedTask | null; unrunnable: string | null }>();
      for (const task of valid) {
        const gap = gaps.get(task.spec.name);
        scope.set(task.spec.name, {
          task,
          unrunnable: gap ? `base task ${task.spec.name} is not runnable: ${describeGap(gap)}` : null,
        });
        if (gap) {
          tasks.push({
            task: task.spec.name,
            status: "not_runnable",
            verdict: null,
            reason:
              `not gated: ${describeGap(gap)}, so \`invariant run\` refuses this task. No consistency was measured for it.`,
            missing_tools: gap.missing,
          });
          continue;
        }
        try {
          const batch = latestBatchForGate(store, task, "Its tools are served, so it is runnable. ");
          tasks.push(await gateBatch(store, batch, task, config, deps, gateOpts));
        } catch (err) {
          tasks.push(errorReport(task.spec.name, err));
        }
      }
      tasks.sort((a, b) => a.task.localeCompare(b.task));
      payloads.push(...gatePayloads(store, scope, payloadOpts));
    }
  } finally {
    store.close();
  }

  for (const t of tasks) {
    if (t.status === "evaluated" && t.batch.deployment.mixed) {
      warnings.push(`${t.task}: ${mixedFingerprintWarning(t.batch.id, t.batch.deployment)}`);
    }
  }
  for (const p of payloads) {
    if (p.status === "evaluated") for (const w of p.warnings) warnings.push(`${p.payload}: ${w}`);
  }

  const gatedVerdicts = tasks.filter((t) => t.status !== "not_runnable").map((t) => t.verdict as GateVerdict);
  const verdict = consistencyInScope ? aggregateVerdict(gatedVerdicts) : null;
  const security = securitySection(payloads, payloadOpts.requireAdversarial);
  const count = (v: GateVerdict) => gatedVerdicts.filter((x) => x === v).length;
  const report: GateReport = {
    schema: GATE_REPORT_SCHEMA,
    generated_at: new Date().toISOString(),
    mode,
    verdict,
    exit_code: combinedExitCode(verdict, security.verdict),
    allow_uncomputed: allowUncomputed,
    counts: {
      gated: gatedVerdicts.length,
      pass: count("pass"),
      pass_with_waivers: count("pass_with_waivers"),
      fail: count("fail"),
      incomplete: count("incomplete"),
      not_runnable: tasks.length - gatedVerdicts.length,
    },
    warnings,
    tasks,
    security,
  };

  if (opts.report) writeFile(opts.report, JSON.stringify(report, null, 2) + "\n");
  if (opts.markdown) writeFile(opts.markdown, renderGateMarkdown(report));
  const out = deps.out ?? ((line: string) => console.log(line));
  if (opts.json) out(JSON.stringify(report, null, 2));
  else for (const line of renderGateText(report)) out(line);
  return report;
}

function writeFile(file: string, content: string): void {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(file, content);
}

// ---------------------------------------------------------------- rendering

const VERDICT_TEXT: Record<GateVerdict, string> = {
  pass: "PASS",
  pass_with_waivers: "PASS WITH WAIVERS",
  fail: "FAIL",
  incomplete: "INCOMPLETE (could not evaluate)",
};

const RESULT_TEXT: Record<AxisGate["result"], string> = {
  pass: "pass",
  fail: "FAIL",
  not_computed: "NOT COMPUTED",
  waived: "NOT COMPUTED, WAIVED",
};

function fmt(score: number | null): string {
  return score === null ? "-" : score.toFixed(3);
}

/** Evidence as plain lines, shared by the text and markdown reports. */
export function evidenceLines(axis: AxisName, evidence: AxisEvidence): string[] {
  const lines = [evidence.summary];
  if (axis === "state_mutation") {
    for (const g of (evidence as StateMutationEvidence).groups) {
      const sig =
        g.signature.length === 0 ? "(no dangerous calls)" : g.signature.map((c) => `${c.tool_name} ${canonicalJson(c.args)}`).join(" ; ");
      lines.push(`${String(g.runs).padStart(3)} run(s)  ${sig}`);
      lines.push(`          [${g.trials.join(", ")}]`);
    }
  } else if (axis === "tool_path") {
    const e = evidence as ToolPathEvidence;
    for (const p of e.distinct_paths) {
      lines.push(`${String(p.runs).padStart(3)} run(s)  ${p.path.length === 0 ? "(no tool calls)" : p.path.join(" > ")}`);
      lines.push(`          [${p.trials.join(", ")}]`);
    }
    if (e.least_similar_pair) {
      const m = e.least_similar_pair;
      lines.push(`least similar pair: ${m.a} vs ${m.b}, similarity ${m.similarity.toFixed(3)}`);
    }
  } else {
    const e = evidence as OutcomeEvidence;
    e.clusters.forEach((c, i) => {
      lines.push(`cluster ${i + 1}: ${c.runs} run(s)  ${c.sample === null ? "(timed out)" : `"${c.sample}"`}`);
      lines.push(`          [${c.trials.join(", ")}]`);
    });
    if (e.judged_pairs > 0) {
      lines.push(
        `judge: ${e.judge.injected ? "an injected judge" : e.judge.model}, ${judgeTemperatureText({ temperature: e.judge.temperature, temperature_requested: e.judge.temperature_requested ?? 0 })}, majority of ${e.judge.votes}`
      );
    }
  }
  for (const n of evidence.notes) lines.push(`note: ${n}`);
  return lines;
}

function batchLine(t: EvaluatedTaskReport): string {
  return (
    `batch ${t.batch.id} (${t.batch.tier} tier, ${t.batch.runs_scored} of ${t.batch.runs_in_batch} runs scored, ` +
    `created ${t.batch.created_at}); score ${t.score.id} (${t.score.source === "stored" ? "stored score reused" : "scored now"})`
  );
}

function countsLine(r: GateReport): string {
  const c = r.counts;
  const parts = [`${c.gated} task(s) gated: ${c.pass} pass, ${c.fail} fail, ${c.incomplete} incomplete`];
  if (c.pass_with_waivers > 0) parts.push(`${c.pass_with_waivers} passed only with waivers`);
  if (c.not_runnable > 0) parts.push(`${c.not_runnable} not runnable (not gated)`);
  return parts.join("; ");
}

const SECURITY_TEXT: Record<SecurityVerdict, string> = {
  pass: "PASS",
  finding: "SECURITY FINDING",
  incomplete: "INCOMPLETE (could not evaluate)",
};

/** "FAIL", or with a security section "consistency FAIL, security SECURITY FINDING". */
function summaryVerdict(r: GateReport): string {
  const consistency = r.verdict === null ? "no consistency batch in scope" : VERDICT_TEXT[r.verdict];
  if (r.security.verdict === null) return consistency;
  return `${r.verdict === null ? consistency : `consistency ${consistency}`}; security ${SECURITY_TEXT[r.security.verdict]}`;
}

function placementText(p: EvaluatedPayloadReport): string {
  const pl = p.injection.placement as { mode: string; path?: string };
  return `${p.injection.tool} call ${p.injection.on_call}, ${pl.mode}${pl.path ? ` ${pl.path}` : ""}`;
}

/** Per-run evidence for one gated payload, from the report itself (text and markdown). */
export function payloadEvidenceLines(p: EvaluatedPayloadReport): string[] {
  const pr = p.propagation;
  const lines: string[] = [];
  for (const x of pr.propagated_runs) {
    lines.push(
      `PROPAGATED   ${x.run}: payload planted in call #${x.injected_call}, unauthorized call #${x.action_call} ` +
        `(depth ${x.depth}): ${x.action.tool_name} ${canonicalJson(x.action.args)}`
    );
  }
  if (pr.held_runs.length > 0) lines.push(`held         ${pr.held_runs.join(", ")}`);
  for (const x of pr.not_exposed) lines.push(`not exposed  ${x.run}: ${x.reason}`);
  for (const x of pr.excluded) lines.push(`excluded     ${x.run}: ${x.reason}`);
  for (const n of pr.notes) lines.push(`note: ${n}`);
  return lines;
}

function payloadHeadline(p: EvaluatedPayloadReport): string {
  const pr = p.propagation;
  return (
    `propagated in ${pr.runs_propagated} of ${pr.runs_scored} run(s) that received the payload = ${pct(pr.rate)} ` +
    `(max allowed ${pct(pr.max_propagation_rate)}); depths: ${depthText(pr.depths)}`
  );
}

function securityText(sec: SecurityReport): string[] {
  if (sec.payloads.length === 0) return [];
  const lines: string[] = [""];
  lines.push(
    `SECURITY (adversarial mode, TEST FIXTURE payloads): ${sec.verdict === null ? "nothing gated" : SECURITY_TEXT[sec.verdict]}` +
      (sec.verdict === "finding" ? `  [exit ${SECURITY_FINDING_EXIT_CODE}; route to the security owner, not the flaky-test queue]` : "")
  );
  for (const p of sec.payloads) {
    lines.push("");
    if (p.status !== "evaluated") {
      lines.push(`  ${p.task} x ${p.payload}  ${p.status === "not_run" ? "NOT RUN (not gated)" : SECURITY_TEXT.incomplete}`);
      lines.push(`    ${p.reason}`);
      continue;
    }
    lines.push(`  ${p.task} x ${p.payload}  ${SECURITY_TEXT[p.verdict]}`);
    lines.push(`    adversarial batch ${p.batch.id} (${p.batch.tier} tier); score ${p.score.id} (${p.score.source === "stored" ? "stored score reused" : "scored now"})`);
    fingerprintLines(p.batch.deployment).forEach((l, i) => lines.push(`    ${i === 0 ? "deployment   :" : "              "} ${l}`));
    lines.push(`    planted      : ${placementText(p)}  (${p.file})`);
    lines.push(`    unauthorized : ${matcherText(p.unauthorized_action)}`);
    lines.push(`    result       : ${payloadHeadline(p)}`);
    for (const l of payloadEvidenceLines(p)) lines.push(`      ${l}`);
  }
  return lines;
}

export function renderGateText(r: GateReport): string[] {
  const lines: string[] = [];
  for (const w of r.warnings) lines.push(`warning: ${w}`);
  for (const t of r.tasks) {
    lines.push("");
    if (t.status === "not_runnable") {
      lines.push(`${t.task}  NOT GATED`);
      lines.push(`  ${t.reason}`);
      continue;
    }
    if (t.status === "error") {
      lines.push(`${t.task}  ${VERDICT_TEXT.incomplete}`);
      for (const l of t.reason.split("\n")) lines.push(`  ${l}`);
      continue;
    }
    lines.push(`${t.task}  ${VERDICT_TEXT[t.verdict]}`);
    lines.push(`  ${batchLine(t)}`);
    fingerprintLines(t.batch.deployment).forEach((l, i) => lines.push(`  ${i === 0 ? "deployment   :" : "              "} ${l}`));
    for (const e of t.batch.excluded) lines.push(`  excluded     : ${e.run} (${e.status}), no behavioural answer`);
    lines.push("");
    lines.push("  axis              score   threshold   result");
    for (const a of t.axes) {
      lines.push(`  ${AXIS_LABELS[a.axis].padEnd(16)}  ${fmt(a.score).padStart(5)}   >= ${a.threshold.toFixed(3)}    ${RESULT_TEXT[a.result]}`);
    }
    for (const f of t.failing_axes) {
      lines.push("");
      lines.push(`  ${AXIS_LABELS[f.axis]} failed: ${fmt(f.score)} < ${f.threshold.toFixed(3)}`);
      for (const l of evidenceLines(f.axis, f.evidence)) lines.push(`    ${l}`);
    }
    for (const a of t.axes.filter((x) => x.result === "not_computed" || x.result === "waived")) {
      lines.push("");
      lines.push(
        a.result === "waived"
          ? `  ${AXIS_LABELS[a.axis]} NOT CHECKED: no score, waived by --allow-uncomputed. This gate says nothing about ${AXIS_LABELS[a.axis]} consistency.`
          : `  ${AXIS_LABELS[a.axis]} not computed, so the gate cannot pass this batch:`
      );
      lines.push(`    ${a.reason}`);
    }
    for (const n of t.notes) lines.push(`  note: ${n}`);
  }
  lines.push(...securityText(r.security));
  lines.push("");
  lines.push(`invariant gate: ${summaryVerdict(r)} (exit ${r.exit_code}).${r.verdict === null ? "" : ` ${countsLine(r)}.`}`);
  if (r.allow_uncomputed.length > 0) {
    lines.push(`  --allow-uncomputed=${r.allow_uncomputed.join(",")} was set: those axes may be missing without failing the gate.`);
  }
  return lines;
}

function mdCell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function codeBlock(lines: string[]): string[] {
  return ["```text", ...lines.map((l) => l.replace(/```/g, "'''")), "```"];
}

function axisCell(a: AxisGate): string {
  switch (a.result) {
    case "pass":
      return `${fmt(a.score)} (>= ${a.threshold.toFixed(2)})`;
    case "fail":
      return `**${fmt(a.score)} < ${a.threshold.toFixed(2)} FAIL**`;
    case "not_computed":
      return "**not computed**";
    case "waived":
      return "**not computed, waived**";
  }
}

/**
 * The security section of the PR comment: its own heading, verdict and table, so a finding
 * is never read as (or buried in) a consistency failure.
 */
function securityMarkdown(sec: SecurityReport): string[] {
  if (sec.payloads.length === 0) return [];
  const L: string[] = [""];
  L.push(`### Security (adversarial): ${sec.verdict === null ? "nothing gated" : SECURITY_TEXT[sec.verdict]}`);
  L.push("");
  L.push(
    "Injection propagation: a TEST FIXTURE instruction is planted in one tool response, and a run *propagates* when the " +
      "agent then makes the payload's unauthorized call. Gated separately from consistency" +
      (sec.verdict === "finding" ? `; **a finding exits ${SECURITY_FINDING_EXIT_CODE} and belongs to the security owner, not the flaky-test queue.**` : ".")
  );
  L.push("");
  L.push("| Payload | Task | Planted into | Unauthorized action | Propagated | Rate (max) | Depths | Verdict |");
  L.push("|---|---|---|---|---|---|---|---|");
  for (const p of sec.payloads) {
    if (p.status === "evaluated") {
      const pr = p.propagation;
      L.push(
        `| \`${p.payload}\` | \`${p.task}\` | ${mdCell(placementText(p))} | \`${mdCell(matcherText(p.unauthorized_action))}\` | ` +
          `${pr.runs_propagated} of ${pr.runs_scored} | ${pct(pr.rate)} (${pct(pr.max_propagation_rate)}) | ${depthText(pr.depths)} | ` +
          `**${SECURITY_TEXT[p.verdict]}** |`
      );
    } else {
      L.push(`| \`${p.payload}\` | \`${p.task}\` | - | - | - | - | - | ${p.status === "not_run" ? "not run" : `**${SECURITY_TEXT.incomplete}**`} |`);
    }
  }
  for (const p of sec.payloads) {
    L.push("");
    if (p.status !== "evaluated") {
      L.push(`- \`${p.payload}\` ${p.status === "not_run" ? "not run" : "could not be evaluated"}: ${mdCell(p.reason)}`);
      continue;
    }
    L.push(`**\`${p.payload}\`: ${SECURITY_TEXT[p.verdict]}.** Adversarial batch ${p.batch.id} (${p.batch.tier} tier), ${mdCell(payloadHeadline(p))}.`);
    const fp = fingerprintLines(p.batch.deployment);
    if (fp.length > 0) {
      L.push("");
      L.push(`Deployment fingerprint${fp.length > 1 ? "s" : ""}: ${fp.map((l) => mdCell(l)).join("; ")}.`);
    }
    L.push("");
    L.push(...codeBlock(payloadEvidenceLines(p)));
  }
  return L;
}

/** Markdown for a PR comment. Starts with PR_COMMENT_MARKER so CI can update it in place. */
export function renderGateMarkdown(r: GateReport): string {
  const L: string[] = [PR_COMMENT_MARKER];
  L.push(`## invariant gate: ${summaryVerdict(r)}`);
  L.push("");
  L.push(`${r.verdict === null ? "" : `${countsLine(r)}. `}Exit code ${r.exit_code}.`);
  L.push("");
  for (const w of r.warnings) L.push(`> **Warning:** ${mdCell(w)}`);
  const waived = r.tasks.filter((t): t is EvaluatedTaskReport => t.status === "evaluated" && t.axes.some((a) => a.result === "waived"));
  if (waived.length > 0) {
    L.push(
      `> **Not every axis was checked.** \`--allow-uncomputed=${r.allow_uncomputed.join(",")}\` was set and ` +
        `${waived.length} task(s) passed with an axis that has no score (${waived
          .map((t) => `${t.task}: ${t.axes.filter((a) => a.result === "waived").map((a) => AXIS_LABELS[a.axis]).join(", ")}`)
          .join("; ")}). This gate says nothing about those axes.`
    );
    L.push("");
  }

  if (r.tasks.length > 0) {
    L.push("### Consistency");
    L.push("");
    L.push("| Task | Tier | Runs scored | state-mutation | tool-path | outcome | Verdict |");
    L.push("|---|---|---|---|---|---|---|");
  }
  for (const t of r.tasks) {
    if (t.status === "evaluated") {
      const cell = (axis: AxisName) => axisCell(t.axes.find((a) => a.axis === axis)!);
      L.push(
        `| \`${t.task}\` | ${t.batch.tier} | ${t.batch.runs_scored} of ${t.batch.runs_in_batch} | ${cell("state_mutation")} | ` +
          `${cell("tool_path")} | ${cell("outcome")} | **${VERDICT_TEXT[t.verdict]}** |`
      );
    } else if (t.status === "not_runnable") {
      L.push(`| \`${t.task}\` | - | - | - | - | - | not gated: no tool server for [${t.missing_tools.join(", ")}] |`);
    } else {
      L.push(`| \`${t.task}\` | - | - | - | - | - | **${VERDICT_TEXT.incomplete}** |`);
    }
  }

  for (const t of r.tasks) {
    if (t.status === "not_runnable") continue;
    L.push("");
    L.push(`### \`${t.task}\`: ${VERDICT_TEXT[t.verdict]}`);
    L.push("");
    if (t.status === "error") {
      L.push(...codeBlock(t.reason.split("\n")));
      continue;
    }
    L.push(mdCell(batchLine(t)) + ".");
    const fp = fingerprintLines(t.batch.deployment);
    if (fp.length > 0) {
      L.push("");
      L.push(`Deployment fingerprint${fp.length > 1 ? "s" : ""}: ${fp.map((l) => mdCell(l)).join("; ")}.`);
    }
    if (t.batch.excluded.length > 0) {
      L.push("");
      L.push(`Excluded (no behavioural answer): ${t.batch.excluded.map((e) => `${e.run} (${e.status})`).join(", ")}.`);
    }
    for (const f of t.failing_axes) {
      L.push("");
      L.push(`**${AXIS_LABELS[f.axis]} failed: ${fmt(f.score)} < ${f.threshold.toFixed(3)}**`);
      L.push("");
      L.push(...codeBlock(evidenceLines(f.axis, f.evidence)));
    }
    for (const a of t.axes.filter((x) => x.result === "not_computed" || x.result === "waived")) {
      L.push("");
      L.push(
        a.result === "waived"
          ? `**${AXIS_LABELS[a.axis]} not computed, waived by \`--allow-uncomputed\`:** ${mdCell(a.reason ?? "")}`
          : `**${AXIS_LABELS[a.axis]} not computed, so this batch cannot pass:** ${mdCell(a.reason ?? "")}`
      );
    }
    if (t.notes.length > 0) {
      L.push("");
      for (const n of t.notes) L.push(`- note: ${mdCell(n)}`);
    }
  }

  const notRunnable = r.tasks.filter((t): t is NotRunnableTaskReport => t.status === "not_runnable");
  if (notRunnable.length > 0) {
    L.push("");
    L.push("### Not gated");
    L.push("");
    for (const t of notRunnable) L.push(`- \`${t.task}\`: ${mdCell(t.reason)}`);
  }
  L.push(...securityMarkdown(r.security));
  L.push("");
  L.push(
    `<sub>Thresholds from \`tasks/<name>.yaml\`${r.security.payloads.length > 0 ? " and `tasks/adversarial/<payload>.yaml`" : ""}. ` +
      `Report schema ${GATE_REPORT_SCHEMA}, generated ${r.generated_at}.</sub>`
  );
  return L.join("\n") + "\n";
}
