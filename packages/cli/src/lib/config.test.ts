import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { loadConfig, parseConfig } from "./config.js";

describe("invariant.config.yaml", () => {
  test("the committed config parses and carries the retry policy and concurrency", () => {
    const config = loadConfig();
    assert.ok(config.providers.retry.max_attempts >= 1);
    assert.ok(config.providers.retry.retry_on.length > 0);
    assert.ok(config.execution.worker_concurrency >= 1);
    assert.ok(["smoke", "full"].includes(config.execution.default_tier));
  });

  test("keeps keys nothing reads yet instead of rejecting them", () => {
    const result = parseConfig(`
providers: { retry: { max_attempts: 2, retry_on: [429, "timeout"] } }
execution: { worker_concurrency: 4, default_tier: full }
judge: { votes: 3 }
`);
    assert.ok(result.ok);
    if (result.ok) {
      assert.deepEqual(result.config.providers.retry.retry_on, [429, "timeout"]);
      assert.equal((result.config as Record<string, unknown>).judge !== undefined, true);
    }
  });

  test("rejects values the fan-out cannot use", () => {
    const bad = parseConfig(`
providers: { retry: { max_attempts: 0, retry_on: [429, 99, "two words"] } }
execution: { worker_concurrency: 0, default_tier: nightly }
`);
    assert.equal(bad.ok, false);
    if (!bad.ok) {
      const text = bad.errors.join("\n");
      for (const key of ["max_attempts", "retry_on", "worker_concurrency", "default_tier"]) {
        assert.match(text, new RegExp(key));
      }
    }
    assert.equal(parseConfig("execution: [").ok, false);
  });

  test("the committed config states every model role's default explicitly (no hidden defaults in code)", () => {
    const config = loadConfig();
    assert.equal(config.models.agent?.model, "anthropic:claude-sonnet-4-5");
    assert.equal(config.models.judge?.model, "anthropic:claude-sonnet-4-5");
    assert.equal(config.models.paraphraser?.model, "anthropic:claude-sonnet-4-5");
    assert.equal(config.models.agent?.params, undefined, "nothing is set on the agent under test by default");
  });

  test("models: provider:model references, per-provider requirements, key NAMES only", () => {
    const base = `
providers: { retry: { max_attempts: 2, retry_on: [429, "timeout", "ThrottlingException"] } }
execution: { worker_concurrency: 4, default_tier: full }
`;
    const good = parseConfig(
      base +
        `models:
  agent: { model: "ollama:qwen2.5:3b", params: { temperature: 0.7 } }
  judge: { model: "azure:gpt-4o-judge", base_url: "https://acme.openai.azure.com/openai/v1", api_key_env: AZURE_JUDGE_KEY }
  paraphraser: { model: "bedrock:anthropic.claude-3-5-haiku-20241022-v1:0", region: eu-west-1 }
  embedder: { model: "gemini:gemini-embedding-001" }
`
    );
    assert.ok(good.ok, good.ok ? "" : good.errors.join("; "));
    if (good.ok) {
      assert.equal(good.config.models.agent!.model, "ollama:qwen2.5:3b");
      assert.deepEqual(good.config.providers.retry.retry_on, [429, "timeout", "ThrottlingException"]);
    }
    const cases: Array<[string, RegExp]> = [
      [`models: { agent: { model: "claude-sonnet-4-5" } }`, /models\.agent\.model: .*not of the form provider:model/],
      [`models: { agent: { model: "acme:m1" } }`, /unknown provider "acme".*Known providers: anthropic, openai/],
      [`models: { agent: { model: "vllm:llama" } }`, /models\.agent\.base_url: provider vllm needs base_url/],
      [`models: { agent: { model: "azure:dep" } }`, /provider azure needs base_url/],
      [`models: { agent: { model: "openai:gpt-4.1", api_key_env: "sk-live-123" } }`, /NAME of an environment variable/],
      [`models: { agent: { model: "openai:gpt-4.1", region: "us-east-1" } }`, /region applies to provider bedrock only/],
      [`models: { agent: { model: "openai:gpt-4.1", tempurature: 0 } }`, /Unrecognized key/],
      [`models: { judge: { model: "openai:o3", params: { temperature: 0 } } }`, /judge\.temperature/],
      [`models: { embedder: { model: "anthropic:claude-sonnet-4-5" } }`, /no embeddings API/],
      [`models: { critic: { model: "openai:gpt-4.1" } }`, /Unrecognized key/],
      [`judge: { model: "claude-sonnet-4-5" }`, /moved to models\.judge\.model/],
    ];
    for (const [yaml, pattern] of cases) {
      const r = parseConfig(base + yaml);
      assert.equal(r.ok, false, yaml);
      if (!r.ok) assert.match(r.errors.join("\n"), pattern, yaml);
    }
  });
});
