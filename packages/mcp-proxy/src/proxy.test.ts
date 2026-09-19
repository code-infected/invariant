/**
 * End-to-end tests for the proxy: a real MCP client talks to the real proxy process,
 * which talks to the real toy tool server, and everything lands in a real trace store.
 * Nothing here is mocked, because what is being tested is precisely the wiring.
 *
 * Run with: npm test -w @invariant/mcp-proxy  (after a build)
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
import { normalizeToolResponse } from "./proxy.js";
import { proxyBinPath } from "./index.js";
import type { ProxyConfig } from "./config.js";

const require_ = createRequire(import.meta.url);
const TOY_SERVER_BIN = require_.resolve("@invariant/toy-tool-server/bin");

const SANDBOX_RESPONSE = '{"status": "sandboxed", "refund_id": "sandbox-0001"}';

interface Harness {
  client: Client;
  store: TraceStore;
  runId: string;
  sideEffectLog: string;
  root: string;
}

async function startHarness(): Promise<Harness> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "invariant-proxy-test-"));
  const sideEffectLog = path.join(root, "side-effects.log");
  const store = openTraceStore({ root: path.join(root, ".invariant") });

  const taskId = store.upsertTask({
    name: "refund-duplicate-check",
    prompt_template: "Refund order #{{order_id}}.",
    success_rubric: "test fixture",
    thresholds: { outcome_consistency_min: 0.9 },
  });
  const variantId = store.upsertVariant({
    task_id: taskId,
    label: "v1",
    phrasing_text: "Refund order #1234.",
    fixture_version: 1,
  });
  const runId = store.recordRun({ task_id: taskId, variant_id: variantId, trial_number: 1 });

  const config: ProxyConfig = {
    run_id: runId,
    trace_store_root: store.root,
    upstream: {
      command: process.execPath,
      args: [TOY_SERVER_BIN],
      env: { INVARIANT_TOY_SIDE_EFFECT_LOG: sideEffectLog },
    },
    dangerous_tools: [{ name: "process_refund", sandbox_response: SANDBOX_RESPONSE }],
  };
  const configPath = path.join(root, "proxy-config.json");
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf8");

  const client = new Client({ name: "invariant-proxy-test", version: "0.1.0" }, { capabilities: {} });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [proxyBinPath(), "--config", configPath],
      stderr: "ignore",
    })
  );

  return { client, store, runId, sideEffectLog, root };
}

function textOf(result: CallToolResult): string {
  const block = (result.content ?? [])[0];
  return block && block.type === "text" ? (block as { text: string }).text : "";
}

function sideEffects(logPath: string): string[] {
  if (!fs.existsSync(logPath)) return [];
  return fs.readFileSync(logPath, "utf8").split("\n").filter(Boolean);
}

describe("mcp proxy", () => {
  let h: Harness;

  before(async () => {
    h = await startHarness();
  });

  after(async () => {
    await h.client.close();
    h.store.close();
    fs.rmSync(h.root, { recursive: true, force: true });
  });

  test("republishes the upstream tool list verbatim", async () => {
    const upstream = new Client({ name: "direct", version: "0.1.0" }, { capabilities: {} });
    await upstream.connect(
      new StdioClientTransport({ command: process.execPath, args: [TOY_SERVER_BIN], stderr: "ignore" })
    );
    const direct = await upstream.listTools();
    await upstream.close();

    const throughProxy = await h.client.listTools();
    assert.deepEqual(
      throughProxy.tools.map((t) => t.name).sort(),
      ["check_refund_history", "lookup_order", "process_refund", "reply_to_user"]
    );
    // Byte-for-byte: the agent has to see exactly the schemas the real server publishes,
    // since the tool schema is part of what the run is being measured against.
    assert.deepEqual(throughProxy.tools, direct.tools);
  });

  test("forwards a safe tool call upstream and relays the real response", async () => {
    const result = (await h.client.callTool({
      name: "check_refund_history",
      arguments: { order_id: "1234" },
    })) as CallToolResult;

    const payload = JSON.parse(textOf(result));
    assert.equal(payload.already_refunded, true);
    assert.equal(payload.refunds[0].refund_id, "rf_9981");
  });

  test("intercepts a dangerous tool, returns the sandbox response, and never reaches upstream", async () => {
    const before_ = sideEffects(h.sideEffectLog);
    const result = (await h.client.callTool({
      name: "process_refund",
      arguments: { order_id: "1234", amount: 42.0, reason: "duplicate" },
    })) as CallToolResult;

    assert.equal(textOf(result), SANDBOX_RESPONSE);
    // The toy server logs every refund it actually executes. Nothing new in that log is
    // the only real proof the call was stopped rather than merely answered.
    assert.deepEqual(sideEffects(h.sideEffectLog), before_);
    assert.equal(
      sideEffects(h.sideEffectLog).some((line) => line.includes("process_refund")),
      false
    );
  });

  test("records an upstream error as a tool call instead of dropping it", async () => {
    const result = (await h.client.callTool({
      name: "no_such_tool",
      arguments: {},
    })) as CallToolResult;
    assert.equal(result.isError, true);
  });

  test("writes every call to the trace store, in order, with the right sandbox flags", () => {
    const calls = h.store.getToolCalls(h.runId);
    assert.deepEqual(
      calls.map((c) => c.tool_name),
      ["check_refund_history", "process_refund", "no_such_tool"]
    );
    assert.deepEqual(
      calls.map((c) => c.sequence_index),
      [0, 1, 2]
    );
    assert.deepEqual(
      calls.map((c) => c.is_sandboxed),
      [false, true, false]
    );

    const forwarded = calls[0]!;
    assert.deepEqual(forwarded.args, { order_id: "1234" });
    assert.equal((forwarded.response as { already_refunded: boolean }).already_refunded, true);
    assert.ok(!Number.isNaN(Date.parse(forwarded.timestamp)));

    const sandboxed = calls[1]!;
    assert.deepEqual(sandboxed.args, { order_id: "1234", amount: 42.0, reason: "duplicate" });
    assert.deepEqual(sandboxed.response, { status: "sandboxed", refund_id: "sandbox-0001" });

    const failed = calls[2]!;
    assert.equal((failed.response as { isError?: boolean }).isError, true);
  });
});

describe("normalizeToolResponse", () => {
  test("unwraps a single JSON text block into the payload the trace schema records", () => {
    assert.deepEqual(normalizeToolResponse({ content: [{ type: "text", text: '{"a":1}' }] }), { a: 1 });
  });

  test("keeps non-JSON text as text", () => {
    assert.equal(normalizeToolResponse({ content: [{ type: "text", text: "plain" }] }), "plain");
  });

  test("keeps the whole envelope for error results, so isError survives", () => {
    const result = { content: [{ type: "text" as const, text: '{"a":1}' }], isError: true };
    assert.deepEqual(normalizeToolResponse(result), result);
  });

  test("prefers structuredContent when the server provides it", () => {
    assert.deepEqual(
      normalizeToolResponse({ content: [{ type: "text", text: "ignored" }], structuredContent: { b: 2 } }),
      { b: 2 }
    );
  });
});
