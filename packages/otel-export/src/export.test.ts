/**
 * The span mapping, checked on real SDK spans captured by the SDK's InMemorySpanExporter.
 *
 * The store is a real (temporary) trace store with hand-written rows, SYNTHETIC like every
 * fixture in this repo: what is tested is how a stored batch becomes a trace, not any
 * agent's behaviour.
 */
import test, { describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SpanStatusCode } from "@opentelemetry/api";
import { ExportResultCode, hrTimeToMilliseconds } from "@opentelemetry/core";
import { InMemorySpanExporter, type ReadableSpan, type SpanExporter } from "@opentelemetry/sdk-trace-base";
import { computeDeploymentFingerprint, openTraceStore, type TraceStore } from "@invariant/trace-store";
import { emitTraces, planBatchTrace, traceIdForBatch, tracesUrl } from "./index.js";

const THRESHOLDS = { outcome_consistency_min: 0.9, tool_path_consistency_min: 0.75, state_mutation_consistency: 1 };
const t0 = Date.parse("2026-09-20T10:00:00.000Z");
const iso = (offsetMs: number) => new Date(t0 + offsetMs).toISOString();

const fp = computeDeploymentFingerprint({
  model_name: "claude-sonnet-4-5",
  model_version: "scripted-stand-in (NOT a model)",
  system_prompt: "p",
  tool_schema: [{ name: "process_refund" }],
});

interface Fixture {
  batchId: string;
  unscoredBatchId: string;
  runIds: string[];
}

/** Three cells: an ok run that refunds (sandboxed), an ok run that declines, and an infra failure retried into an ok run. */
function writeFixture(store: TraceStore): Fixture {
  const taskId = store.upsertTask({ name: "refund-duplicate-check", prompt_template: "p", success_rubric: "r", thresholds: THRESHOLDS });
  const variantId = store.upsertVariant({ task_id: taskId, label: "v1", phrasing_text: "Refund order #1234.", fixture_version: 1 });
  const batchId = store.createBatch({ task_id: taskId, tier: "smoke", trials_per_variant: 3, variants_requested: 1, variant_labels: ["v1"] });
  store.recordDeploymentFingerprint(fp);
  const runIds: string[] = [];

  const cell = (trial: number, attempt: number, startMs: number, calls: Array<[string, boolean]>, status: "ok" | "infra_error", output: string | null) => {
    const runId = store.recordRun({ task_id: taskId, variant_id: variantId, trial_number: trial, batch_id: batchId, attempt });
    runIds.push(runId);
    if (status === "ok") store.setRunFingerprint(runId, fp.hash);
    calls.forEach(([name, sandboxed], i) =>
      store.recordToolCall({
        run_id: runId,
        sequence_index: i,
        tool_name: name,
        args: { order_id: "1234" },
        response: sandboxed ? { status: "sandboxed" } : { status: "ok" },
        is_sandboxed: sandboxed,
        called_at: iso(startMs + 100 * (i + 1)),
      })
    );
    const ref = store.writeRawTrace(runId, {
      model: "claude-sonnet-4-5",
      model_versions_seen: status === "ok" ? ["scripted-stand-in (NOT a model)"] : [],
      stop_reason: status === "ok" ? "reply_to_user" : "error",
      error: status === "ok" ? null : { kind: "provider", message: "HTTP 529 overloaded" },
      started_at: iso(startMs),
      finished_at: iso(startMs + 1000),
      usage: { input_tokens: 120, output_tokens: 30 },
      messages: [
        { role: "user", content: "Refund order #1234." },
        ...calls.map(([name], i) => ({ role: "assistant", content: [{ type: "tool_use", id: `toolu_${trial}_${attempt}_${i}`, name, input: {} }] })),
      ],
    });
    store.completeRun({ run_id: runId, status, final_output: output, latency_ms: 1000, token_cost: 150, trace_blob_ref: ref });
    return runId;
  };

  cell(1, 1, 0, [["lookup_order", false], ["process_refund", true], ["reply_to_user", false]], "ok", "Refunded.");
  cell(2, 1, 2000, [["lookup_order", false], ["check_refund_history", false], ["reply_to_user", false]], "ok", "Already refunded.");
  const failed = cell(3, 1, 4000, [], "infra_error", null);
  store.markSuperseded(failed);
  cell(3, 2, 6000, [["lookup_order", false], ["check_refund_history", false], ["reply_to_user", false]], "ok", "Already refunded.");
  store.finishBatch(batchId);
  store.recordScore({
    task_id: taskId,
    evaluation_batch_id: batchId,
    outcome_consistency: null,
    tool_path_consistency: 0.8,
    state_mutation_consistency: 2 / 3,
    runs_scored: 3,
    details: { runs_in_batch: 3, outcome: { error: "ANTHROPIC_API_KEY is not set." } },
  });

  const unscoredBatchId = store.createBatch({ task_id: taskId, tier: "smoke", trials_per_variant: 1, variants_requested: 1, variant_labels: ["v1"] });
  store.finishBatch(unscoredBatchId);
  return { batchId, unscoredBatchId, runIds };
}

