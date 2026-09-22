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
  createAnthropicJudge,
  unavailableJudge,
  missingJudgeKeyMessage,
  buildJudgePrompt,
  parseVote,
  majority,
  DEFAULT_JUDGE_MODEL,
  JUDGE_SYSTEM_PROMPT,
  type AnthropicJudgeOptions,
  type JudgeRetryPolicy,
} from "./judge.js";
export { scoreBatch, verdictFor, type BatchScore, type AxisReport, type Verdict, type BatchRunInput } from "./score-batch.js";
export {
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
