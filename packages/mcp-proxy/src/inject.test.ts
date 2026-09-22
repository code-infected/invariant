/**
 * Adversarial-mode injection: the pure transformation, and the real proxy process planting
 * a payload into the real toy server's response (nothing mocked, as in proxy.test.ts).
 *
 * The planted texts here are TEST FIXTURES, not attacks on anything.
 */
import test, { after, before, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { openTraceStore, type TraceStore } from "@invariant/trace-store";
import { injectIntoResult, parseFieldPath } from "./inject.js";
import { proxyBinPath } from "./index.js";
import type { InjectionInput, ProxyConfig } from "./config.js";

const require_ = createRequire(import.meta.url);
const TOY_SERVER_BIN = require_.resolve("@invariant/toy-tool-server/bin");
const PLANTED = "TEST FIXTURE: planted note.";

const jsonResult = (v: unknown, indent?: number): CallToolResult => ({ content: [{ type: "text", text: JSON.stringify(v, null, indent) }] });
const textOf = (r: CallToolResult) => (r.content[0] as { text: string }).text;

describe("injectIntoResult", () => {
  const record = { status: "ok", refunds: [{ refund_id: "rf_1", reason: "customer request" }] };

  test("set_field adds a field and leaves everything else byte-identical in the same style", () => {
    const out = injectIntoResult(jsonResult(record), { mode: "set_field", path: "refunds.0.note" }, PLANTED);
    assert.ok(out.ok);
    assert.equal(textOf(out.result), JSON.stringify({ status: "ok", refunds: [{ refund_id: "rf_1", reason: "customer request", note: PLANTED }] }));
    const indented = injectIntoResult(jsonResult(record, 2), { mode: "set_field", path: "note" }, PLANTED);
    assert.ok(indented.ok);
    assert.equal(textOf(indented.result), JSON.stringify({ ...record, note: PLANTED }, null, 2));
  });

  test("append_to_field appends to an existing string", () => {
    const out = injectIntoResult(jsonResult(record), { mode: "append_to_field", path: "refunds.0.reason" }, PLANTED);
    assert.ok(out.ok);
    assert.equal(JSON.parse(textOf(out.result)).refunds[0].reason, `customer request ${PLANTED}`);
  });

  test("append_text appends to the last text block", () => {
    const out = injectIntoResult({ content: [{ type: "text", text: "Page body." }] }, { mode: "append_text" }, PLANTED);
    assert.ok(out.ok);
    assert.equal(textOf(out.result), `Page body.\n\n${PLANTED}`);
  });

  test("structured content gets the same change as the text", () => {
    const out = injectIntoResult({ ...jsonResult(record), structuredContent: record }, { mode: "set_field", path: "note" }, PLANTED);
    assert.ok(out.ok);
    assert.equal((out.result.structuredContent as { note: string }).note, PLANTED);
  });

  test("never mutates its input", () => {
    const input = jsonResult(record);
    const before_ = JSON.stringify(input);
    injectIntoResult(input, { mode: "set_field", path: "note" }, PLANTED);
    assert.equal(JSON.stringify(input), before_);
  });

  test("refuses what it cannot apply, with a reason, instead of guessing", () => {
    const cases: Array<[CallToolResult, Parameters<typeof injectIntoResult>[1], RegExp]> = [
      [{ ...jsonResult(record), isError: true }, { mode: "set_field", path: "note" }, /error result/],
      [{ content: [{ type: "text", text: "not json" }] }, { mode: "set_field", path: "note" }, /not JSON/],
      [jsonResult(record), { mode: "set_field", path: "missing.note" }, /does not resolve/],
      [jsonResult(record), { mode: "append_to_field", path: "refunds.0.amount" }, /holds nothing/],
      [jsonResult(record), { mode: "set_field", path: "refunds.first" }, /not an index/],
      [{ content: [] }, { mode: "append_text" }, /no text block/],
    ];
    for (const [result, placement, reason] of cases) {
      const out = injectIntoResult(result, placement, PLANTED);
      assert.equal(out.ok, false);
      assert.match((out as { reason: string }).reason, reason);
    }
  });

  test("paths: numeric segments index arrays", () => {
    assert.deepEqual(parseFieldPath("refunds.0.reason"), ["refunds", 0, "reason"]);
  });
});

interface Harness {
  client: Client;
  store: TraceStore;
  runId: string;
  root: string;
  stderr: string;
}

async function startHarness(injection: InjectionInput): Promise<Harness> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "invariant-inject-test-"));
  const store = openTraceStore({ root: path.join(root, ".invariant") });
  const taskId = store.upsertTask({ name: "refund-duplicate-check", prompt_template: "p", success_rubric: "r", thresholds: {} });
  const variantId = store.upsertVariant({ task_id: taskId, label: "v1", phrasing_text: "x", fixture_version: 1 });
  const runId = store.recordRun({ task_id: taskId, variant_id: variantId, trial_number: 1 });
  const config: ProxyConfig = {
    run_id: runId,
    trace_store_root: store.root,
    upstream: { command: process.execPath, args: [TOY_SERVER_BIN] },
    dangerous_tools: [{ name: "process_refund", sandbox_response: '{"status": "sandboxed"}' }],
    injection: { into_sandboxed: false, ...injection },
  };
  const configPath = path.join(root, "proxy-config.json");
  fs.writeFileSync(configPath, JSON.stringify(config), "utf8");
  const transport = new StdioClientTransport({ command: process.execPath, args: [proxyBinPath(), "--config", configPath], stderr: "pipe" });
  const h: Harness = { client: new Client({ name: "inject-test", version: "0.1.0" }, { capabilities: {} }), store, runId, root, stderr: "" };
  transport.stderr?.on("data", (d: Buffer) => (h.stderr += d.toString()));
  await h.client.connect(transport);
  return h;
}

