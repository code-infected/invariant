import type { GateVerdict } from "@invariant/scoring";
import {
  compareDeployments,
  type BatchDeployment,
  type BatchRow,
  type FingerprintComponent,
  type TaskRow,
  type TraceStore,
} from "@invariant/trace-store";
import { thresholdsFor, verdictFor, type ThresholdsWithSource } from "./scores";
import type { TaskSpecLite } from "./specs";

export interface FingerprintChange {
  from: string;
  to: string;
  /** Recorded components that differ. Empty for a formula-only change. */
  components: FingerprintComponent[];
  /** True when the change happened inside this batch (a mixed batch). */
  within_batch: boolean;
  /**
   * The hash changed only because the fingerprint formula did (e.g. v1 -> v2 added
   * provider and endpoint): every component both fingerprints recorded is equal. Not a
   * deployment change, and drawn and labelled as such.
   */
  formula_only: boolean;
  /** [from, to] formula versions when they differ. */
  formula_versions?: [number, number];
}

export interface TrendPoint {
  index: number;
  batch: BatchRow;
  scored: boolean;
  state_mutation: number | null;
  tool_path: number | null;
  outcome: number | null;
  runs_scored: number | null;
  runs_total: number;
  verdict: GateVerdict | null;
  deployment: BatchDeployment;
  /** The fingerprint most of this batch's runs carry. */
  dominant: string | null;
  /** Fingerprint changes arriving at this batch: from the previous batch, and/or within it. */
  changes: FingerprintChange[];
}

export interface Trend {
  task: TaskRow;
  points: TrendPoint[];
  thresholds: ThresholdsWithSource | null;
  fingerprints: string[];
}

function change(store: TraceStore, from: string, to: string, withinBatch: boolean): FingerprintChange {
  const a = store.getDeploymentFingerprint(from);
  const b = store.getDeploymentFingerprint(to);
  if (!a || !b) return { from, to, components: [], within_batch: withinBatch, formula_only: false };
  const c = compareDeployments(a, b);
  return {
    from,
    to,
    components: c.changed,
    within_batch: withinBatch,
    formula_only: c.formula_only,
    ...(c.formula_changed ? { formula_versions: [a.fingerprint_version ?? 1, b.fingerprint_version ?? 1] as [number, number] } : {}),
  };
}

/** Every finished batch of a task, oldest first, with its latest stored score and fingerprints. */
export function getTrend(store: TraceStore, taskName: string, specs: TaskSpecLite[]): Trend | null {
  const task = store.getTaskByName(taskName);
  if (!task) return null;
  const th = thresholdsFor(task, specs.find((s) => s.name === task.name));
  const points: TrendPoint[] = [];
  let previous: string | null = null;
  const order: string[] = [];
  for (const batch of store.listBatches(task.id).filter((b) => b.finished_at !== null)) {
    const score = store.getScores(batch.id)[0] ?? null;
    const deployment = store.getBatchDeployment(batch.id);
    // For a mixed batch, the run order says which fingerprint came last.
    const runs = store.getBatchRuns(batch.id);
    const inOrder = [...runs].sort((x, y) => x.created_at.localeCompare(y.created_at)).map((r) => r.deployment_fingerprint).filter((h): h is string => h !== null);
    const first = inOrder[0] ?? null;
    const last = inOrder[inOrder.length - 1] ?? null;
    const changes: FingerprintChange[] = [];
    if (previous && first && previous !== first) {
      changes.push(change(store, previous, first, false));
    }
    for (let i = 1; i < inOrder.length; i++) {
      if (inOrder[i] !== inOrder[i - 1]) {
        changes.push(change(store, inOrder[i - 1]!, inOrder[i]!, true));
      }
    }
    for (const h of inOrder) if (!order.includes(h)) order.push(h);
    if (last) previous = last;
    points.push({
      index: points.length,
      batch,
      scored: score !== null,
      state_mutation: score?.state_mutation_consistency ?? null,
      tool_path: score?.tool_path_consistency ?? null,
      outcome: score?.outcome_consistency ?? null,
      runs_scored: score?.runs_scored ?? null,
      runs_total: runs.length,
      verdict: score && th ? verdictFor(score, th.thresholds).verdict : null,
      deployment,
      dominant: deployment.fingerprints[0]?.hash ?? null,
      changes,
    });
  }
  return { task, points, thresholds: th, fingerprints: order };
}
