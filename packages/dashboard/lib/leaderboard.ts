import type { AxisGate, GateVerdict } from "@invariant/scoring";
import type { BatchDeployment, BatchRow, ScoreRow, TraceStore } from "@invariant/trace-store";
import type { TaskSpecLite } from "./specs";
import { thresholdsFor, verdictFor, worstMargin } from "./scores";

/**
 * scored            latest finished batch has a stored score
 * unscored          latest finished batch exists but nobody ran `invariant score` on it
 * no_finished_batch batches exist, none finished
 * no_batch          the spec exists, the store has never run it (and its tools are served, or we cannot tell)
 * not_runnable      the tool server recorded in the store does not serve this task's tools
 * spec_error        tasks/<name>.yaml does not parse
 */
export type RowState = "scored" | "unscored" | "no_finished_batch" | "no_batch" | "not_runnable" | "spec_error";

export interface LeaderRow {
  task: string;
  state: RowState;
  batch: BatchRow | null;
  /** A batch newer than `batch` that has not finished (still running, or died). */
  unfinished_newer: BatchRow | null;
  runs_total: number;
  runs_scored: number | null;
  /** Matrix runs by status, e.g. { ok: 8, infra_error: 1 }. */
  status_counts: Record<string, number>;
  score: ScoreRow | null;
  axes: AxisGate[] | null;
  verdict: GateVerdict | null;
  thresholds_source: string | null;
  deployment: BatchDeployment | null;
  synthetic: boolean;
  worst_margin: number | null;
  missing_tools: string[];
  note: string | null;
}

export interface ServedTools {
  tools: string[];
  /** The fingerprint whose tool schema this list comes from, and when it was first seen. */
  fingerprint: string;
  seen_at: string;
}

/** The tool list the proxy most recently exposed, as recorded in the newest fingerprint. */
export function servedTools(store: TraceStore): ServedTools | null {
  const fps = store.listDeploymentFingerprints();
  const latest = fps[fps.length - 1];
  if (!latest) return null;
  try {
    const tools = (JSON.parse(latest.tool_schema_json) as Array<{ name?: unknown }>)
      .map((t) => t.name)
      .filter((n): n is string => typeof n === "string");
    return { tools, fingerprint: latest.hash, seen_at: latest.first_seen_at };
  } catch {
    return null;
  }
}

const STATE_RANK: Record<RowState, number> = {
  scored: 0,
  unscored: 1,
  no_finished_batch: 2,
  no_batch: 3,
  spec_error: 4,
  not_runnable: 5,
};
const VERDICT_RANK: Record<GateVerdict, number> = { fail: 0, incomplete: 1, pass_with_waivers: 2, pass: 3 };

/** Most at-risk first: failing, then incomplete, then passing, each by worst margin; then the unmeasured. */
export function compareRows(a: LeaderRow, b: LeaderRow): number {
  if (STATE_RANK[a.state] !== STATE_RANK[b.state]) return STATE_RANK[a.state] - STATE_RANK[b.state];
  if (a.verdict && b.verdict && a.verdict !== b.verdict) return VERDICT_RANK[a.verdict] - VERDICT_RANK[b.verdict];
  const ma = a.worst_margin ?? Number.POSITIVE_INFINITY;
  const mb = b.worst_margin ?? Number.POSITIVE_INFINITY;
  if (ma !== mb) return ma - mb;
  return a.task.localeCompare(b.task);
}

function emptyRow(task: string, state: RowState): LeaderRow {
  return {
    task,
    state,
    batch: null,
    unfinished_newer: null,
    runs_total: 0,
    runs_scored: null,
    status_counts: {},
    score: null,
    axes: null,
    verdict: null,
    thresholds_source: null,
    deployment: null,
    synthetic: false,
    worst_margin: null,
    missing_tools: [],
    note: null,
  };
}

/** Every task in the store or under tasks/, with its latest finished batch. */
export function buildLeaderboard(store: TraceStore | null, specs: TaskSpecLite[]): { rows: LeaderRow[]; served: ServedTools | null } {
  const served = store ? servedTools(store) : null;
  const specByName = new Map(specs.map((s) => [s.name, s]));
  const rows: LeaderRow[] = [];
  const seen = new Set<string>();

  for (const task of store?.listTasks() ?? []) {
    seen.add(task.name);
    const spec = specByName.get(task.name);
    const batches = store!.listBatches(task.id);
    const finished = batches.filter((b) => b.finished_at !== null);
    const latest = finished[finished.length - 1] ?? null;
    const newest = batches[batches.length - 1] ?? null;
    if (!latest) {
      const row = emptyRow(task.name, batches.length ? "no_finished_batch" : "no_batch");
      row.unfinished_newer = newest;
      rows.push(row);
      continue;
    }
    const runs = store!.getBatchRuns(latest.id);
    const status_counts: Record<string, number> = {};
    for (const r of runs) status_counts[r.status] = (status_counts[r.status] ?? 0) + 1;
    const score = store!.getScores(latest.id)[0] ?? null;
    const deployment = store!.getBatchDeployment(latest.id);
    const th = thresholdsFor(task, spec);
    const v = score && th ? verdictFor(score, th.thresholds) : null;
    rows.push({
      task: task.name,
      state: score ? "scored" : "unscored",
      batch: latest,
      unfinished_newer: newest && newest.id !== latest.id && newest.finished_at === null ? newest : null,
      runs_total: runs.length,
      runs_scored: score?.runs_scored ?? null,
      status_counts,
      score,
      axes: v?.axes ?? null,
      verdict: v?.verdict ?? null,
      thresholds_source: th?.source ?? null,
      deployment,
      synthetic: deployment.fingerprints.some((f) => f.synthetic),
      worst_margin: v ? worstMargin(v.axes) : null,
      missing_tools: [],
      note: score && !th ? "no thresholds found (neither tasks/ nor the stored copy)" : null,
    });
  }

  for (const spec of specs) {
    if (seen.has(spec.name)) continue;
    if (spec.error) {
      const row = emptyRow(spec.name, "spec_error");
      row.note = spec.error;
      rows.push(row);
      continue;
    }
    const missing = served ? spec.allowed_tools.filter((t) => !served.tools.includes(t)) : [];
    const row = emptyRow(spec.name, missing.length ? "not_runnable" : "no_batch");
    row.missing_tools = missing;
    row.thresholds_source = spec.thresholds ? spec.file : null;
    rows.push(row);
  }

  rows.sort(compareRows);
  return { rows, served };
}
