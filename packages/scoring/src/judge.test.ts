import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { buildJudgePrompt, createAnthropicJudge, majority, parseVote } from "./judge.js";

type FakeResponse = { status: number; text?: string; headers?: Record<string, string> };

function fakeFetch(responses: FakeResponse[] | ((body: any) => FakeResponse)) {
  const bodies: any[] = [];
  let i = 0;
  const impl = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    bodies.push(body);
    const r = typeof responses === "function" ? responses(body) : responses[i++]!;
    return new Response(
      r.status === 200 ? JSON.stringify({ content: [{ type: "text", text: r.text ?? "" }] }) : "error body",
      { status: r.status, headers: r.headers }
    );
  }) as unknown as typeof fetch;
  return { impl, bodies };
}

const base = { apiKey: "k", model: "judge-model", temperature: 0, votes: 3, retry: { max_attempts: 3, retry_on: [429, 529] as Array<number | "timeout"> } };

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
    const { impl, bodies } = fakeFetch(() => ({ status: 200, text: "SAME" }));
    const judge = createAnthropicJudge({ ...base, fetch: impl });
    const verdict = await judge("ANSWER-A", "ANSWER-B", "RUBRIC-TEXT");
    assert.deepEqual(verdict, { equivalent: true, votes: ["same", "same", "same"] });
    assert.equal(bodies.length, 3);
    for (const b of bodies) {
      assert.equal(b.temperature, 0);
      assert.equal(b.model, "judge-model");
      assert.match(b.messages[0].content, /RUBRIC-TEXT/);
    }
    const firstShown = bodies.map((b) => (b.messages[0].content.indexOf("ANSWER-A") < b.messages[0].content.indexOf("ANSWER-B") ? "A" : "B"));
    assert.deepEqual(firstShown, ["A", "B", "A"]);
  });

  test("a 2-1 split decides by majority", async () => {
    let n = 0;
    const { impl } = fakeFetch(() => ({ status: 200, text: n++ === 1 ? "SAME" : "DIFFERENT" }));
    const verdict = await createAnthropicJudge({ ...base, fetch: impl })("a", "b", "r");
    assert.equal(verdict.equivalent, false);
    assert.deepEqual([...verdict.votes].sort(), ["different", "different", "same"]);
  });

  test("retries a status on retry_on, then succeeds", async () => {
    const { impl, bodies } = fakeFetch([{ status: 429, headers: { "retry-after": "0" } }, { status: 200, text: "SAME" }]);
    const sleeps: number[] = [];
    const judge = createAnthropicJudge({ ...base, votes: 1, fetch: impl, sleep: async (ms) => void sleeps.push(ms) });
    assert.equal((await judge("a", "b", "r")).equivalent, true);
    assert.equal(bodies.length, 2);
    assert.deepEqual(sleeps, [0]);
  });

  test("does not retry a rejection (401), and says what happened", async () => {
    const { impl, bodies } = fakeFetch([{ status: 401 }]);
    const judge = createAnthropicJudge({ ...base, votes: 1, fetch: impl, sleep: async () => undefined });
    await assert.rejects(judge("a", "b", "r"), /judge request failed \(401\)/);
    assert.equal(bodies.length, 1);
  });

  test("the prompt carries the rubric and both answers", () => {
    const prompt = buildJudgePrompt("  must decline  ", "one", "two");
    assert.match(prompt, /must decline/);
    assert.ok(prompt.indexOf("one") < prompt.indexOf("two"));
  });
});
