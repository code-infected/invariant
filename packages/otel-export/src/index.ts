/**
 * @invariant/otel-export
 *
 * The OTel Exporter component (ARCHITECTURE.md): stored batches, runs, tool calls and
 * scores as OpenTelemetry traces, sent over OTLP to whatever backend a team already runs.
 * Reads the trace store after the fact, so exporting is decoupled from running.
 */
export { planBatchTrace, traceIdForBatch, spanIdFor, type TracePlan, type PlannedSpan, type PlannedEvent, type PlanOptions, type AttrValue } from "./plan.js";
export { emitTraces, createOtlpExporter, tracesUrl, countSpans, DEFAULT_OTLP_ENDPOINT, DEFAULT_SERVICE_NAME, type EmitOptions, type EmitResult } from "./emit.js";
export { INV, GEN_AI, ERROR_TYPE } from "./attributes.js";
export type { SpanExporter } from "@opentelemetry/sdk-trace-base";
