/**
 * The Chat Completions adapter against a local fake: openai, azure (v1 and dated
 * api-version routes), and the OpenAI-compatible presets. Request shape per
 * https://platform.openai.com/docs/api-reference/chat; responses as the API sends them.
 */
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { createModelClient, isTemperatureUnsupported, KNOWN_PROVIDERS, PROVIDERS, resolveModel, type ModelSpec } from "./index.js";
import { queue, startFakeServer, type FakeReply } from "./testing/fake-server.js";
import { rejection, SYSTEM, TOOLS, twoCallConversation } from "./testing/fixtures.js";

function completion(message: Record<string, unknown>, finish: string, model = "gpt-4.1-2025-04-14"): FakeReply {
  return {
    headers: { "x-request-id": "req_abc" },
    body: {
      id: "chatcmpl-1",
      object: "chat.completion",
      created: 1760000000,
      model,
      choices: [{ index: 0, message: { role: "assistant", refusal: null, ...message }, finish_reason: finish, logprobs: null }],
      usage: { prompt_tokens: 210, completion_tokens: 33, total_tokens: 243 },
    },
  };
}

const call = (id: string, name: string, args: string) => ({ id, type: "function", function: { name, arguments: args } });

function mk(spec: Partial<ModelSpec> & { model: string }, env: Record<string, string> = { OPENAI_API_KEY: "sk-test" }) {
  return createModelClient(resolveModel(spec as ModelSpec, { env }));
}