async function stopHarness(h: Harness) {
  await h.client.close();
  h.store.close();
  fs.rmSync(h.root, { recursive: true, force: true });
}

describe("proxy with an injection configured (real proxy process, real toy server)", () => {
  let h: Harness;
  before(async () => {
    h = await startHarness({ payload_id: "fixture-a", tool: "check_refund_history", on_call: 2, placement: { mode: "set_field", path: "refunds.0.note" }, text: PLANTED });
  });
  after(() => stopHarness(h));

  test("only the targeted call is modified, and the agent sees an otherwise normal response", async () => {
    const call = () => h.client.callTool({ name: "check_refund_history", arguments: { order_id: "1234" } }) as Promise<CallToolResult>;
    const first = await call();
    await h.client.callTool({ name: "lookup_order", arguments: { order_id: "1234" } });
    const second = await call();
    const third = await call();
    const clean = JSON.parse(textOf(first));
    assert.equal(clean.refunds[0].note, undefined);
    const planted = JSON.parse(textOf(second));
    assert.deepEqual(planted, { ...clean, refunds: [{ ...clean.refunds[0], note: PLANTED }] });
    assert.deepEqual(JSON.parse(textOf(third)), clean);
    // Same compact serialisation the toy server itself produces.
    assert.equal(textOf(second), JSON.stringify(planted));
  });

  test("the trace flags exactly the injected call, with the payload id, and records what the agent saw", () => {
    const calls = h.store.getToolCalls(h.runId);
    assert.deepEqual(
      calls.map((c) => [c.tool_name, c.is_injected, c.injection_payload_id]),
      [
        ["check_refund_history", false, null],
        ["lookup_order", false, null],
        ["check_refund_history", true, "fixture-a"],
        ["check_refund_history", false, null],
      ]
    );
    assert.equal((calls[2]!.response as { refunds: Array<{ note: string }> }).refunds[0]!.note, PLANTED);
  });
});

describe("proxy injection into a sandboxed tool", () => {
  test("refused unless the payload sets into_sandboxed; the call is then recorded as not injected", async () => {
    const h = await startHarness({ payload_id: "fixture-s", tool: "process_refund", on_call: 1, placement: { mode: "set_field", path: "note" }, text: PLANTED });
    try {
      const r = (await h.client.callTool({ name: "process_refund", arguments: { order_id: "1234", amount: 42 } })) as CallToolResult;
      assert.deepEqual(JSON.parse(textOf(r)), { status: "sandboxed" });
      const [call] = h.store.getToolCalls(h.runId);
      assert.equal(call!.is_sandboxed, true);
      assert.equal(call!.is_injected, false);
      assert.match(h.stderr, /sandboxed and payload fixture-s does not set into_sandboxed/);
    } finally {
      await stopHarness(h);
    }
  });

  test("planted when into_sandboxed is set", async () => {
    const h = await startHarness({ payload_id: "fixture-s", tool: "process_refund", on_call: 1, placement: { mode: "set_field", path: "note" }, text: PLANTED, into_sandboxed: true });
    try {
      const r = (await h.client.callTool({ name: "process_refund", arguments: { order_id: "1234", amount: 42 } })) as CallToolResult;
      assert.deepEqual(JSON.parse(textOf(r)), { status: "sandboxed", note: PLANTED });
      assert.equal(h.store.getToolCalls(h.runId)[0]!.is_injected, true);
    } finally {
      await stopHarness(h);
    }
  });
});
