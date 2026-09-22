/**
 * The Gemini adapter against a local fake of generateContent
 * (https://ai.google.dev/api/generate-content): functionDeclarations with
 * parametersJsonSchema, systemInstruction, functionCall / functionResponse parts, the
 * thoughtSignature round trip, RESOURCE_EXHAUSTED with RetryInfo, and embeddings.
 */
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { createModelClient, GENERATED_ID_PREFIX, resolveModel } from "./index.js";
import { queue, startFakeServer, type FakeReply } from "./testing/fake-server.js";
import { rejection, SYSTEM, TOOLS, twoCallConversation } from "./testing/fixtures.js";

function gen(parts: unknown[], finish: string, extra: Record<string, unknown> = {}): FakeReply {
  return {
    body: {
      candidates: [{ content: { role: "model", parts }, finishReason: finish, index: 0 }],
      usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 18, thoughtsTokenCount: 40, totalTokenCount: 178 },
      modelVersion: "gemini-2.5-flash-001",
      responseId: "resp-xyz",
      ...extra,
    },
  };
}

const gerr = (status: number, code: string, message: string, details: unknown[] = [], headers: Record<string, string> = {}): FakeReply => ({
  status,
  headers,
  body: { error: { code: status, message, status: code, details } },
});

const client = (url: string, env: Record<string, string> = { GEMINI_API_KEY: "gem-key" }, params?: Record<string, unknown>) =>
  createModelClient(resolveModel({ model: "gemini:gemini-2.5-flash", base_url: `${url}/v1beta`, ...(params ? { params } : {}) }, { env }));

