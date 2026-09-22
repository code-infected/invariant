import { scoreOutcome, type OutcomeOptions, type OutcomeResult } from "./outcome.js";
import { scoreStateMutation, type StateMutationResult } from "./state-mutation.js";
import { scoreToolPath, type ToolPathResult } from "./tool-path.js";
import type { ScoringRun, ScoringTask } from "./types.js";

/** A run as it comes out of the store: any status, only ok/timeout get scored. */
export type BatchRunInput = Omit<ScoringRun, "status"> & { status: string };

export type Verdict = "pass" | "fail" | "n/a";

export interface AxisReport<R> {
  /** Null when the axis could not be computed or had fewer than 2 runs. */
  score: number | null;
  threshold: number;
  verdict: Verdict;
  /** Present when computed. */
  result?: R;
  /** Present when not computed: why. */
  error?: string;
}

export interface BatchScore {
  task: string;
  runs_in_batch: number;
  runs_scored: number;
  /** Runs with no behavioural answer (infra_error, or never completed), left out of every axis. */
  excluded: Array<{ run_id: string; status: string }>;
  state_mutation: AxisReport<StateMutationResult>;
  tool_path: AxisReport<ToolPathResult>;
  outcome: AxisReport<OutcomeResult>;
}

/** Scores are ratios of small integers; the tolerance only stops 0.7499999 from failing 0.75. */
const EPSILON = 1e-9;

export function verdictFor(score: number | null, threshold: number): Verdict {
  if (score === null) return "n/a";
  return score + EPSILON >= threshold ? "pass" : "fail";
}

/**
 * Score one batch's run matrix on all three axes, independently.
 *
 * Runs without a behavioural answer are excluded up front (and listed), matching the
 * retry policy's rule that an infra failure never counts for or against consistency. The
 * denominators below are therefore "runs scored", not "rows in the batch".
 *
 * State-mutation and tool-path need no model and always compute. The outcome axis can
 * fail (no API key, judge errors); when it does, it is reported as not computed with the
 * reason, and the other two axes still stand. Threshold comparison is score >= threshold
 * for all three axes; this reports pass/fail per axis but is not the CI gate.
 */
export async function scoreBatch(
  runs: readonly BatchRunInput[],
  task: ScoringTask,
  options: OutcomeOptions = {}
): Promise<BatchScore> {
  const scored: ScoringRun[] = [];
  const excluded: BatchScore["excluded"] = [];
  for (const run of runs) {
    if (run.status === "ok" || run.status === "timeout") scored.push({ ...run, status: run.status });
    else excluded.push({ run_id: run.run_id, status: run.status });
  }

  const t = task.thresholds;
  const sm = scoreStateMutation(scored, task);
  const tp = scoreToolPath(scored);

  let outcome: AxisReport<OutcomeResult>;
  try {
    const result = await scoreOutcome(scored, task.success_rubric, options);
    outcome = {
      score: result.score,
      threshold: t.outcome_consistency_min,
      verdict: verdictFor(result.score, t.outcome_consistency_min),
      result,
    };
  } catch (err) {
    outcome = {
      score: null,
      threshold: t.outcome_consistency_min,
      verdict: "n/a",
      error: err instanceof Error ? err.message : String(err),
    };
  }

  return {
    task: task.name,
    runs_in_batch: runs.length,
    runs_scored: scored.length,
    excluded,
    state_mutation: {
      score: sm.score,
      threshold: t.state_mutation_consistency,
      verdict: verdictFor(sm.score, t.state_mutation_consistency),
      result: sm,
    },
    tool_path: {
      score: tp.score,
      threshold: t.tool_path_consistency_min,
      verdict: verdictFor(tp.score, t.tool_path_consistency_min),
      result: tp,
    },
    outcome,
  };
}
