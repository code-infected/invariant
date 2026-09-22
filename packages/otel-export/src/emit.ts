import { ROOT_CONTEXT, SpanKind, SpanStatusCode, trace, type Context } from "@opentelemetry/api";
import { ExportResultCode, type ExportResult } from "@opentelemetry/core";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BasicTracerProvider, BatchSpanProcessor, type IdGenerator, type ReadableSpan, type SpanExporter } from "@opentelemetry/sdk-trace-base";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";
import type { PlannedSpan, TracePlan } from "./plan.js";

export const DEFAULT_SERVICE_NAME = "invariant";
export const DEFAULT_OTLP_ENDPOINT = "http://localhost:4318";

/**
 * Hands the SDK the ids the plan chose. The SDK asks for a span id on every startSpan and
 * a trace id only for a root span, synchronously, so setting `next` right before each
 * startSpan is exact.
 */
class PlannedIds implements IdGenerator {
  next = { traceId: "", spanId: "" };
  generateTraceId(): string {
    return this.next.traceId;
  }
  generateSpanId(): string {
    return this.next.spanId;
  }
}

/** Remembers every export result, so a failed export is an error here and not only a log line. */
class CheckedExporter implements SpanExporter {
  readonly failures: Error[] = [];
  exported = 0;
  constructor(private readonly inner: SpanExporter) {}
  export(spans: ReadableSpan[], done: (result: ExportResult) => void): void {
    this.inner.export(spans, (result) => {
      if (result.code === ExportResultCode.SUCCESS) this.exported += spans.length;
      else this.failures.push(result.error ?? new Error("span export failed"));
      done(result);
    });
  }
  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }
  forceFlush(): Promise<void> {
    return this.inner.forceFlush?.() ?? Promise.resolve();
  }
}

export interface EmitOptions {
  serviceName?: string;
  serviceVersion?: string;
}

export interface EmitResult {
  traceId: string;
  spans: number;
}

/**
 * Turn planned traces into real SDK spans and export them through `exporter` (an OTLP
 * exporter, or the SDK's InMemorySpanExporter in tests). Start and end times are the
 * plan's recorded ones. Resolves once every span is exported; rejects if any export failed.
 */
export async function emitTraces(plans: TracePlan[], exporter: SpanExporter, options: EmitOptions = {}): Promise<EmitResult[]> {
  const ids = new PlannedIds();
  const checked = new CheckedExporter(exporter);
  const total = plans.reduce((n, p) => n + countSpans(p.root), 0);
  const provider = new BasicTracerProvider({
    idGenerator: ids,
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: options.serviceName ?? DEFAULT_SERVICE_NAME,
      [ATTR_SERVICE_VERSION]: options.serviceVersion ?? "0.1.0",
    }),
    spanProcessors: [new BatchSpanProcessor(checked, { maxExportBatchSize: 512, maxQueueSize: Math.max(2048, total + 1) })],
  });
  const tracer = provider.getTracer("@invariant/otel-export", "0.1.0");

  const emit = (span: PlannedSpan, parent: Context, traceId: string) => {
    ids.next = { traceId, spanId: span.spanId };
    const s = tracer.startSpan(span.name, { kind: SpanKind.INTERNAL, startTime: span.start, attributes: span.attributes }, parent);
    for (const e of span.events) s.addEvent(e.name, e.attributes, e.time);
    if (span.error !== undefined) s.setStatus({ code: SpanStatusCode.ERROR, message: span.error });
    const ctx = trace.setSpan(ROOT_CONTEXT, s);
    for (const child of span.children) emit(child, ctx, traceId);
    s.end(span.end);
  };

  const results: EmitResult[] = [];
  try {
    for (const plan of plans) {
      emit(plan.root, ROOT_CONTEXT, plan.traceId);
      results.push({ traceId: plan.traceId, spans: countSpans(plan.root) });
    }
    // The processor rejects a flush whose export failed; that failure is already recorded.
    await provider.forceFlush().catch(() => undefined);
  } finally {
    await provider.shutdown().catch((err: unknown) => checked.failures.push(err instanceof Error ? err : new Error(String(err))));
  }
  if (checked.failures.length > 0) {
    throw new Error(`OTLP export failed: ${checked.failures.map((f) => f.message).join("; ")}`);
  }
  if (checked.exported !== total) {
    throw new Error(`OTLP export incomplete: ${checked.exported} of ${total} spans were accepted`);
  }
  return results;
}

export function countSpans(span: PlannedSpan): number {
  return 1 + span.children.reduce((n, c) => n + countSpans(c), 0);
}

/**
 * The OTLP/HTTP traces URL for an endpoint. A base endpoint (the OTEL_EXPORTER_OTLP_ENDPOINT
 * convention, e.g. http://localhost:4318) gets /v1/traces appended; a URL that already ends
 * in /v1/traces is used as is.
 */
export function tracesUrl(endpoint: string): string {
  const trimmed = endpoint.trim().replace(/\/+$/, "");
  return /\/v1\/traces$/.test(trimmed) ? trimmed : `${trimmed}/v1/traces`;
}

/**
 * OTLP over HTTP with protobuf bodies (the OTLP default protocol). Extra headers, e.g. an
 * API key for a hosted backend, come from OTEL_EXPORTER_OTLP_HEADERS as usual; the SDK
 * exporter reads that itself.
 */
export function createOtlpExporter(endpoint: string, options: { timeoutMillis?: number } = {}): SpanExporter {
  return new OTLPTraceExporter({ url: tracesUrl(endpoint), timeoutMillis: options.timeoutMillis ?? 10_000 });
}
