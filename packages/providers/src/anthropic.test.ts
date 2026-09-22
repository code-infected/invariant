/**
 * The Anthropic adapter against a local fake of the Messages API: request shape per the
 * documented wire format (https://docs.anthropic.com/en/api/messages), and realistic
 * responses: text, one tool call, several in one turn, max_tokens, and the error statuses.
 */
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { createModelClient, isTemperatureUnsupported, ProviderError, resolveModel } from "./index.js";
import { queue, startFakeServer, type FakeReply } from "./testing/fake-server.js";
import { SYSTEM, TOOLS, twoCallConversation } from "./testing/fixtures.js";

const ok = (content: unknown[], stop: string, extra: Record<string, unknown> = {}): FakeReply => ({
  headers: { "request-id": "req_011" },
  body: {
    id: "msg_01",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-4-5-20250929",
    content,
    stop_reason: stop,
    stop_sequence: null,
    usage: { input_tokens: 321, output_tokens: 45 },
    ...extra,
  },
});

const err = (status: number, type: string, message: string, headers: Record<string, string> = {}): FakeReply => ({
  status,
  headers,
  body: { type: "error", error: { type, message } },
});

function client(url: string, params?: Record<string, unknown>) {
  return createModelClient(
    resolveModel({ model: "anthropic:claude-sonnet-4-5", base_url: url, ...(params ? { params } : {}) }, { env: { ANTHROPIC_API_KEY: "sk-ant-test" } })
  );
}

