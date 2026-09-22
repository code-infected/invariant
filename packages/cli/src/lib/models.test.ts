import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { parseModelRef } from "@invariant/providers";
import { parseConfig } from "./config.js";
import { clearConfiguredCredentials, configuredCredentialEnv, requireCredentials, requireRole, roleSpec, withOverride } from "./models.js";

function config(models: string) {
  const r = parseConfig(`
providers: { retry: { max_attempts: 1, retry_on: [429] } }
execution: { worker_concurrency: 1, default_tier: smoke }
${models}`);
  if (!r.ok) throw new Error(r.errors.join("; "));
  return r.config;
}

describe("model references and roles", () => {
  test("split on the FIRST colon only; unknown providers listed", () => {
    assert.deepEqual(parseModelRef("ollama:qwen2.5:3b"), { provider: "ollama", model: "qwen2.5:3b" });
    assert.deepEqual(parseModelRef("bedrock:anthropic.claude-3-5-haiku-20241022-v1:0"), { provider: "bedrock", model: "anthropic.claude-3-5-haiku-20241022-v1:0" });
    assert.deepEqual(parseModelRef("openrouter:meta-llama/llama-3.3-70b-instruct:free"), { provider: "openrouter", model: "meta-llama/llama-3.3-70b-instruct:free" });
    assert.throws(() => parseModelRef("gpt-4.1"), /not of the form provider:model/);
    assert.throws(() => parseModelRef("ollama:"), /not of the form/);
    assert.throws(() => parseModelRef("nope:model"), /unknown provider "nope".*Known providers: .*ollama/);
  });

  test("an override keeps the role's endpoint and params only for the same provider", () => {
    const configured = { model: "ollama:qwen2.5:3b", base_url: "http://gpu-box:11434/v1", params: { temperature: 0.2 } };
    assert.deepEqual(withOverride(configured, "ollama:llama3.2:3b"), { ...configured, model: "ollama:llama3.2:3b" });
    assert.deepEqual(withOverride(configured, "openai:gpt-4.1"), { model: "openai:gpt-4.1" });
    assert.equal(withOverride(configured, undefined), configured);
    assert.throws(() => withOverride(configured, "gpt-4.1"), /provider:model/);
  });

  test("a missing role is a clear error naming the key; the override works without one", () => {
    const c = config("models: { judge: { model: 'openai:gpt-4.1' } }");
    assert.throws(() => requireRole(c, "agent"), /no agent model configured: set models\.agent\.model/);
    assert.deepEqual(requireRole(c, "agent", "groq:llama-3.3-70b-versatile"), { model: "groq:llama-3.3-70b-versatile" });
    assert.equal(roleSpec(c, "embedder"), null);
  });

  test("the missing-key error names the configured provider's variable, in the repo's style", () => {
    const cases: Array<[string, RegExp]> = [
      ["openai:gpt-4.1", /OPENAI_API_KEY is not set\. Running a trial drives the agent under test through the real model API \(openai:gpt-4\.1, provider openai\).*no offline fallback/],
      ["gemini:gemini-2.5-flash", /GOOGLE_API_KEY or GEMINI_API_KEY are not set\./],
      ["azure:dep", /AZURE_OPENAI_API_KEY is not set/],
      ["groq:llama-3.3-70b-versatile", /GROQ_API_KEY is not set/],
      ["xai:grok-4", /XAI_API_KEY is not set/],
    ];
    for (const [model, pattern] of cases) {
      const spec = model.startsWith("azure") ? { model, base_url: "https://x.openai.azure.com/openai/v1" } : { model };
      assert.throws(() => requireCredentials("agent", spec, {}), pattern, model);
    }
    assert.throws(() => requireCredentials("judge", { model: "openai:o3", api_key_env: "JUDGE_KEY" }, { OPENAI_API_KEY: "x" }), /JUDGE_KEY is not set\. The outcome axis/);
    // Keyless and AWS-chain providers are never refused up front.
    requireCredentials("agent", { model: "ollama:qwen2.5:3b" }, {});
    requireCredentials("agent", { model: "bedrock:anthropic.claude-3-5-haiku-20241022-v1:0" }, {});
    requireCredentials("agent", { model: "gemini:gemini-2.5-flash" }, { GEMINI_API_KEY: "k" });
  });

  test("clearConfiguredCredentials removes exactly what the configured roles read, and restores it", () => {
    const c = config("models: { agent: { model: 'openai:gpt-4.1' }, judge: { model: 'gemini:gemini-2.5-flash' } }");
    assert.deepEqual(configuredCredentialEnv(c).sort(), ["GEMINI_API_KEY", "GOOGLE_API_KEY", "OPENAI_API_KEY"]);
    const env: NodeJS.ProcessEnv = { OPENAI_API_KEY: "a", GEMINI_API_KEY: "b", UNRELATED: "c" };
    const restore = clearConfiguredCredentials(c, env);
    assert.deepEqual(env, { UNRELATED: "c" });
    restore();
    assert.deepEqual(env, { OPENAI_API_KEY: "a", GEMINI_API_KEY: "b", UNRELATED: "c" });
  });
});
