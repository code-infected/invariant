import { createAnthropicClient } from "./anthropic.js";
import { createBedrockClient } from "./bedrock.js";
import { createGeminiClient } from "./gemini.js";
import { createOpenAiClient } from "./openai.js";
import { resolveModel, type ModelSpec, type ResolvedModel } from "./registry.js";
import type { ModelClient } from "./types.js";

/** A client for a resolved model, speaking that provider's native wire protocol. */
export function createModelClient(model: ResolvedModel): ModelClient {
  switch (model.info.protocol) {
    case "anthropic":
      return createAnthropicClient(model);
    case "openai":
      return createOpenAiClient(model);
    case "gemini":
      return createGeminiClient(model);
    case "bedrock":
      return createBedrockClient(model);
  }
}

/**
 * Resolve a spec and build its client. With `missing`, a missing key throws that message
 * (the caller's own, saying what the call was for); otherwise a generic one.
 */
export function clientFor(spec: ModelSpec, options: { env?: NodeJS.ProcessEnv; missing?: (spec: ModelSpec) => string } = {}): ModelClient {
  return createModelClient(resolveModel(spec, { ...options, requireKey: true }));
}
