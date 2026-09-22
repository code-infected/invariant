import { openTraceStore, type BatchRow, type TraceStore } from "@invariant/trace-store";
import {
  createOtlpExporter,
  emitTraces,
  planBatchTrace,
  tracesUrl,
  DEFAULT_SERVICE_NAME,
  type PlannedSpan,
  type SpanExporter,
  type TracePlan,
} from "@invariant/otel-export";
import { loadConfig } from "../lib/config.js";
import { loadValidTask } from "../lib/load-tasks.js";
import { resolveOtelEndpoint } from "../lib/otel.js";
import { INVARIANT_DIR } from "../lib/paths.js";
import type { InvariantConfig } from "../schema/config.js";

export interface ExportOptions {
  /** Export this batch. */
  batch?: string;
  /** Or: this task's latest finished batch. */
  task?: string;
  /** OTLP/HTTP endpoint; see resolveOtelEndpoint for the fallbacks. */
  endpoint?: string;
  /** Print the span tree that would be sent, send nothing. */
  dryRun?: boolean;
  json?: boolean;
}

export interface ExportDeps {
  storeRoot?: string;
  config?: InvariantConfig;
  /** Test seam: replaces the OTLP exporter (e.g. an in-memory one). */
  exporter?: SpanExporter;
  out?: (line: string) => void;
  err?: (line: string) => void;
}

export interface ExportReport {
  endpoint: string | null;
  endpoint_source: string | null;
  dry_run: boolean;
  batches: Array<{
    batch_id: string;
    task: string;
    trace_id: string;
    spans: number;
    runs: number;
    tool_calls: number;
    sandboxed_tool_calls: number;
    score: TracePlan["score"];
  }>;
}

function resolveBatchForExport(store: TraceStore, opts: ExportOptions): BatchRow {
  if ((opts.batch === undefined) === (opts.task === undefined)) {
    throw new Error("pass exactly one of --batch=<batch_id> or --task=<name> (exports that task's latest finished batch).");
  }
  if (opts.batch !== undefined) {
    const batch = store.getBatch(opts.batch);
    if (!batch) throw new Error(`no batch with id ${opts.batch} in the trace store.`);
    if (batch.finished_at === null) {
      throw new Error(`batch ${batch.id} has not finished, so its run matrix may be partial. Refusing to export a partial batch.`);
    }
    return batch;
  }
  const row = store.getTaskByName(opts.task!);
  const batch = row ? store.getLatestBatch(row.id, { finishedOnly: true }) : null;
  if (!batch) throw new Error(`no finished batch for task "${opts.task}" in the trace store.`);
  return batch;
}

/** Plan one stored batch, judged against tasks/<name>.yaml's current thresholds when that spec loads (like the gate). */
export function planForExport(store: TraceStore, batch: BatchRow): TracePlan {
  const name = store.getTask(batch.task_id)?.name;
  let thresholds;
  try {
    if (name) {
      const spec = loadValidTask(name);
      thresholds = { thresholds: spec.spec.thresholds, source: `tasks/${name}.yaml` };
    }
  } catch {
    // No (valid) spec under tasks/: fall back to the copy stored with the task.
  }
  return planBatchTrace(store, batch.id, { thresholds });
}

/** Send already-planned traces; returns where they went. */
export async function sendPlans(
  plans: TracePlan[],
  opts: { endpoint?: string },
  deps: Pick<ExportDeps, "config" | "exporter">
): Promise<{ url: string; source: string }> {
  let config = deps.config ?? null;
  if (!config) {
    try {
      config = loadConfig();
    } catch {
      config = null; // export needs nothing else from the config; the endpoint falls back.
    }
  }
  const { endpoint, source } = resolveOtelEndpoint(opts.endpoint, config);
  const exporter = deps.exporter ?? createOtlpExporter(endpoint);
  await emitTraces(plans, exporter, { serviceName: config?.export?.service_name ?? DEFAULT_SERVICE_NAME });
  return { url: tracesUrl(endpoint), source };
}

export async function runExport(opts: ExportOptions, deps: ExportDeps = {}): Promise<ExportReport> {
  const out = deps.out ?? ((line: string) => console.log(line));
  const err = deps.err ?? ((line: string) => console.error(line));
  const store = openTraceStore({ root: deps.storeRoot ?? INVARIANT_DIR, readonly: true });
  let plan: TracePlan;
  try {
    plan = planForExport(store, resolveBatchForExport(store, opts));
  } finally {
    store.close();
  }

  const report: ExportReport = {
    endpoint: null,
    endpoint_source: null,
    dry_run: Boolean(opts.dryRun),
    batches: [
      {
        batch_id: plan.batchId,
        task: plan.task,
        trace_id: plan.traceId,
        spans: 1 + plan.counts.runs + plan.counts.tool_calls,
        runs: plan.counts.runs,
        tool_calls: plan.counts.tool_calls,
        sandboxed_tool_calls: plan.counts.sandboxed_tool_calls,
        score: plan.score,
      },
    ],
  };

  if (!opts.dryRun) {
    const sent = await sendPlans([plan], opts, deps);
    report.endpoint = sent.url;
    report.endpoint_source = sent.source;
  }

  if (opts.json) {
    out(JSON.stringify(report, null, 2));
  } else {
    const b = report.batches[0]!;
    if (opts.dryRun) {
      out(`dry run: nothing sent. Trace ${b.trace_id} for ${b.task} batch ${b.batch_id}:`);
      for (const line of renderTree(plan.root)) out(`  ${line}`);
    } else {
      out(`exported ${b.task} batch ${b.batch_id}`);
      out(`  trace id     : ${b.trace_id}`);
      out(`  spans        : ${b.spans} (1 batch, ${b.runs} run(s), ${b.tool_calls} tool call(s), ${b.sandboxed_tool_calls} sandboxed)`);
      out(`  endpoint     : ${report.endpoint} (from ${report.endpoint_source})`);
    }
  }
  if (!plan.score) {
    err(`note: batch ${plan.batchId} has no stored score, so no axis results were exported. Run invariant score --batch=${plan.batchId}, then export again.`);
  }
  return report;
}

/** An indented one-line-per-span view of a plan, for --dry-run. */
export function renderTree(span: PlannedSpan, depth = 0): string[] {
  const a = span.attributes;
  const bits: string[] = [];
  if (a["invariant.variant_label"] !== undefined) bits.push(`${a["invariant.variant_label"]} trial ${a["invariant.trial"]} attempt ${a["invariant.attempt"]}`);
  if (a["invariant.tool.sandboxed"] === true) bits.push("SANDBOXED");
  if (span.error) bits.push(`ERROR: ${span.error}`);
  if (a["invariant.gate.verdict"] !== undefined) bits.push(`gate ${a["invariant.gate.verdict"]}`);
  for (const axis of ["state_mutation", "tool_path", "outcome"]) {
    const r = a[`invariant.axis.${axis}.result`];
    if (r !== undefined) bits.push(`${axis}=${a[`invariant.axis.${axis}`] ?? "-"} (${r})`);
  }
  const duration = span.end.getTime() - span.start.getTime();
  const line = `${"  ".repeat(depth)}${span.name}  ${span.start.toISOString()} +${duration}ms${bits.length ? "  " + bits.join(", ") : ""}`;
  return [line, ...span.children.flatMap((c) => renderTree(c, depth + 1))];
}
