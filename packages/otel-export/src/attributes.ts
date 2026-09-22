/**
 * Attribute and event names used on exported spans.
 *
 * invariant.*: the harness's own attributes, named as in internal-docs/TECHNICAL_SPEC.md
 * section 3 (run_id, task, variant_id, trial, tool.name, tool.sandboxed, axis.*,
 * deployment_fingerprint), plus a few more under the same prefix.
 *
 * gen_ai.*: the OpenTelemetry GenAI semantic conventions, where one fits. They are
 * still experimental (and have moved to their own repository), so, as the
 * @opentelemetry/semantic-conventions package itself recommends for incubating names,
 * they are copied here as strings instead of imported from its unstable entry point.
 */
export const INV = {
  RUN_ID: "invariant.run_id",
  TASK: "invariant.task",
  VARIANT_ID: "invariant.variant_id",
  VARIANT_LABEL: "invariant.variant_label",
  TRIAL: "invariant.trial",
  ATTEMPT: "invariant.attempt",
  SUPERSEDED: "invariant.superseded",
  RUN_STATUS: "invariant.run.status",
  STOP_REASON: "invariant.run.stop_reason",
  LATENCY_MS: "invariant.run.latency_ms",
  PROMPT: "invariant.run.prompt",
  FINAL_OUTPUT: "invariant.run.final_output",
  TIMING_SOURCE: "invariant.run.timing_source",
  SYNTHETIC: "invariant.synthetic",
  DEPLOYMENT_FINGERPRINT: "invariant.deployment_fingerprint",
  DEPLOYMENT_FINGERPRINTS: "invariant.deployment_fingerprints",
  DEPLOYMENT_MIXED: "invariant.deployment.mixed",
  TOOL_NAME: "invariant.tool.name",
  TOOL_SANDBOXED: "invariant.tool.sandboxed",
  TOOL_SEQUENCE: "invariant.tool.sequence_index",
  TOOL_TIMING: "invariant.tool.timing",
  BATCH_ID: "invariant.batch_id",
  TIER: "invariant.tier",
  TRIALS_PER_VARIANT: "invariant.trials_per_variant",
  VARIANTS: "invariant.variants",
  VARIANTS_REQUESTED: "invariant.variants_requested",
  RUNS_IN_MATRIX: "invariant.runs.matrix",
  RUNS_EXPORTED: "invariant.runs.exported",
  SCORE_STATUS: "invariant.score.status",
  SCORE_ID: "invariant.score.id",
  SCORE_COMPUTED_AT: "invariant.score.computed_at",
  RUNS_SCORED: "invariant.score.runs_scored",
  GATE_VERDICT: "invariant.gate.verdict",
  THRESHOLDS_SOURCE: "invariant.thresholds.source",
  /** invariant.axis.<axis> is the score; these suffixes hang off it. */
  axis: (axis: string) => `invariant.axis.${axis}`,
  axisThreshold: (axis: string) => `invariant.axis.${axis}.threshold`,
  axisResult: (axis: string) => `invariant.axis.${axis}.result`,
} as const;

export const GEN_AI = {
  OPERATION_NAME: "gen_ai.operation.name",
  PROVIDER_NAME: "gen_ai.provider.name",
  REQUEST_MODEL: "gen_ai.request.model",
  RESPONSE_MODEL: "gen_ai.response.model",
  USAGE_INPUT_TOKENS: "gen_ai.usage.input_tokens",
  USAGE_OUTPUT_TOKENS: "gen_ai.usage.output_tokens",
  TOOL_NAME: "gen_ai.tool.name",
  TOOL_TYPE: "gen_ai.tool.type",
  TOOL_CALL_ID: "gen_ai.tool.call.id",
  TOOL_CALL_ARGUMENTS: "gen_ai.tool.call.arguments",
  TOOL_CALL_RESULT: "gen_ai.tool.call.result",
  EVALUATION_NAME: "gen_ai.evaluation.name",
  EVALUATION_SCORE_VALUE: "gen_ai.evaluation.score.value",
  EVALUATION_SCORE_LABEL: "gen_ai.evaluation.score.label",
  EVALUATION_EXPLANATION: "gen_ai.evaluation.explanation",
  /** Event name for one evaluation result. */
  EVALUATION_RESULT_EVENT: "gen_ai.evaluation.result",
  OP_INVOKE_AGENT: "invoke_agent",
  OP_EXECUTE_TOOL: "execute_tool",
  PROVIDER_ANTHROPIC: "anthropic",
} as const;

/** Stable (not incubating) general attribute, per the OTel spec. */
export const ERROR_TYPE = "error.type";