describe("openai adapter", () => {
  test("request shape: bearer auth, system message, function tools, one tool message per result", async () => {
    const srv = await startFakeServer(queue(completion({ content: "Done." }, "stop")));
    try {
      const res = await mk({ model: "openai:gpt-4.1", base_url: `${srv.url}/v1` }).chat({ system: SYSTEM, messages: twoCallConversation(), tools: TOOLS });
      const r = srv.requests[0]!;
      assert.equal(r.path, "/v1/chat/completions");
      assert.equal(r.headers.authorization, "Bearer sk-test");
      assert.equal(r.body.model, "gpt-4.1");
      for (const k of ["temperature", "top_p", "max_tokens", "max_completion_tokens", "tool_choice", "parallel_tool_calls"]) {
        assert.equal(k in r.body, false, `${k} must not be set unless configured`);
      }
      assert.deepEqual(r.body.messages[0], { role: "system", content: SYSTEM });
      assert.deepEqual(r.body.messages[1], { role: "user", content: "Refund order 1234." });
      assert.deepEqual(r.body.messages[2], {
        role: "assistant",
        content: "Checking.",
        tool_calls: [call("call_a", "lookup_order", '{"order_id":"1234"}'), call("call_b", "check_refund_history", '{"order_id":"1234"}')],
      });
      assert.deepEqual(r.body.messages.slice(3), [
        { role: "tool", tool_call_id: "call_a", content: '{"order_id":"1234","amount":42}' },
        { role: "tool", tool_call_id: "call_b", content: "tool failed: timeout" },
      ]);
      assert.deepEqual(r.body.tools[0], { type: "function", function: { name: "lookup_order", description: "Look up an order.", parameters: TOOLS[0]!.input_schema } });
      assert.equal(res.text, "Done.");
      assert.equal(res.stop_reason, "end_turn");
      assert.equal(res.raw_stop_reason, "stop");
      assert.equal(res.model, "gpt-4.1-2025-04-14");
      assert.equal(res.request_id, "req_abc");
      assert.deepEqual(res.usage, { input_tokens: 210, output_tokens: 33 });
      assert.deepEqual(res.params_sent, {});
    } finally {
      await srv.close();
    }
  });

  test("single and multiple tool calls; the exact arguments string is replayed; bad JSON is flagged, not guessed", async () => {
    const multi = { content: null, tool_calls: [call("call_1", "lookup_order", '{ "order_id": "1234" }'), call("call_2", "check_refund_history", '{"order_id":"1234"}')] };
    const srv = await startFakeServer(
      queue(
        completion({ content: null, tool_calls: [call("call_0", "lookup_order", '{"order_id":"7"}')] }, "tool_calls"),
        completion(multi, "tool_calls"),
        completion({ content: null, tool_calls: [call("call_x", "lookup_order", "{order_id: 12")] }, "tool_calls"),
        completion({ content: "ok" }, "stop")
      )
    );
    try {
      const c = mk({ model: "openai:gpt-4.1", base_url: srv.url });
      const one = await c.chat({ system: "", messages: [{ role: "user", content: "go" }], tools: TOOLS });
      assert.equal(one.stop_reason, "tool_use");
      assert.deepEqual(one.tool_calls, [{ id: "call_0", name: "lookup_order", input: { order_id: "7" } }]);
      const res = await c.chat({ system: "", messages: [{ role: "user", content: "go" }], tools: TOOLS });
      assert.deepEqual(res.tool_calls.map((t) => [t.id, t.name, t.input]), [
        ["call_1", "lookup_order", { order_id: "1234" }],
        ["call_2", "check_refund_history", { order_id: "1234" }],
      ]);
      const bad = await c.chat({ system: "", messages: [{ role: "user", content: "go" }], tools: TOOLS });
      assert.deepEqual(bad.tool_calls[0], { id: "call_x", name: "lookup_order", input: {}, input_error: "{order_id: 12" });
      await c.chat({
        system: "",
        messages: [{ role: "user", content: "go" }, { role: "assistant", text: res.text, tool_calls: res.tool_calls, native: res.native }],
        tools: TOOLS,
      });
      assert.equal(srv.requests[3]!.body.messages[1].tool_calls[0].function.arguments, '{ "order_id": "1234" }');
      assert.equal(srv.requests[3]!.body.messages[1].content, null);
    } finally {
      await srv.close();
    }
  });

  test("max_tokens: finish_reason length; params map to max_completion_tokens on openai, max_tokens on compatibles", async () => {
    const srv = await startFakeServer(() => completion({ content: "trunc" }, "length"));
    try {
      const res = await mk({ model: "openai:o4-mini", base_url: srv.url, params: { max_tokens: 50, reasoning_effort: "low" } }).chat({
        system: "",
        messages: [{ role: "user", content: "x" }],
        tools: [],
      });
      assert.equal(res.stop_reason, "max_tokens");
      assert.equal(srv.requests[0]!.body.max_completion_tokens, 50);
      assert.equal("max_tokens" in srv.requests[0]!.body, false);
      assert.equal(srv.requests[0]!.body.reasoning_effort, "low");
      assert.deepEqual(res.params_sent, { max_tokens: 50, reasoning_effort: "low" });
      await mk({ model: "groq:llama-3.3-70b-versatile", base_url: srv.url, params: { max_tokens: 50, temperature: 0 } }, { GROQ_API_KEY: "gsk" }).chat({
        system: "",
        messages: [{ role: "user", content: "x" }],
        tools: [],
      });
      assert.equal(srv.requests[1]!.body.max_tokens, 50);
      assert.equal(srv.requests[1]!.body.temperature, 0);
      assert.equal(srv.requests[1]!.headers.authorization, "Bearer gsk");
    } finally {
      await srv.close();
    }
  });

  test("errors: 429 retry-after / 500 infra; 400 temperature unsupported and 401 rejected", async () => {
    const srv = await startFakeServer(
      queue(
        { status: 429, headers: { "retry-after": "2" }, body: { error: { message: "Rate limit reached", type: "requests", param: null, code: "rate_limit_exceeded" } } },
        { status: 500, body: { error: { message: "The server had an error", type: "server_error", param: null, code: null } } },
        {
          status: 400,
          body: {
            error: {
              message: "Unsupported value: 'temperature' does not support 0 with this model. Only the default (1) value is supported.",
              type: "invalid_request_error",
              param: "temperature",
              code: "unsupported_value",
            },
          },
        },
        { status: 401, body: { error: { message: "Incorrect API key provided", type: "invalid_request_error", param: null, code: "invalid_api_key" } } }
      )
    );
    try {
      const c = mk({ model: "openai:o3", base_url: srv.url });
      const call_ = () => rejection(c.chat({ system: "", messages: [{ role: "user", content: "x" }], tools: [], params: { temperature: 0 } }));
      const e429 = await call_();
      assert.equal(e429.kind, "infra");
      assert.equal(e429.retryAfterMs, 2000);
      assert.equal(e429.code, "rate_limit_exceeded");
      assert.equal((await call_()).kind, "infra");
      const e400 = await call_();
      assert.equal(e400.kind, "rejected");
      assert.equal(e400.param, "temperature");
      assert.equal(isTemperatureUnsupported(e400), true);
      const e401 = await call_();
      assert.equal(e401.kind, "rejected");
      assert.equal(e401.code, "invalid_api_key");
      assert.equal(isTemperatureUnsupported(e401), false);
    } finally {
      await srv.close();
    }
  });

  test("azure: api-key header; v1 route by default, the dated deployments route with api_version", async () => {
    const srv = await startFakeServer(() => completion({ content: "hi" }, "stop", "gpt-4.1"));
    try {
      const env = { AZURE_OPENAI_API_KEY: "az-key" };
      const v1 = mk({ model: "azure:my-deployment", base_url: `${srv.url}/openai/v1` }, env);
      await v1.chat({ system: "", messages: [{ role: "user", content: "x" }], tools: [], params: { max_tokens: 5 } });
      assert.equal(srv.requests[0]!.path, "/openai/v1/chat/completions");
      assert.equal(srv.requests[0]!.headers["api-key"], "az-key");
      assert.equal(srv.requests[0]!.headers.authorization, undefined);
      assert.equal(srv.requests[0]!.body.model, "my-deployment");
      assert.equal(srv.requests[0]!.body.max_completion_tokens, 5);
      const dated = mk({ model: "azure:my-deployment", base_url: srv.url, api_version: "2024-10-21" }, env);
      await dated.chat({ system: "", messages: [{ role: "user", content: "x" }], tools: [] });
      assert.equal(srv.requests[1]!.path, "/openai/deployments/my-deployment/chat/completions?api-version=2024-10-21");
    } finally {
      await srv.close();
    }
  });

  test("ollama sends no key; a model id with colons survives; embeddings come back in index order", async () => {
    const srv = await startFakeServer((req) =>
      req.path.endsWith("/embeddings")
        ? { body: { object: "list", model: "nomic-embed-text", data: [{ object: "embedding", index: 1, embedding: [0, 1] }, { object: "embedding", index: 0, embedding: [1, 0] }] } }
        : completion({ content: "hi" }, "stop", "qwen2.5:3b")
    );
    try {
      const c = mk({ model: "ollama:qwen2.5:3b", base_url: `${srv.url}/v1` }, {});
      const res = await c.chat({ system: "", messages: [{ role: "user", content: "x" }], tools: [] });
      assert.equal(srv.requests[0]!.headers.authorization, undefined);
      assert.equal(srv.requests[0]!.body.model, "qwen2.5:3b");
      assert.equal(res.model, "qwen2.5:3b");
      const e = mk({ model: "ollama:nomic-embed-text", base_url: `${srv.url}/v1` }, {});
      const out = await e.embed!(["a", "b"]);
      assert.deepEqual(srv.requests[1]!.body, { model: "nomic-embed-text", input: ["a", "b"] });
      assert.deepEqual(out.vectors, [[1, 0], [0, 1]]);
    } finally {
      await srv.close();
    }
  });

  test("some compatible servers finish a tool-calling turn with 'stop': still tool_use", async () => {
    const srv = await startFakeServer(queue(completion({ content: "", tool_calls: [call("c", "lookup_order", '{"order_id":"1"}')] }, "stop")));
    try {
      const res = await mk({ model: "vllm:meta-llama/Llama-3.1-8B-Instruct", base_url: srv.url }, {}).chat({ system: "", messages: [{ role: "user", content: "x" }], tools: TOOLS });
      assert.equal(res.stop_reason, "tool_use");
      assert.equal(res.raw_stop_reason, "stop");
    } finally {
      await srv.close();
    }
  });

  test("every preset speaking this protocol resolves to a base URL (or demands one) and names its key", () => {
    for (const name of KNOWN_PROVIDERS) {
      const info = PROVIDERS[name]!;
      if (info.protocol !== "openai") continue;
      if (info.base_url_required) {
        assert.throws(() => resolveModel({ model: `${name}:m` }, { env: {} }), /needs base_url/);
      } else {
        const r = resolveModel({ model: `${name}:m` }, { env: {} });
        assert.ok(r.endpoint, `${name} has an endpoint host`);
        assert.ok(!r.endpoint!.includes("/"), "host only");
      }
    }
  });
});
