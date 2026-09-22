/**
 * Inputs to the scoring engine.
 *
 * Deliberately plain data with no dependency on @invariant/trace-store: the engine scores
 * whatever run matrix it is handed, so the same code serves the SQLite store today, the
 * Postgres store later, and hand-built matrices in tests. The CLI does the mapping.
 */

/** One tool call, as recorded by the proxy (TECHNICAL_SPEC.md section 3), minus what scoring ignores. */
export interface ScoringToolCall {
  tool_name: string;
  args: unknown;
}

/**
 * One cell of a batch's run matrix.
 *
 * Only runs with a behavioural answer are scored: `ok`, and `timeout` (a timeout is its
 * own outcome category, ARCHITECTURE.md section 7). Runs that ended `infra_error` (or are
 * somehow still `running`) have no behavioural answer and are excluded by scoreBatch, the
 * same way the retry policy never lets an infra flake count against consistency.
 */
export interface ScoringRun {
  run_id: string;
  status: "ok" | "timeout";
  final_output: string | null;
  /** In sequence_index order. */
  tool_calls: ScoringToolCall[];
  /** Human handle for reports, e.g. "v1 trial 3". */
  label?: string;
}

export interface Thresholds {
  outcome_consistency_min: number;
  tool_path_consistency_min: number;
  state_mutation_consistency: number;
}

/** The parts of a task spec the scoring engine reads. */
export interface ScoringTask {
  name: string;
  success_rubric: string;
  /** Names of the tools listed under tools.dangerous. */
  dangerous_tools: string[];
  volatile_fields: string[];
  thresholds: Thresholds;
}