/** emitTraces shuts its exporter down, which empties an InMemorySpanExporter; keep the spans for the assertions. */
class KeepSpans extends InMemorySpanExporter {
  override shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

describe("OTel span mapping (SYNTHETIC hand-written store)", () => {
  let dir: string;
  let store: TraceStore;
  let fx: Fixture;
  let spans: ReadableSpan[];

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "invariant-otel-test-"));
    store = openTraceStore({ root: dir });
    fx = writeFixture(store);
    const exporter = new KeepSpans();
    await emitTraces([planBatchTrace(store, fx.batchId)], exporter);
    spans = exporter.getFinishedSpans();
  });
  after(() => {
    store?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const attr = (s: ReadableSpan, k: string) => s.attributes[k];
  const byName = (name: string) => spans.filter((s) => s.name === name);
  const parentOf = (s: ReadableSpan) => s.parentSpanContext?.spanId;

  test("one trace per batch: batch span, a span per run (retried attempt included), a child span per tool call", () => {
    const traceIds = new Set(spans.map((s) => s.spanContext().traceId));
    assert.deepEqual([...traceIds], [fx.batchId.replace(/-/g, "")]);
    assert.equal(traceIdForBatch(fx.batchId), fx.batchId.replace(/-/g, ""));
    const [root, ...rest] = byName("invariant.batch");
    assert.ok(root && rest.length === 0);
    assert.equal(parentOf(root), undefined);
    const runs = byName("invoke_agent");
    assert.equal(runs.length, 4);
    assert.ok(runs.every((r) => parentOf(r) === root.spanContext().spanId));
    const tools = spans.filter((s) => s.name.startsWith("execute_tool "));
    assert.equal(tools.length, 9);
    assert.equal(spans.length, 1 + 4 + 9);
    for (const t of tools) {
      const run = runs.find((r) => r.spanContext().spanId === parentOf(t))!;
      assert.equal(attr(t, "invariant.run_id"), attr(run, "invariant.run_id"));
    }
    assert.deepEqual(new Set(tools.map((t) => t.name)), new Set(["execute_tool lookup_order", "execute_tool process_refund", "execute_tool check_refund_history", "execute_tool reply_to_user"]));
  });

  test("timestamps are the recorded ones, not export time", () => {
    const ms = (s: ReadableSpan) => [hrTimeToMilliseconds(s.startTime), hrTimeToMilliseconds(s.endTime)];
    const run1 = byName("invoke_agent").find((r) => attr(r, "invariant.trial") === 1)!;
    assert.deepEqual(ms(run1), [t0, t0 + 1000]);
    const refund = byName("execute_tool process_refund")[0]!;
    assert.deepEqual(ms(refund), [t0 + 200, t0 + 200]);
    assert.equal(attr(refund, "invariant.tool.timing"), "start_only");
    const root = byName("invariant.batch")[0]!;
    assert.equal(hrTimeToMilliseconds(root.startTime), t0);
    // The batch ends when it was recorded as finished, which is after the runs.
    assert.ok(hrTimeToMilliseconds(root.endTime) >= t0 + 7000);
  });

  test("run and tool spans carry the TECHNICAL_SPEC section 3 attributes and GenAI semantic conventions", () => {
    const run1 = byName("invoke_agent").find((r) => attr(r, "invariant.trial") === 1)!;
    assert.equal(attr(run1, "invariant.task"), "refund-duplicate-check");
    assert.equal(attr(run1, "invariant.run_id"), fx.runIds[0]);
    assert.equal(typeof attr(run1, "invariant.variant_id"), "string");
    assert.equal(attr(run1, "invariant.variant_label"), "v1");
    assert.equal(attr(run1, "invariant.deployment_fingerprint"), fp.hash);
    assert.equal(attr(run1, "gen_ai.operation.name"), "invoke_agent");
    assert.equal(attr(run1, "gen_ai.request.model"), "claude-sonnet-4-5");
    assert.equal(attr(run1, "gen_ai.response.model"), "scripted-stand-in (NOT a model)");
    assert.equal(attr(run1, "gen_ai.usage.input_tokens"), 120);
    assert.equal(attr(run1, "gen_ai.usage.output_tokens"), 30);
    assert.equal(attr(run1, "invariant.run.final_output"), "Refunded.");
    // A scripted stand-in is labelled synthetic and never credited to a provider.
    assert.equal(attr(run1, "invariant.synthetic"), true);
    assert.equal(attr(run1, "gen_ai.provider.name"), undefined);

    const refund = byName("execute_tool process_refund")[0]!;
    assert.equal(attr(refund, "invariant.tool.name"), "process_refund");
    assert.equal(attr(refund, "gen_ai.tool.name"), "process_refund");
    assert.equal(attr(refund, "gen_ai.operation.name"), "execute_tool");
    assert.equal(attr(refund, "invariant.tool.sandboxed"), true);
    assert.equal(attr(refund, "gen_ai.tool.call.id"), "toolu_1_1_1");
    assert.equal(attr(refund, "gen_ai.tool.call.arguments"), '{"order_id":"1234"}');
    assert.equal(attr(refund, "gen_ai.tool.call.result"), '{"status":"sandboxed"}');
    const others = spans.filter((s) => s.name.startsWith("execute_tool ") && s !== refund);
    assert.ok(others.every((s) => attr(s, "invariant.tool.sandboxed") === false));
  });

  test("the infra failure is an ERROR span marked superseded; its retry is a normal run", () => {
    const trial3 = byName("invoke_agent").filter((r) => attr(r, "invariant.trial") === 3);
    const failed = trial3.find((r) => attr(r, "invariant.attempt") === 1)!;
    assert.equal(failed.status.code, SpanStatusCode.ERROR);
    assert.equal(failed.status.message, "HTTP 529 overloaded");
    assert.equal(attr(failed, "error.type"), "provider");
    assert.equal(attr(failed, "invariant.superseded"), true);
    const retry = trial3.find((r) => attr(r, "invariant.attempt") === 2)!;
    assert.equal(retry.status.code, SpanStatusCode.UNSET);
    assert.equal(attr(retry, "invariant.superseded"), false);
  });

  test("scores: axis attributes on the batch span and one gen_ai.evaluation.result event per axis at computed_at", () => {
    const root = byName("invariant.batch")[0]!;
    const score = store.getScores(fx.batchId)[0]!;
    assert.equal(attr(root, "invariant.axis.state_mutation"), 2 / 3);
    assert.equal(attr(root, "invariant.axis.tool_path"), 0.8);
    assert.equal(attr(root, "invariant.axis.outcome"), undefined);
    assert.equal(attr(root, "invariant.axis.state_mutation.result"), "fail");
    assert.equal(attr(root, "invariant.axis.tool_path.result"), "pass");
    assert.equal(attr(root, "invariant.axis.outcome.result"), "not_computed");
    assert.equal(attr(root, "invariant.gate.verdict"), "fail");
    assert.equal(attr(root, "invariant.thresholds.source"), "copy stored with the task");
    assert.equal(attr(root, "invariant.runs.matrix"), 3);
    assert.equal(attr(root, "invariant.runs.exported"), 4);
    assert.equal(attr(root, "invariant.score.id"), score.id);
    assert.deepEqual(
      root.events.map((e) => [e.name, e.attributes!["gen_ai.evaluation.name"], e.attributes!["gen_ai.evaluation.score.label"]]),
      [
        ["gen_ai.evaluation.result", "invariant.axis.state_mutation", "fail"],
        ["gen_ai.evaluation.result", "invariant.axis.tool_path", "pass"],
        ["gen_ai.evaluation.result", "invariant.axis.outcome", "not_computed"],
      ]
    );
    assert.ok(root.events.every((e) => hrTimeToMilliseconds(e.time) === Date.parse(score.computed_at)));
    assert.equal(root.events[2]!.attributes!["gen_ai.evaluation.explanation"], "ANTHROPIC_API_KEY is not set.");
    assert.equal(root.events[2]!.attributes!["gen_ai.evaluation.score.value"], undefined);
  });

  test("an unscored batch says so and carries no axis values; ids are stable across exports", async () => {
    const plan = planBatchTrace(store, fx.unscoredBatchId);
    assert.equal(plan.root.attributes["invariant.score.status"], "not_scored");
    assert.equal(plan.root.events.length, 0);
    assert.equal(plan.score, null);
    const again = planBatchTrace(store, fx.batchId);
    const first = planBatchTrace(store, fx.batchId);
    assert.deepEqual(JSON.stringify(first), JSON.stringify(again));
    // Current thresholds from the caller win over the stored copy.
    const lenient = planBatchTrace(store, fx.batchId, { thresholds: { thresholds: { ...THRESHOLDS, state_mutation_consistency: 0.5 }, source: "tasks/x.yaml" } });
    assert.equal(lenient.root.attributes["invariant.axis.state_mutation.result"], "pass");
    assert.equal(lenient.root.attributes["invariant.thresholds.source"], "tasks/x.yaml");
    assert.throws(() => planBatchTrace(store, "no-such-batch"), /no batch with id/);
  });

  test("a failed export is an error, not a silent log line", async () => {
    const failing: SpanExporter = {
      export: (_spans, done) => done({ code: ExportResultCode.FAILED, error: new Error("connection refused") }),
      shutdown: async () => {},
    };
    await assert.rejects(emitTraces([planBatchTrace(store, fx.batchId)], failing), /OTLP export failed: connection refused/);
  });

  test("OTLP endpoint: a base URL gets /v1/traces, a full traces URL is kept", () => {
    assert.equal(tracesUrl("http://localhost:4318"), "http://localhost:4318/v1/traces");
    assert.equal(tracesUrl("http://localhost:4318/"), "http://localhost:4318/v1/traces");
    assert.equal(tracesUrl("https://api.example/otlp/v1/traces"), "https://api.example/otlp/v1/traces");
  });
});
