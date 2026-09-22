import type { GateVerdict } from "@invariant/scoring";
import {
  changedComponents,
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
  components: FingerprintComponent[];
  /** True when the change happened inside this batch (a mixed batch). */
  within_batch: boolean;
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

function components(store: TraceStore, from: string, to: string): FingerprintComponent[] {
  const a = store.getDeploymentFingerprint(from);
  const b = store.getDeploymentFingerprint(to);
  return a && b ? changedComponents(a, b) : [];
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
      changes.push({ from: previous, to: first, components: components(store, previous, first), within_batch: false });
    }
    for (let i = 1; i < inOrder.length; i++) {
      if (inOrder[i] !== inOrder[i - 1]) {
        changes.push({ from: inOrder[i - 1]!, to: inOrder[i]!, components: components(store, inOrder[i - 1]!, inOrder[i]!), within_batch: true });
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
