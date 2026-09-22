/**
 * `invariant gate`: turn stored consistency scores into a CI verdict.
 *
 * Exit codes
 *   0  every gated task passed (verdict "pass", or "pass_with_waivers" when an axis was
 *      explicitly allowed to go uncomputed with --allow-uncomputed)
 *   1  evaluated and failed: at least one scored axis is below its threshold
 *   2  could not evaluate: an axis has no score and was not waived, a runnable task has
 *      no finished batch, the batch is unfinished, a spec is invalid, bad arguments, ...
 * A measured failure outranks a missing score: 1 wins over 2 when both apply.
 *
 * Uncomputed axes fail closed. The outcome axis needs the LLM judge (ANTHROPIC_API_KEY);
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
 * JSON report, schema "invariant.gate/v1" (see the GateReport type below):
 *
 * {
 *   "schema": "invariant.gate/v1",
 *   "generated_at": ISO timestamp,
 *   "mode": "batch" | "task" | "all",
 *   "verdict": "pass" | "pass_with_waivers" | "fail" | "incomplete",   aggregate over tasks
 *   "exit_code": 0 | 1 | 2,
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
 *   ]
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
  aggregateVerdict,
  assertWaivable,
  AXIS_LABELS,
  AXES,
  canonicalJson,
  evaluateGate,
  gateExitCode,
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
  scoringTask,
  specDrift,
  type JudgeSettings,
  type ScoreDeps,
} from "./score.js";

export const GATE_REPORT_SCHEMA = "invariant.gate/v1";
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
  judge: { model: string; temperature: number; votes: number; injected: boolean };
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

export interface GateReport {
  schema: typeof GATE_REPORT_SCHEMA;
  generated_at: string;
  mode: "batch" | "task" | "all";
  verdict: GateVerdict;
  exit_code: 0 | 1 | 2;
  allow_uncomputed: AxisName[];
  counts: { gated: number; pass: number; pass_with_waivers: number; fail: number; incomplete: number; not_runnable: number };
  warnings: string[];
  tasks: TaskGateReport[];
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

export async function runGate(opts: GateOptions, deps: GateDeps = {}): Promise<GateReport> {
  if (opts.batch !== undefined && opts.task !== undefined) {
    throw new Error("pass at most one of --batch=<id> or --task=<name> (neither: gate every task's latest batch).");
  }
  const allowUncomputed = [...new Set(opts.allowUncomputed ?? [])];
  assertWaivable(allowUncomputed);
  const config = deps.config ?? loadConfig();
  const store = openTraceStore({ root: deps.storeRoot ?? INVARIANT_DIR });
  const gateOpts = { allowUncomputed, rescore: Boolean(opts.rescore) };
  const tasks: TaskGateReport[] = [];
  const warnings: string[] = [];
  const mode: GateReport["mode"] = opts.batch !== undefined ? "batch" : opts.task !== undefined ? "task" : "all";

  try {
    if (mode === "batch") {
      try {
        const { batch, task } = resolveBatch(store, { batch: opts.batch });
        tasks.push(await gateBatch(store, batch, task, config, deps, gateOpts));
      } catch (err) {
        const row = store.getBatch(opts.batch!);
        tasks.push(errorReport(row ? (store.getTask(row.task_id)?.name ?? row.task_id) : `batch ${opts.batch}`, err));
      }
    } else if (mode === "task") {
      try {
        const task = loadValidTask(opts.task!);
        tasks.push(await gateBatch(store, latestBatchForGate(store, task, ""), task, config, deps, gateOpts));
      } catch (err) {
        tasks.push(errorReport(opts.task!, err));
      }
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
      for (const task of valid) {
        const gap = gaps.get(task.spec.name);
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
    }
  } finally {
    store.close();
  }

  for (const t of tasks) {
    if (t.status === "evaluated" && t.batch.deployment.mixed) {
      warnings.push(`${t.task}: ${mixedFingerprintWarning(t.batch.id, t.batch.deployment)}`);
    }
  }

  const gatedVerdicts = tasks.filter((t) => t.status !== "not_runnable").map((t) => t.verdict as GateVerdict);
  const verdict = aggregateVerdict(gatedVerdicts);
  const count = (v: GateVerdict) => gatedVerdicts.filter((x) => x === v).length;
  const report: GateReport = {
    schema: GATE_REPORT_SCHEMA,
    generated_at: new Date().toISOString(),
    mode,
    verdict,
    exit_code: gateExitCode(verdict),
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
        `judge: ${e.judge.injected ? "an injected judge" : e.judge.model}, temperature ${e.judge.temperature}, majority of ${e.judge.votes}`
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
  lines.push("");
  lines.push(`invariant gate: ${VERDICT_TEXT[r.verdict]} (exit ${r.exit_code}). ${countsLine(r)}.`);
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

/** Markdown for a PR comment. Starts with PR_COMMENT_MARKER so CI can update it in place. */
export function renderGateMarkdown(r: GateReport): string {
  const L: string[] = [PR_COMMENT_MARKER];
  L.push(`## invariant gate: ${VERDICT_TEXT[r.verdict]}`);
  L.push("");
  L.push(`${countsLine(r)}. Exit code ${r.exit_code}.`);
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

  L.push("| Task | Tier | Runs scored | state-mutation | tool-path | outcome | Verdict |");
  L.push("|---|---|---|---|---|---|---|");
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
  L.push("");
  L.push(
    `<sub>Thresholds from \`tasks/<name>.yaml\`. Report schema ${GATE_REPORT_SCHEMA}, generated ${r.generated_at}.</sub>`
  );
  return L.join("\n") + "\n";
}
