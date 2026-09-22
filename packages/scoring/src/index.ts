/**
 * @invariant/scoring
 *
 * The diff and scoring engine (ARCHITECTURE.md section 4): three independent consistency
 * scores over one batch's run matrix.
 *
 *   state-mutation  exact match of each run's ordered dangerous calls (masked args);
 *                   largest identical group / runs scored.
 *   tool-path       mean pairwise normalised Levenshtein similarity of tool-name sequences.
 *   outcome         judge-decided equivalence of final answers, clustered by connected
 *                   components; largest cluster / runs scored.
 *
 * Plus, for adversarial batches only, injection propagation (propagation.ts): the share
 * of exposed runs in which a planted instruction led to an unauthorized call, and how many
 * calls downstream. Its verdict feeds a separate security section of the gate.
 *
 * Pure functions over plain data; loading runs from the trace store and persisting
 * scores is the caller's job (the CLI's `score` command).
 */
export type { ScoringRun, ScoringToolCall, ScoringTask, Thresholds } from "./types.js";
export { MASKED, maskVolatile, canonicalJson } from "./mask.js";
export {
  scoreStateMutation,
  mutationSignature,
  type StateMutationResult,
  type MutationGroup,
  type MutationCall,
} from "./state-mutation.js";
export {
  scoreToolPath,
  levenshtein,
  pathSimilarity,
  toolPath,
  type ToolPathResult,
  type DistinctPath,
} from "./tool-path.js";
export {
  scoreOutcome,
  outcomeNodes,
  cosineSimilarity,
  JudgeUnavailableError,
  DEFAULT_PREFILTER,
  type OutcomeResult,
  type OutcomeOptions,
  type OutcomeNode,
  type OutcomeCluster,
  type PairDecision,
  type PairVia,
  type JudgeFn,
  type JudgeVerdict,
  type EmbedFn,
  type Vote,
} from "./outcome.js";
export {
  createModelJudge,
  createModelEmbedder,
  unavailableJudge,
  buildJudgePrompt,
  parseVote,
  majority,
  JUDGE_SYSTEM_PROMPT,
  JUDGE_MAX_TOKENS,
  JUDGE_KEY_PURPOSE,
  JUDGE_KEY_CONSEQUENCE,
  type ModelJudgeOptions,
  type ModelJudge,
  type JudgeState,
  type JudgeRetryPolicy,
} from "./judge.js";
export { scoreBatch, verdictFor, type BatchScore, type AxisReport, type Verdict, type BatchRunInput } from "./score-batch.js";
export {
  scorePropagation,
  scoreRunPropagation,
  matchesAction,
  propagationVerdict,
  type ActionMatcher,
  type PropagationSpec,
  type PropagationToolCall,
  type PropagationRunInput,
  type PropagationResult,
  type PropagationVerdict,
  type RunPropagation,
  type Exposure,
} from "./propagation.js";
export {
  aggregateSecurityVerdict,
  combinedExitCode,
  SECURITY_FINDING_EXIT_CODE,
  type SecurityVerdict,
  evaluateGate,
  aggregateVerdict,
  gateExitCode,
  assertWaivable,
  AXES,
  AXIS_LABELS,
  WAIVABLE_AXES,
  type AxisName,
  type AxisGate,
  type AxisGateResult,
  type GateEvaluation,
  type GateVerdict,
} from "./gate.js";
