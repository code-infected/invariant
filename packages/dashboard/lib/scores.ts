import {
  AXES,
  evaluateGate,
  type AxisGate,
  type AxisName,
  type BatchScore,
  type GateVerdict,
  type Thresholds,
} from "@invariant/scoring";
import type { ScoreRow, TaskRow } from "@invariant/trace-store";
import { parseThresholds, type TaskSpecLite } from "./specs";

/** What `invariant score` stores in scores.details: the BatchScore plus labels and judge settings. */
export type StoredDetails = Partial<BatchScore> & {
  labels?: Record<string, string>;
  judge?: { model: string; temperature: number; votes: number; injected: boolean };
  spec_source?: string;
};

export function detailsOf(score: ScoreRow | null): StoredDetails {
  const d = score?.details;
  return d && typeof d === "object" ? (d as StoredDetails) : {};
}

export interface ThresholdsWithSource {
  thresholds: Thresholds;
  /** tasks/<name>.yaml as it is now (what the CI gate uses), or the copy stored when the task last ran. */
  source: string;
}

export function thresholdsFor(task: TaskRow | null, spec: TaskSpecLite | undefined): ThresholdsWithSource | null {
  if (spec?.thresholds) return { thresholds: spec.thresholds, source: spec.file };
  const stored = parseThresholds(task?.thresholds);
  return stored ? { thresholds: stored, source: "copy stored with the task's last run" } : null;
}

export interface Verdict {
  verdict: GateVerdict;
  axes: AxisGate[];
}

/**
 * The gate's own comparison (evaluateGate) over the stored score's numbers: same rule,
 * no waivers, no rescoring. A missing axis fails closed to "incomplete" exactly as in CI.
 */
export function verdictFor(score: ScoreRow, t: Thresholds): Verdict {
  const d = detailsOf(score);
  const axis = (name: AxisName, value: number | null) => ({
    score: value,
    threshold: 0,
    verdict: "n/a" as const,
    error: (d[name] as { error?: string } | undefined)?.error,
  });
  const e = evaluateGate(
    {
      state_mutation: axis("state_mutation", score.state_mutation_consistency),
      tool_path: axis("tool_path", score.tool_path_consistency),
      outcome: axis("outcome", score.outcome_consistency),
      runs_scored: score.runs_scored,
      runs_in_batch: d.runs_in_batch ?? score.runs_scored,
    },
    t
  );
  return { verdict: e.verdict, axes: e.axes };
}

/** Smallest (score - threshold) over computed axes: negative = failing, most negative = worst. */
export function worstMargin(axes: AxisGate[]): number | null {
  const margins = axes.filter((a) => a.score !== null).map((a) => a.score! - a.threshold);
  return margins.length ? Math.min(...margins) : null;
}

export { AXES };
