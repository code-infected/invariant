import test, { describe } from "node:test";
import assert from "node:assert/strict";
import {
  credentialStatus,
  endpointHost,
  isTemperatureUnsupported,
  KNOWN_PROVIDERS,
  parseModelRef,
  ProviderError,
  PROVIDERS,
  resolveModel,
} from "./index.js";

describe("registry", () => {
  test("model references split on the first colon only", () => {
    assert.deepEqual(parseModelRef("ollama:qwen2.5:3b"), { provider: "ollama", model: "qwen2.5:3b" });
    assert.deepEqual(parseModelRef("anthropic:claude-sonnet-4-5"), { provider: "anthropic", model: "claude-sonnet-4-5" });
    assert.throws(() => parseModelRef(":x"), /provider:model/);
    assert.throws(() => parseModelRef("foo:bar"), (e: Error) => e.message.includes(`Known providers: ${KNOWN_PROVIDERS.join(", ")}`));
  });

  test("every provider maps to a native protocol; the expected set is present", () => {
    assert.deepEqual([...KNOWN_PROVIDERS].sort(), [
      "anthropic", "azure", "bedrock", "deepseek", "fireworks", "gemini", "groq", "lmstudio", "mistral",
      "ollama", "openai", "openai-compatible", "openrouter", "together", "vllm", "xai",
    ]);
    for (const name of KNOWN_PROVIDERS) assert.ok(["anthropic", "openai", "gemini", "bedrock"].includes(PROVIDERS[name]!.protocol));
  });

  test("credentials: conventional variable, precedence, api_key_env override, keyless and AWS chain", () => {
    assert.deepEqual(credentialStatus({ model: "openai:gpt-4.1" }, { OPENAI_API_KEY: "x" }), { state: "present", env: ["OPENAI_API_KEY"] });
    assert.deepEqual(credentialStatus({ model: "openai:gpt-4.1" }, {}), { state: "missing", env: ["OPENAI_API_KEY"] });
    assert.deepEqual(credentialStatus({ model: "gemini:g" }, { GEMINI_API_KEY: "a", GOOGLE_API_KEY: "b" }), { state: "present", env: ["GOOGLE_API_KEY"] });
    assert.deepEqual(credentialStatus({ model: "gemini:g" }, { GEMINI_API_KEY: "a" }), { state: "present", env: ["GEMINI_API_KEY"] });
    assert.deepEqual(credentialStatus({ model: "openai:m", api_key_env: "MINE" }, { OPENAI_API_KEY: "x" }), { state: "missing", env: ["MINE"] });
    assert.equal(credentialStatus({ model: "ollama:m" }, {}).state, "not_needed");
    assert.equal(credentialStatus({ model: "vllm:m", base_url: "http://h:8000/v1" }, {}).state, "not_needed");
    assert.equal(credentialStatus({ model: "bedrock:m" }, {}).state, "aws_chain");
    assert.equal(credentialStatus({ model: "openai:m" }, { OPENAI_API_KEY: "" }).state, "missing", "an empty variable is unset");
  });

  test("resolve: base URL, endpoint host only, bedrock region endpoint, per-provider requirements", () => {
    const r = resolveModel({ model: "openai-compatible:m", base_url: "https://user:pw@llm.internal:8443/v1/" }, { env: {} });
    assert.equal(r.base_url, "https://user:pw@llm.internal:8443/v1");
    assert.equal(r.endpoint, "llm.internal:8443", "host only: no credentials, no path");
    assert.equal(resolveModel({ model: "bedrock:m", region: "eu-west-1" }, { env: {} }).endpoint, "bedrock-runtime.eu-west-1.amazonaws.com");
    assert.equal(resolveModel({ model: "bedrock:m" }, { env: { AWS_REGION: "us-west-2" } }).endpoint, "bedrock-runtime.us-west-2.amazonaws.com");
    assert.throws(() => resolveModel({ model: "openai-compatible:m" }, { env: {} }), /needs base_url/);
    assert.throws(() => resolveModel({ model: "openai:m", api_version: "2024-10-21" }, { env: {} }), /azure only/);
    assert.throws(() => resolveModel({ model: "openai:m" }, { env: {}, requireKey: true }), /OPENAI_API_KEY is not set/);
    assert.equal(endpointHost("not a url"), null);
  });

  test("temperature refusal is recognised from the provider's 400, nothing else", () => {
    const reject = (message: string, param?: string, status = 400) => new ProviderError(message, { provider: "p", kind: "rejected", status, ...(param ? { param } : {}) });
    assert.equal(isTemperatureUnsupported(reject("Unsupported value", "temperature")), true);
    assert.equal(isTemperatureUnsupported(reject("temperature is not supported for this model")), true);
    assert.equal(isTemperatureUnsupported(reject("temperature: range: 0..1")), false);
    assert.equal(isTemperatureUnsupported(reject("max_tokens too large", "max_tokens")), false);
    assert.equal(isTemperatureUnsupported(new ProviderError("temperature unsupported", { provider: "p", kind: "infra", status: 503 })), false);
    assert.equal(isTemperatureUnsupported(new Error("temperature not supported")), false);
  });
});
