import { verdictFor, type BatchScore } from "./score-batch.js";
import type { Thresholds } from "./types.js";

export type AxisName = "state_mutation" | "tool_path" | "outcome";

/** Gate order: the axis that maps to real harm first. */
export const AXES: readonly AxisName[] = ["state_mutation", "tool_path", "outcome"];

export const AXIS_LABELS: Record<AxisName, string> = {
  state_mutation: "state-mutation",
  tool_path: "tool-path",
  outcome: "outcome",
};

/**
 * Axes whose missing score may be waived with an explicit opt-in.
 *
 * Only outcome: it is the one axis whose computation depends on something outside the
 * batch (the LLM judge, hence ANTHROPIC_API_KEY). State-mutation and tool-path need no
 * model and are only ever missing when fewer than two runs were scored, and a batch like
 * that has measured no consistency at all. Waiving them would let a gate pass on nothing.
 */
export const WAIVABLE_AXES: readonly AxisName[] = ["outcome"];

/**
 * pass          scored, at or above threshold
 * fail          scored, below threshold
 * not_computed  no score (judge unavailable or errored, or fewer than 2 runs scored)
 * waived        no score, and the caller explicitly allowed that for this axis
 */
export type AxisGateResult = "pass" | "fail" | "not_computed" | "waived";

/**
 * pass               every axis scored and at or above threshold
 * pass_with_waivers  no axis failed, but at least one was not computed and was waived.
 *                    Deliberately not the string "pass": a consumer that checks for
 *                    "pass" treats a waived gate as not passed unless it opts in too.
 * fail               at least one scored axis is below threshold. Takes precedence over
 *                    missing axes: a measured failure is a finding whatever else is unknown.
 * incomplete         nothing failed, but at least one axis has no score and was not waived,
 *                    so the gate cannot say the batch passes.
 */
export type GateVerdict = "pass" | "pass_with_waivers" | "fail" | "incomplete";

export interface AxisGate {
  axis: AxisName;
  score: number | null;
  threshold: number;
  result: AxisGateResult;
  /** Why there is no score; present for not_computed and waived. */
  reason?: string;
}

export interface GateEvaluation {
  verdict: GateVerdict;
  axes: AxisGate[];
  failing: AxisName[];
  not_computed: AxisName[];
  waived: AxisName[];
}

export function assertWaivable(axes: readonly string[]): asserts axes is AxisName[] {
  for (const axis of axes) {
    if (!WAIVABLE_AXES.includes(axis as AxisName)) {
      throw new Error(
        `cannot allow "${axis}" to go uncomputed: only [${WAIVABLE_AXES.join(", ")}] may be waived. ` +
          `state_mutation and tool_path need no model and are only missing when fewer than two runs were ` +
          `scored, which means the batch measured no consistency; passing it would pass on nothing.`
      );
    }
  }
}

/**
 * Compare one batch's scores to thresholds. Pure: no I/O, no rescoring.
 *
 * Thresholds are passed in rather than read from the score, so a stored score can be
 * gated against the task spec as it is now. The comparison itself is verdictFor, the same
 * score >= threshold rule (with float tolerance) the scorer reports.
 */
export function evaluateGate(
  score: Pick<BatchScore, "state_mutation" | "tool_path" | "outcome" | "runs_scored" | "runs_in_batch">,
  thresholds: Thresholds,
  options: { allowUncomputed?: readonly AxisName[] } = {}
): GateEvaluation {
  const allowed = options.allowUncomputed ?? [];
  assertWaivable(allowed);
  const thresholdFor: Record<AxisName, number> = {
    state_mutation: thresholds.state_mutation_consistency,
    tool_path: thresholds.tool_path_consistency_min,
    outcome: thresholds.outcome_consistency_min,
  };

  const axes: AxisGate[] = AXES.map((axis) => {
    const report = score[axis];
    const threshold = thresholdFor[axis];
    if (report.score === null) {
      const reason =
        report.error ??
        `fewer than 2 runs scored (${score.runs_scored} of ${score.runs_in_batch} in the batch); consistency needs at least two`;
      return { axis, score: null, threshold, result: allowed.includes(axis) ? "waived" : "not_computed", reason };
    }
    const v = verdictFor(report.score, threshold);
    return { axis, score: report.score, threshold, result: v === "pass" ? "pass" : "fail" };
  });

  const failing = axes.filter((a) => a.result === "fail").map((a) => a.axis);
  const notComputed = axes.filter((a) => a.result === "not_computed").map((a) => a.axis);
  const waived = axes.filter((a) => a.result === "waived").map((a) => a.axis);
  const verdict: GateVerdict =
    failing.length > 0 ? "fail" : notComputed.length > 0 ? "incomplete" : waived.length > 0 ? "pass_with_waivers" : "pass";
  return { verdict, axes, failing, not_computed: notComputed, waived };
}

/** Aggregate several verdicts with the same precedence as a single batch. Nothing gated is incomplete. */
export function aggregateVerdict(verdicts: readonly GateVerdict[]): GateVerdict {
  if (verdicts.length === 0) return "incomplete";
  for (const v of ["fail", "incomplete", "pass_with_waivers"] as const) {
    if (verdicts.includes(v)) return v;
  }
  return "pass";
}

/** 0 passed (including with explicit waivers), 1 evaluated and failed, 2 could not evaluate. */
export function gateExitCode(verdict: GateVerdict): 0 | 1 | 2 {
  return verdict === "fail" ? 1 : verdict === "incomplete" ? 2 : 0;
}

// ---------------------------------------------------------------- security (adversarial)

/**
 * The adversarial side of the gate, kept apart from the consistency verdict on purpose
 * (ARCHITECTURE.md section 8: a security finding needs a different owner and queue than a
 * flaky test).
 *
 * pass        every gated payload's propagation rate is within its max_propagation_rate
 * finding     at least one payload propagated above its max (by default: at all)
 * incomplete  nothing propagated above its max, but at least one payload could not be
 *             evaluated (no exposed run, no batch where one was required, a bad fixture)
 */
export type SecurityVerdict = "pass" | "finding" | "incomplete";

/** Exit code for a security finding. Outranks every consistency outcome. */
export const SECURITY_FINDING_EXIT_CODE = 3;

/** Aggregate per-payload verdicts: finding > incomplete > pass. Null: nothing was gated. */
export function aggregateSecurityVerdict(verdicts: readonly SecurityVerdict[]): SecurityVerdict | null {
  if (verdicts.length === 0) return null;
  if (verdicts.includes("finding")) return "finding";
  if (verdicts.includes("incomplete")) return "incomplete";
  return "pass";
}

/**
 * One exit code for both sections.
 *
 *   3  security finding (whatever the consistency verdict; the report carries both)
 *   1  consistency failed
 *   2  something in scope could not be evaluated (either section), or nothing was in scope
 *   0  everything in scope passed (consistency waivers included, as before)
 *
 * A null verdict means that section had nothing in scope (e.g. gating one adversarial batch
 * has no consistency part). With both null there was nothing to gate: 2, never a pass.
 */
export function combinedExitCode(consistency: GateVerdict | null, security: SecurityVerdict | null): 0 | 1 | 2 | 3 {
  if (security === "finding") return SECURITY_FINDING_EXIT_CODE;
  if (consistency === "fail") return 1;
  if (consistency === null && security === null) return 2;
  if (consistency === "incomplete" || security === "incomplete") return 2;
  return 0;
}
