/**
 * The Bedrock adapter through the real @aws-sdk/client-bedrock-runtime, pointed at a local
 * fake of the Converse API with dummy credentials. The SDK really signs and serialises the
 * request, so this checks the wire format the SDK produces from what the adapter built
 * (https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_Converse.html),
 * and how the adapter reads the SDK's typed exceptions, with SDK retries off.
 */
import test, { after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { createModelClient, resolveModel } from "./index.js";
import { queue, startFakeServer, type FakeReply } from "./testing/fake-server.js";
import { rejection, SYSTEM, TOOLS, twoCallConversation } from "./testing/fixtures.js";

function converse(content: unknown[], stop: string): FakeReply {
  return {
    headers: { "x-amzn-requestid": "b7f0a4d2-req" },
    body: {
      output: { message: { role: "assistant", content } },
      stopReason: stop,
      usage: { inputTokens: 250, outputTokens: 40, totalTokens: 290 },
      metrics: { latencyMs: 812 },
    },
  };
}

function awsError(status: number, type: string, message: string, headers: Record<string, string> = {}): FakeReply {
  return { status, headers: { "x-amzn-errortype": `${type}:http://internal.amazon.com/coral/com.amazon.bedrock/`, ...headers }, body: { message } };
}

const ENV_KEYS = ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_REGION", "AWS_PROFILE"] as const;
const saved: Record<string, string | undefined> = {};

describe("bedrock adapter (real AWS SDK, fake endpoint)", () => {
  before(() => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    process.env.AWS_ACCESS_KEY_ID = "AKIAFAKEFAKEFAKE";
    process.env.AWS_SECRET_ACCESS_KEY = "fake-secret";
    delete process.env.AWS_SESSION_TOKEN;
    delete process.env.AWS_PROFILE;
  });
  after(() => {
    for (const k of ENV_KEYS) if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  });

  const client = (url: string, params?: Record<string, unknown>) =>
    createModelClient(
      resolveModel({ model: "bedrock:anthropic.claude-3-5-haiku-20241022-v1:0", base_url: url, region: "us-east-1", ...(params ? { params } : {}) })
    );

  test("request shape: SigV4-signed Converse call with system, toolConfig, toolUse / toolResult blocks", async () => {
    const srv = await startFakeServer(queue(converse([{ text: "Done." }], "end_turn")));
    try {
      const res = await client(srv.url).chat({ system: SYSTEM, messages: twoCallConversation(), tools: TOOLS });
      const r = srv.requests[0]!;
      assert.equal(r.method, "POST");
      assert.equal(decodeURIComponent(r.path), "/model/anthropic.claude-3-5-haiku-20241022-v1:0/converse");
      assert.match(String(r.headers.authorization), /^AWS4-HMAC-SHA256 Credential=AKIAFAKEFAKEFAKE\/\d{8}\/us-east-1\/bedrock\/aws4_request/);
      assert.deepEqual(r.body.system, [{ text: SYSTEM }]);
      assert.deepEqual(r.body.toolConfig.tools[0], { toolSpec: { name: "lookup_order", description: "Look up an order.", inputSchema: { json: TOOLS[0]!.input_schema } } });
      assert.equal("inferenceConfig" in r.body, false, "nothing set unless configured");
      assert.deepEqual(r.body.messages, [
        { role: "user", content: [{ text: "Refund order 1234." }] },
        {
          role: "assistant",
          content: [
            { text: "Checking." },
            { toolUse: { toolUseId: "call_a", name: "lookup_order", input: { order_id: "1234" } } },
            { toolUse: { toolUseId: "call_b", name: "check_refund_history", input: { order_id: "1234" } } },
          ],
        },
        {
          role: "user",
          content: [
            { toolResult: { toolUseId: "call_a", content: [{ text: '{"order_id":"1234","amount":42}' }], status: "success" } },
            { toolResult: { toolUseId: "call_b", content: [{ text: "tool failed: timeout" }], status: "error" } },
          ],
        },
      ]);
      assert.equal(res.text, "Done.");
      assert.equal(res.stop_reason, "end_turn");
      assert.equal(res.model, null, "Converse does not report the model; never echo the requested id as if it did");
      assert.equal(res.request_id, "b7f0a4d2-req");
      assert.deepEqual(res.usage, { input_tokens: 250, output_tokens: 40 });
      assert.equal(res.endpoint, srv.host);
    } finally {
      await srv.close();
    }
  });

  test("params: inferenceConfig plus additionalModelRequestFields passthrough", async () => {
    const srv = await startFakeServer(queue(converse([{ text: "x" }], "end_turn")));
    try {
      const res = await client(srv.url, { temperature: 0, max_tokens: 16, top_k: 5 }).chat({ system: "", messages: [{ role: "user", content: "x" }], tools: [] });
      assert.deepEqual(srv.requests[0]!.body.inferenceConfig, { temperature: 0, maxTokens: 16 });
      assert.deepEqual(srv.requests[0]!.body.additionalModelRequestFields, { top_k: 5 });
      assert.equal("system" in srv.requests[0]!.body, false);
      assert.deepEqual(res.params_sent, { temperature: 0, max_tokens: 16, top_k: 5 });
    } finally {
      await srv.close();
    }
  });

  test("one and several toolUse blocks in one turn; max_tokens; native replay", async () => {
    const two = [
      { toolUse: { toolUseId: "tooluse_1", name: "lookup_order", input: { order_id: "1234" } } },
      { toolUse: { toolUseId: "tooluse_2", name: "check_refund_history", input: { order_id: "1234" } } },
    ];
    const srv = await startFakeServer(
      queue(
        converse([{ toolUse: { toolUseId: "tooluse_0", name: "lookup_order", input: { order_id: "9" } } }], "tool_use"),
        converse(two, "tool_use"),
        converse([{ text: "cut" }], "max_tokens"),
        converse([{ text: "ok" }], "end_turn")
      )
    );
    try {
      const c = client(srv.url);
      const one = await c.chat({ system: "", messages: [{ role: "user", content: "go" }], tools: TOOLS });
      assert.deepEqual(one.tool_calls, [{ id: "tooluse_0", name: "lookup_order", input: { order_id: "9" } }]);
      const res = await c.chat({ system: "", messages: [{ role: "user", content: "go" }], tools: TOOLS });
      assert.equal(res.stop_reason, "tool_use");
      assert.deepEqual(res.tool_calls.map((t) => t.id), ["tooluse_1", "tooluse_2"]);
      const cut = await c.chat({ system: "", messages: [{ role: "user", content: "go" }], tools: [] });
      assert.equal(cut.stop_reason, "max_tokens");
      await c.chat({ system: "", messages: [{ role: "user", content: "go" }, { role: "assistant", text: "", tool_calls: res.tool_calls, native: res.native }], tools: TOOLS });
      assert.deepEqual(srv.requests[3]!.body.messages[1], { role: "assistant", content: two });
    } finally {
      await srv.close();
    }
  });

  test("errors: ThrottlingException 429 (retry-after, one attempt only), 503, 500 infra; ValidationException 400 and AccessDenied 403 rejected", async () => {
    const srv = await startFakeServer(
      queue(
        awsError(429, "ThrottlingException", "Too many requests, please wait before trying again.", { "retry-after": "4" }),
        awsError(503, "ServiceUnavailableException", "Service unavailable"),
        awsError(500, "InternalServerException", "Internal error"),
        awsError(400, "ValidationException", "The provided model identifier is invalid."),
        awsError(403, "AccessDeniedException", "You don't have access to the model with the specified model ID.")
      )
    );
    try {
      const c = client(srv.url);
      const call = () => rejection(c.chat({ system: "", messages: [{ role: "user", content: "x" }], tools: [] }));
      const t = await call();
      assert.equal(srv.requests.length, 1, "maxAttempts 1: the SDK must not retry behind the harness's back");
      assert.equal(t.kind, "infra");
      assert.equal(t.status, 429);
      assert.equal(t.code, "ThrottlingException");
      assert.equal(t.retryAfterMs, 4000);
      assert.equal((await call()).code, "ServiceUnavailableException");
      assert.equal((await call()).kind, "infra");
      const v = await call();
      assert.equal(v.kind, "rejected");
      assert.equal(v.code, "ValidationException");
      const a = await call();
      assert.equal(a.kind, "rejected");
      assert.equal(a.status, 403);
      assert.equal(srv.requests.length, 5);
    } finally {
      await srv.close();
    }
  });

  test("embeddings: Titan through InvokeModel, one text per call", async () => {
    const srv = await startFakeServer((req) => ({ body: { embedding: req.body.inputText === "a" ? [1, 0] : [0, 1], inputTextTokenCount: 1 } }));
    try {
      const e = createModelClient(resolveModel({ model: "bedrock:amazon.titan-embed-text-v2:0", base_url: srv.url, region: "us-east-1" }));
      const out = await e.embed!(["a", "b"]);
      assert.equal(decodeURIComponent(srv.requests[0]!.path), "/model/amazon.titan-embed-text-v2:0/invoke");
      assert.deepEqual(out.vectors, [[1, 0], [0, 1]]);
    } finally {
      await srv.close();
    }
  });
});