describe("gemini adapter", () => {
  test("request shape: x-goog-api-key, systemInstruction, parametersJsonSchema, function responses in order", async () => {
    const srv = await startFakeServer(queue(gen([{ text: "Done." }], "STOP")));
    try {
      const res = await client(srv.url).chat({ system: SYSTEM, messages: twoCallConversation(), tools: TOOLS });
      const r = srv.requests[0]!;
      assert.equal(r.path, "/v1beta/models/gemini-2.5-flash:generateContent");
      assert.equal(r.headers["x-goog-api-key"], "gem-key");
      assert.deepEqual(r.body.systemInstruction, { parts: [{ text: SYSTEM }] });
      assert.deepEqual(r.body.tools, [
        {
          functionDeclarations: TOOLS.map((t) => ({ name: t.name, description: t.description, parametersJsonSchema: t.input_schema })),
        },
      ]);
      assert.equal("generationConfig" in r.body, false, "nothing set unless configured");
      assert.deepEqual(r.body.contents, [
        { role: "user", parts: [{ text: "Refund order 1234." }] },
        {
          role: "model",
          parts: [
            { text: "Checking." },
            { functionCall: { id: "call_a", name: "lookup_order", args: { order_id: "1234" } } },
            { functionCall: { id: "call_b", name: "check_refund_history", args: { order_id: "1234" } } },
          ],
        },
        {
          role: "user",
          parts: [
            { functionResponse: { id: "call_a", name: "lookup_order", response: { output: '{"order_id":"1234","amount":42}' } } },
            { functionResponse: { id: "call_b", name: "check_refund_history", response: { error: "tool failed: timeout" } } },
          ],
        },
      ]);
      assert.equal(res.text, "Done.");
      assert.equal(res.stop_reason, "end_turn");
      assert.equal(res.raw_stop_reason, "STOP");
      assert.equal(res.model, "gemini-2.5-flash-001");
      assert.equal(res.request_id, "resp-xyz");
      assert.deepEqual(res.usage, { input_tokens: 120, output_tokens: 58 });
    } finally {
      await srv.close();
    }
  });

  test("GOOGLE_API_KEY wins over GEMINI_API_KEY, per Google's docs; params go to generationConfig", async () => {
    const srv = await startFakeServer(queue(gen([{ text: "x" }], "STOP")));
    try {
      const res = await client(srv.url, { GEMINI_API_KEY: "g1", GOOGLE_API_KEY: "g2" }, { temperature: 0, max_tokens: 64, thinkingConfig: { thinkingBudget: 0 } }).chat({
        system: "",
        messages: [{ role: "user", content: "x" }],
        tools: [],
      });
      assert.equal(srv.requests[0]!.headers["x-goog-api-key"], "g2");
      assert.deepEqual(srv.requests[0]!.body.generationConfig, { temperature: 0, maxOutputTokens: 64, thinkingConfig: { thinkingBudget: 0 } });
      assert.equal("systemInstruction" in srv.requests[0]!.body, false);
      assert.deepEqual(res.params_sent, { temperature: 0, max_tokens: 64, thinkingConfig: { thinkingBudget: 0 } });
    } finally {
      await srv.close();
    }
  });

  test("single and multiple function calls (finishReason STOP) are tool_use; thought signatures replay unchanged", async () => {
    const multi = [
      { functionCall: { name: "lookup_order", args: { order_id: "1234" } }, thoughtSignature: "c2lnLTE=" },
      { functionCall: { name: "check_refund_history", args: { order_id: "1234" } } },
    ];
    const srv = await startFakeServer(
      queue(gen([{ functionCall: { id: "fc-1", name: "lookup_order", args: { order_id: "9" } } }], "STOP"), gen(multi, "STOP"), gen([{ text: "ok" }], "STOP"))
    );
    try {
      const c = client(srv.url);
      const one = await c.chat({ system: "", messages: [{ role: "user", content: "go" }], tools: TOOLS });
      assert.equal(one.stop_reason, "tool_use");
      assert.deepEqual(one.tool_calls, [{ id: "fc-1", name: "lookup_order", input: { order_id: "9" } }]);
      const res = await c.chat({ system: "", messages: [{ role: "user", content: "go" }], tools: TOOLS });
      assert.equal(res.stop_reason, "tool_use");
      assert.deepEqual(res.tool_calls.map((t) => t.name), ["lookup_order", "check_refund_history"]);
      assert.ok(res.tool_calls.every((t) => t.id.startsWith(GENERATED_ID_PREFIX)), "no id from the API: a generated one, marked");
      await c.chat({
        system: "",
        messages: [
          { role: "user", content: "go" },
          { role: "assistant", text: res.text, tool_calls: res.tool_calls, native: res.native },
          {
            role: "tool",
            results: res.tool_calls.map((t) => ({ tool_call_id: t.id, name: t.name, content: "{}", is_error: false })),
          },
        ],
        tools: TOOLS,
      });
      const contents = srv.requests[2]!.body.contents;
      assert.deepEqual(contents[1], { role: "model", parts: multi }, "model turn replayed verbatim, signature included");
      assert.deepEqual(contents[2].parts, [
        { functionResponse: { name: "lookup_order", response: { output: "{}" } } },
        { functionResponse: { name: "check_refund_history", response: { output: "{}" } } },
      ], "a generated id is never sent to the API");
    } finally {
      await srv.close();
    }
  });

  test("MAX_TOKENS, thought parts left out of the text, a blocked prompt is 'other'", async () => {
    const srv = await startFakeServer(
      queue(gen([{ text: "thinking...", thought: true }, { text: "partial" }], "MAX_TOKENS"), { body: { promptFeedback: { blockReason: "SAFETY" }, usageMetadata: { promptTokenCount: 5 } } })
    );
    try {
      const c = client(srv.url);
      const res = await c.chat({ system: "", messages: [{ role: "user", content: "x" }], tools: [] });
      assert.equal(res.stop_reason, "max_tokens");
      assert.equal(res.text, "partial");
      const blocked = await c.chat({ system: "", messages: [{ role: "user", content: "x" }], tools: [] });
      assert.equal(blocked.stop_reason, "other");
      assert.equal(blocked.raw_stop_reason, "BLOCKED:SAFETY");
      assert.equal(blocked.model, null);
    } finally {
      await srv.close();
    }
  });

  test("errors: RESOURCE_EXHAUSTED 429 with RetryInfo, UNAVAILABLE 503, INTERNAL 500 infra; 400/401 rejected", async () => {
    const srv = await startFakeServer(
      queue(
        gerr(429, "RESOURCE_EXHAUSTED", "Quota exceeded", [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "31s" }]),
        gerr(503, "UNAVAILABLE", "The model is overloaded.", [], { "retry-after": "3" }),
        gerr(500, "INTERNAL", "Internal error"),
        gerr(400, "INVALID_ARGUMENT", "Invalid JSON payload received."),
        gerr(401, "UNAUTHENTICATED", "API key not valid.")
      )
    );
    try {
      const c = client(srv.url);
      const call = () => rejection(c.chat({ system: "", messages: [{ role: "user", content: "x" }], tools: [] }));
      const e429 = await call();
      assert.equal(e429.kind, "infra");
      assert.equal(e429.code, "RESOURCE_EXHAUSTED");
      assert.equal(e429.retryAfterMs, 31000);
      const e503 = await call();
      assert.equal(e503.kind, "infra");
      assert.equal(e503.retryAfterMs, 3000, "a retry-after header wins");
      assert.equal((await call()).kind, "infra");
      const e400 = await call();
      assert.equal(e400.kind, "rejected");
      assert.equal(e400.code, "INVALID_ARGUMENT");
      assert.equal((await call()).status, 401);
    } finally {
      await srv.close();
    }
  });

  test("embeddings: batchEmbedContents", async () => {
    const srv = await startFakeServer(queue({ body: { embeddings: [{ values: [0.1, 0.2] }, { values: [0.3, 0.4] }] } }));
    try {
      const e = createModelClient(resolveModel({ model: "gemini:gemini-embedding-001", base_url: `${srv.url}/v1beta` }, { env: { GEMINI_API_KEY: "k" } }));
      const out = await e.embed!(["a", "b"]);
      assert.equal(srv.requests[0]!.path, "/v1beta/models/gemini-embedding-001:batchEmbedContents");
      assert.deepEqual(srv.requests[0]!.body.requests[1], { model: "models/gemini-embedding-001", content: { parts: [{ text: "b" }] } });
      assert.deepEqual(out.vectors, [[0.1, 0.2], [0.3, 0.4]]);
    } finally {
      await srv.close();
    }
  });
});
