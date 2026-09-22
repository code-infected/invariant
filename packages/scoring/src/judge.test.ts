import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { createModelClient, ProviderError, resolveModel, scriptedResponse, type ChatRequest, type ChatResponse, type ModelClient } from "@invariant/providers";
import { startFakeServer } from "@invariant/providers/testing";
import { buildJudgePrompt, createModelEmbedder, createModelJudge, majority, parseVote } from "./judge.js";

/** A ModelClient whose answers come from a function; records every request. */
function fakeClient(answer: (req: ChatRequest, n: number) => ChatResponse | Promise<ChatResponse>): { client: ModelClient; requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  return {
    requests,
    client: {
      provider: "fake",
      protocol: "openai",
      model: "judge-model",
      endpoint: null,
      chat: async (req) => {
        requests.push(req);
        return answer(req, requests.length);
      },
    },
  };
}

const say = (text: string) => scriptedResponse({ text, model: "judge-model-2026" });
const retry = { max_attempts: 3, retry_on: [429, 529] as Array<number | string> };
const prompt = (r: ChatRequest) => (r.messages[0] as { content: string }).content;

describe("judge", () => {
  test("parses the first word of a vote; anything else abstains", () => {
    assert.equal(parseVote("SAME"), "same");
    assert.equal(parseVote(" different."), "different");
    assert.equal(parseVote("Same, both decline"), "same");
    assert.equal(parseVote("I think they are the same"), "abstain");
    assert.equal(parseVote(""), "abstain");
  });

  test("strict majority of all votes; abstentions count against", () => {
    assert.equal(majority(["same", "same", "different"]), true);
    assert.equal(majority(["same", "abstain", "different"]), false);
    assert.equal(majority(["same", "same", "abstain"]), true);
    assert.equal(majority(["same", "different"]), false);
  });

  test("three votes at temperature 0 with the rubric, alternating answer order", async () => {
    const { client, requests } = fakeClient(() => say("SAME"));
    const { judge, state } = createModelJudge({ client, temperature: 0, votes: 3, retry });
    const verdict = await judge("ANSWER-A", "ANSWER-B", "RUBRIC-TEXT");
    assert.deepEqual(verdict, { equivalent: true, votes: ["same", "same", "same"] });
    assert.equal(requests.length, 3);
    for (const r of requests) {
      assert.deepEqual(r.params, { max_tokens: 8, temperature: 0 });
      assert.match(prompt(r), /RUBRIC-TEXT/);
      assert.deepEqual(r.tools, []);
    }
    const firstShown = requests.map((r) => (prompt(r).indexOf("ANSWER-A") < prompt(r).indexOf("ANSWER-B") ? "A" : "B"));
    assert.deepEqual(firstShown, ["A", "B", "A"]);
    assert.equal(state.temperature, 0);
    assert.deepEqual(state.reported_models, ["judge-model-2026"]);
  });

  test("a 2-1 split decides by majority", async () => {
    const { client } = fakeClient((_r, n) => say(n === 2 ? "SAME" : "DIFFERENT"));
    const verdict = await createModelJudge({ client, temperature: 0, votes: 3, retry }).judge("a", "b", "r");
    assert.equal(verdict.equivalent, false);
    assert.deepEqual([...verdict.votes].sort(), ["different", "different", "same"]);
  });

  test("retries an infra failure on retry_on (status or provider code), then succeeds", async () => {
    const sleeps: number[] = [];
    const { client, requests } = fakeClient((_r, n) => {
      if (n === 1) throw new ProviderError("429", { provider: "fake", kind: "infra", status: 429, retryAfterMs: 0 });
      if (n === 2) throw new ProviderError("throttled", { provider: "fake", kind: "infra", code: "ThrottlingException" });
      return say("SAME");
    });
    const { judge } = createModelJudge({ client, temperature: 0, votes: 1, retry: { max_attempts: 3, retry_on: [429, "ThrottlingException"] }, sleep: async (ms) => void sleeps.push(ms) });
    assert.equal((await judge("a", "b", "r")).equivalent, true);
    assert.equal(requests.length, 3);
    assert.deepEqual(sleeps, [0, 2000]);
  });

  test("does not retry a rejection (401), and says what happened", async () => {
    const { client, requests } = fakeClient(() => {
      throw new ProviderError("fake API request failed (401): bad key", { provider: "fake", kind: "rejected", status: 401 });
    });
    const { judge } = createModelJudge({ client, temperature: 0, votes: 1, retry, sleep: async () => undefined });
    await assert.rejects(judge("a", "b", "r"), /judge request failed \(401\)/);
    assert.equal(requests.length, 1);
  });

  test("models.judge.params pass through; max_tokens can be raised for a reasoning model", async () => {
    const { client, requests } = fakeClient(() => say("SAME"));
    await createModelJudge({ client, temperature: 0, votes: 1, retry, params: { max_tokens: 400, reasoning_effort: "low" } }).judge("a", "b", "r");
    assert.deepEqual(requests[0]!.params, { reasoning_effort: "low", max_tokens: 400, temperature: 0 });
  });

  test("temperature refused (OpenAI reasoning model, real adapter, fake server): retried once without it, and RECORDED", async () => {
    const srv = await startFakeServer((req) => {
      if ("temperature" in req.body) {
        return {
          status: 400,
          body: {
            error: {
              message: "Unsupported value: 'temperature' does not support 0 with this model. Only the default (1) value is supported.",
              type: "invalid_request_error",
              param: "temperature",
              code: "unsupported_value",
            },
          },
        };
      }
      return { body: { id: "c", model: "o3-2025-04-16", choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "SAME" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } } };
    });
    try {
      const client = createModelClient(resolveModel({ model: "openai:o3", base_url: srv.url }, { env: { OPENAI_API_KEY: "sk" } }));
      const { judge, state } = createModelJudge({ client, temperature: 0, votes: 3, retry, params: { max_tokens: 200 } });
      const verdict = await judge("a", "b", "r");
      assert.equal(verdict.equivalent, true);
      assert.equal(state.temperature, "unsupported");
      assert.deepEqual(state.reported_models, ["o3-2025-04-16"]);
      const withTemp = srv.requests.filter((r) => "temperature" in r.body).length;
      const without = srv.requests.filter((r) => !("temperature" in r.body)).length;
      // The three votes run concurrently, so each may have tried temperature once before
      // the first refusal was seen; after that, none is sent. Never more than one refusal per vote.
      assert.ok(withTemp >= 1 && withTemp <= 3, `refusals: ${withTemp}`);
      assert.equal(without, 3);
      const again = srv.requests.length;
      await judge("c", "d", "r");
      assert.equal(srv.requests.slice(again).filter((r) => "temperature" in r.body).length, 0, "later calls go without temperature");
    } finally {
      await srv.close();
    }
  });

  test("a 400 that is not about temperature is not retried without it", async () => {
    const { client, requests } = fakeClient(() => {
      throw new ProviderError("fake API request failed (400): messages: too long", { provider: "fake", kind: "rejected", status: 400 });
    });
    const { judge, state } = createModelJudge({ client, temperature: 0, votes: 1, retry });
    await assert.rejects(judge("a", "b", "r"), /\(400\)/);
    assert.equal(requests.length, 1);
    assert.equal(state.temperature, 0);
  });

  test("the prompt carries the rubric and both answers", () => {
    const p = buildJudgePrompt("  must decline  ", "one", "two");
    assert.match(p, /must decline/);
    assert.ok(p.indexOf("one") < p.indexOf("two"));
  });

  test("embedder: through a provider's embeddings API; a provider without one is refused clearly", async () => {
    const srv = await startFakeServer(() => ({ body: { data: [{ index: 0, embedding: [1, 0] }, { index: 1, embedding: [0.9, 0.1] }], model: "nomic-embed-text" } }));
    try {
      const embed = createModelEmbedder(createModelClient(resolveModel({ model: "ollama:nomic-embed-text", base_url: srv.url }, { env: {} })));
      assert.deepEqual(await embed(["x", "y"]), [[1, 0], [0.9, 0.1]]);
      const anthropic = createModelClient(resolveModel({ model: "anthropic:claude-sonnet-4-5" }, { env: { ANTHROPIC_API_KEY: "k" } }));
      assert.throws(() => createModelEmbedder(anthropic), /no embeddings API/);
    } finally {
      await srv.close();
    }
  });
});
