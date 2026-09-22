import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { createModelClient, resolveModel } from "@invariant/providers";
import { startFakeServer } from "@invariant/providers/testing";
import { generateParaphrasings, parseParaphrasings } from "./variants-regen.js";

describe("variants regen: the paraphraser goes through @invariant/providers", () => {
  test("any provider (gemini here, against a fake generateContent) returns the paraphrasings", async () => {
    const srv = await startFakeServer(() => ({
      body: {
        candidates: [{ finishReason: "STOP", content: { role: "model", parts: [{ text: '```json\n["Refund order 1234.", "Please refund #1234."]\n```' }] } }],
        usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 20 },
        modelVersion: "gemini-2.5-flash-001",
      },
    }));
    try {
      const client = createModelClient(resolveModel({ model: "gemini:gemini-2.5-flash", base_url: `${srv.url}/v1beta` }, { env: { GEMINI_API_KEY: "k" } }));
      const out = await generateParaphrasings(client, "Refund order #{{order_id}}.", 2);
      assert.deepEqual(out, ["Refund order 1234.", "Please refund #1234."]);
      const body = srv.requests[0]!.body;
      assert.match(body.contents[0].parts[0].text, /Rewrite the following instruction 2 different ways/);
      assert.equal(body.generationConfig.maxOutputTokens, 1024);
      assert.equal("systemInstruction" in body, false);
    } finally {
      await srv.close();
    }
  });

  test("anything but a JSON array of strings is refused", () => {
    assert.throws(() => parseParaphrasings("Sure! Here are some:"), /not valid JSON/);
    assert.throws(() => parseParaphrasings('{"a": 1}'), /not a JSON array of strings/);
    assert.throws(() => parseParaphrasings("[1, 2]"), /not a JSON array of strings/);
  });
});
