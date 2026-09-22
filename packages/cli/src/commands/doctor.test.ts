/**
 * `invariant doctor` against fake provider servers: presence checks never print a key,
 * --ping makes one call per role and reports the model id the provider reported.
 */
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { startFakeServer } from "@invariant/providers/testing";
import { parseConfig } from "../lib/config.js";
import { runDoctor } from "./doctor.js";

function config(models: string) {
  const r = parseConfig(`
providers: { retry: { max_attempts: 1, retry_on: [429] } }
execution: { worker_concurrency: 1, default_tier: smoke }
judge: { temperature: 0 }
${models}`);
  if (!r.ok) throw new Error(r.errors.join("; "));
  return r.config;
}

describe("invariant doctor", () => {
  test("presence only: names the variable, never prints the key; a missing key is NOT OK", async () => {
    const lines: string[] = [];
    const secret = "sk-live-SECRET-should-never-appear";
    const report = await runDoctor(
      { ping: false, json: false },
      {
        config: config("models: { agent: { model: 'openai:gpt-4.1' }, judge: { model: 'anthropic:claude-sonnet-4-5' }, paraphraser: { model: 'ollama:qwen2.5:3b' } }"),
        env: { OPENAI_API_KEY: secret },
        out: (l) => lines.push(l),
      }
    );
    const text = lines.join("\n");
    assert.equal(report.ok, false);
    assert.ok(!text.includes(secret) && !text.includes("SECRET"), "a key must never be printed");
    assert.match(text, /agent\s+openai:gpt-4\.1 @ api\.openai\.com/);
    assert.match(text, /OPENAI_API_KEY is set/);
    assert.match(text, /ANTHROPIC_API_KEY is NOT set/);
    assert.match(text, /paraphraser\s+ollama:qwen2\.5:3b @ localhost:11434/);
    assert.match(text, /no key needed/);
    assert.match(text, /embedder\s+not configured \(no embedding pre-filter/);
    const judge = report.roles.find((r) => r.role === "judge")!;
    assert.equal(judge.ok, false);
    assert.match(judge.problem!, /^ANTHROPIC_API_KEY is not set\. The outcome axis/);
  });

  test("--roles restricts the check (CI checks agent and judge only), and a named role must be configured", async () => {
    const c = config("models: { agent: { model: 'openai:gpt-4.1' }, judge: { model: 'openai:gpt-4.1' }, paraphraser: { model: 'anthropic:claude-sonnet-4-5' } }");
    const ok = await runDoctor({ ping: false, json: true, roles: ["agent", "judge"] }, { config: c, env: { OPENAI_API_KEY: "k" }, out: () => undefined });
    assert.equal(ok.ok, true, "the paraphraser's missing key does not matter to CI");
    const missing = await runDoctor({ ping: false, json: true, roles: ["embedder"] }, { config: c, env: {}, out: () => undefined });
    assert.equal(missing.ok, false);
    assert.match(missing.roles.find((r) => r.role === "embedder")!.problem!, /models\.embedder is not configured/);
  });

  test("--ping: one minimal call per role, reported model id and latency; judge temperature refusal reported; failures NOT OK", async () => {
    const srv = await startFakeServer((req) => {
      if (req.path.endsWith("/embeddings")) return { body: { data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }], model: "nomic-embed-text:latest" } };
      if (req.body.model === "o3" && "temperature" in req.body) {
        return { status: 400, body: { error: { message: "Unsupported value: 'temperature' does not support 0 with this model.", param: "temperature", code: "unsupported_value" } } };
      }
      if (req.body.model === "broken") return { status: 401, body: { error: { message: "Incorrect API key provided", code: "invalid_api_key" } } };
      return { body: { id: "c", model: `${req.body.model}-reported`, choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "OK" } }], usage: { prompt_tokens: 5, completion_tokens: 1 } } };
    });
    try {
      const c = config(`models:
  agent: { model: "ollama:qwen2.5:3b", base_url: "${srv.url}/v1" }
  judge: { model: "openai:o3", base_url: "${srv.url}/v1" }
  paraphraser: { model: "openai-compatible:broken", base_url: "${srv.url}/v1", api_key_env: MY_KEY }
  embedder: { model: "ollama:nomic-embed-text", base_url: "${srv.url}/v1" }
`);
      const lines: string[] = [];
      const report = await runDoctor({ ping: true, json: false }, { config: c, env: { OPENAI_API_KEY: "sk", MY_KEY: "k" }, out: (l) => lines.push(l) });
      const byRole = Object.fromEntries(report.roles.map((r) => [r.role, r]));
      assert.equal(byRole.agent!.ping!.ok, true);
      assert.equal(byRole.agent!.ping!.reported_model, "qwen2.5:3b-reported");
      assert.ok(byRole.agent!.ping!.latency_ms >= 0);
      assert.equal(byRole.judge!.ping!.ok, true);
      assert.match(byRole.judge!.ping!.detail!, /temperature 0 UNSUPPORTED/);
      assert.equal(byRole.embedder!.ping!.ok, true);
      assert.match(byRole.embedder!.ping!.detail!, /3-dimensional/);
      assert.equal(byRole.paraphraser!.ping!.ok, false);
      assert.match(byRole.paraphraser!.ping!.error!, /401/);
      assert.equal(report.ok, false);
      assert.match(lines.join("\n"), /ping: ok in \d+ ms, reported model qwen2\.5:3b-reported/);
      // Nothing else was sent to the agent: only the ping's own max_tokens.
      const agentReq = srv.requests.find((r) => r.body.model === "qwen2.5:3b")!;
      assert.deepEqual(Object.keys(agentReq.body).sort(), ["max_tokens", "messages", "model"]);
    } finally {
      await srv.close();
    }
  });
});