describe("anthropic adapter", () => {
  test("request shape: headers, system, tools, tool results; no temperature unless configured", async () => {
    const srv = await startFakeServer(queue(ok([{ type: "text", text: "Done." }], "end_turn")));
    try {
      const res = await client(srv.url).chat({ system: SYSTEM, messages: twoCallConversation(), tools: TOOLS });
      const r = srv.requests[0]!;
      assert.equal(r.method, "POST");
      assert.equal(r.path, "/v1/messages");
      assert.equal(r.headers["x-api-key"], "sk-ant-test");
      assert.equal(r.headers["anthropic-version"], "2023-06-01");
      assert.equal(r.body.model, "claude-sonnet-4-5");
      assert.equal(r.body.max_tokens, 2048, "max_tokens is required by the protocol");
      assert.equal("temperature" in r.body, false);
      assert.equal(r.body.system, SYSTEM);
      assert.deepEqual(r.body.tools[0], { name: "lookup_order", description: "Look up an order.", input_schema: TOOLS[0]!.input_schema });
      assert.deepEqual(r.body.messages[1], {
        role: "assistant",
        content: [
          { type: "text", text: "Checking." },
          { type: "tool_use", id: "call_a", name: "lookup_order", input: { order_id: "1234" } },
          { type: "tool_use", id: "call_b", name: "check_refund_history", input: { order_id: "1234" } },
        ],
      });
      assert.deepEqual(r.body.messages[2], {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "call_a", content: '{"order_id":"1234","amount":42}', is_error: false },
          { type: "tool_result", tool_use_id: "call_b", content: "tool failed: timeout", is_error: true },
        ],
      });
      assert.deepEqual(res.params_sent, { max_tokens: 2048 });
      assert.equal(res.text, "Done.");
      assert.equal(res.stop_reason, "end_turn");
      assert.equal(res.model, "claude-sonnet-4-5-20250929");
      assert.equal(res.request_id, "req_011");
      assert.deepEqual(res.usage, { input_tokens: 321, output_tokens: 45 });
      assert.equal(res.endpoint, srv.host);
    } finally {
      await srv.close();
    }
  });

  test("configured params are mapped and recorded; other keys pass through", async () => {
    const srv = await startFakeServer(queue(ok([{ type: "text", text: "x" }], "end_turn")));
    try {
      const res = await client(srv.url, { temperature: 0.2, max_tokens: 100, stop: ["END"], metadata: { user_id: "u" } }).chat({
        system: "",
        messages: [{ role: "user", content: "hi" }],
        tools: [],
      });
      const b = srv.requests[0]!.body;
      assert.equal(b.temperature, 0.2);
      assert.equal(b.max_tokens, 100);
      assert.deepEqual(b.stop_sequences, ["END"]);
      assert.deepEqual(b.metadata, { user_id: "u" });
      assert.equal("system" in b, false);
      assert.equal("tools" in b, false);
      assert.deepEqual(res.params_sent, { max_tokens: 100, temperature: 0.2, stop: ["END"], metadata: { user_id: "u" } });
    } finally {
      await srv.close();
    }
  });

  test("one tool call, several in one turn (in order), and replay of the native turn", async () => {
    const two = [
      { type: "text", text: "Let me check." },
      { type: "tool_use", id: "toolu_1", name: "lookup_order", input: { order_id: "1234" } },
      { type: "tool_use", id: "toolu_2", name: "check_refund_history", input: { order_id: "1234" } },
    ];
    const srv = await startFakeServer(
      queue(ok([{ type: "tool_use", id: "toolu_0", name: "lookup_order", input: { order_id: "9" } }], "tool_use"), ok(two, "tool_use"), ok([{ type: "text", text: "ok" }], "end_turn"))
    );
    try {
      const c = client(srv.url);
      const one = await c.chat({ system: SYSTEM, messages: [{ role: "user", content: "go" }], tools: TOOLS });
      assert.equal(one.stop_reason, "tool_use");
      assert.deepEqual(one.tool_calls, [{ id: "toolu_0", name: "lookup_order", input: { order_id: "9" } }]);
      const res = await c.chat({ system: SYSTEM, messages: [{ role: "user", content: "go" }], tools: TOOLS });
      assert.deepEqual(res.tool_calls.map((t) => [t.id, t.name]), [["toolu_1", "lookup_order"], ["toolu_2", "check_refund_history"]]);
      assert.equal(res.text, "Let me check.");
      await c.chat({
        system: SYSTEM,
        messages: [{ role: "user", content: "go" }, { role: "assistant", text: res.text, tool_calls: res.tool_calls, native: res.native }],
        tools: TOOLS,
      });
      assert.deepEqual(srv.requests[2]!.body.messages[1], { role: "assistant", content: two });
    } finally {
      await srv.close();
    }
  });

  test("max_tokens stop is normalized, the raw value kept", async () => {
    const srv = await startFakeServer(queue(ok([{ type: "text", text: "trunc" }], "max_tokens")));
    try {
      const res = await client(srv.url).chat({ system: "", messages: [{ role: "user", content: "x" }], tools: [] });
      assert.equal(res.stop_reason, "max_tokens");
      assert.equal(res.raw_stop_reason, "max_tokens");
    } finally {
      await srv.close();
    }
  });

  test("errors: 429 with retry-after and 529/500 are infra; 400/401 rejected, with code", async () => {
    const srv = await startFakeServer(
      queue(
        err(429, "rate_limit_error", "Number of requests has exceeded your rate limit", { "retry-after": "7" }),
        err(529, "overloaded_error", "Overloaded"),
        err(500, "api_error", "Internal server error"),
        err(400, "invalid_request_error", "temperature: range: 0..1"),
        err(401, "authentication_error", "invalid x-api-key")
      )
    );
    try {
      const c = client(srv.url);
      const call = () => c.chat({ system: "", messages: [{ role: "user", content: "x" }], tools: [] }).then(() => assert.fail("expected an error"), (e) => e as ProviderError);
      const e429 = await call();
      assert.ok(e429 instanceof ProviderError);
      assert.equal(e429.kind, "infra");
      assert.equal(e429.status, 429);
      assert.equal(e429.retryAfterMs, 7000);
      assert.equal(e429.code, "rate_limit_error");
      assert.match(e429.message, /\(429\)/);
      assert.equal((await call()).kind, "infra");
      const e500 = await call();
      assert.equal(e500.kind, "infra");
      assert.equal(e500.status, 500);
      const e400 = await call();
      assert.equal(e400.kind, "rejected");
      assert.equal(e400.code, "invalid_request_error");
      const e401 = await call();
      assert.equal(e401.kind, "rejected");
      assert.equal(e401.status, 401);
      assert.equal(isTemperatureUnsupported(e401), false);
    } finally {
      await srv.close();
    }
  });

  test("no response at all is infra with no status (the retry policy's 'timeout')", async () => {
    const c = createModelClient(resolveModel({ model: "anthropic:x", base_url: "http://127.0.0.1:9" }, { env: { ANTHROPIC_API_KEY: "k" } }));
    const e = await c.chat({ system: "", messages: [{ role: "user", content: "x" }], tools: [] }).catch((x) => x as ProviderError);
    assert.ok(e instanceof ProviderError);
    assert.equal(e.kind, "infra");
    assert.equal(e.status, undefined);
  });
});
