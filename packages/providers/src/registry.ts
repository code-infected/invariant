/**
 * Model references ("provider:model"), the provider registry, and credentials.
 *
 * A reference splits on the FIRST colon only: "ollama:qwen2.5:3b" is provider "ollama",
 * model "qwen2.5:3b". Every provider maps onto one of four native wire protocols
 * (types.ts WireProtocol); the OpenAI-compatible presets differ only in base URL and in
 * which environment variable holds the key.
 *
 * Preset base URLs and key variables were checked against each provider's own docs on
 * 2026-09-22 (URLs in the comments). Re-check them there before changing one; do not
 * "fix" one from memory.
 */
import type { ModelParams, WireProtocol } from "./types.js";

export interface ProviderInfo {
  name: string;
  protocol: WireProtocol;
  /** Default base URL; absent when the user must supply one (azure, vllm, openai-compatible) or the SDK derives it (bedrock). */
  base_url?: string;
  base_url_required?: boolean;
  /**
   * Conventional key variables, in precedence order (the first one set wins). Empty for
   * providers that take no key (local servers) or authenticate some other way (bedrock).
   */
  key_env: string[];
  /** A key is needed unless the provider is keyless. api_key_env in the config always makes one required. */
  key_required: boolean;
  /** Human description of how credentials are found, for messages and `invariant doctor`. */
  auth: string;
  /** Has an embeddings API that the embedder role can use. */
  embeddings: boolean;
  /** OpenAI protocol only: which max-tokens field the endpoint expects. */
  max_tokens_field?: "max_tokens" | "max_completion_tokens";
  docs: string;
}

const P = (info: ProviderInfo): ProviderInfo => info;

export const PROVIDERS: Readonly<Record<string, ProviderInfo>> = {
  anthropic: P({
    name: "anthropic",
    protocol: "anthropic",
    base_url: "https://api.anthropic.com",
    key_env: ["ANTHROPIC_API_KEY"],
    key_required: true,
    auth: "ANTHROPIC_API_KEY",
    embeddings: false,
    docs: "https://docs.anthropic.com/en/api/messages",
  }),
  openai: P({
    name: "openai",
    protocol: "openai",
    base_url: "https://api.openai.com/v1",
    key_env: ["OPENAI_API_KEY"],
    key_required: true,
    auth: "OPENAI_API_KEY",
    embeddings: true,
    // max_tokens is deprecated on OpenAI and rejected by its reasoning models.
    max_tokens_field: "max_completion_tokens",
    docs: "https://platform.openai.com/docs/api-reference/chat",
  }),
  // Azure OpenAI, v1 API: base_url https://<resource>.openai.azure.com/openai/v1, `api-key`
  // header, model = deployment name, no api-version needed. Setting api_version switches
  // to the older /openai/deployments/<model>/chat/completions?api-version=... route.
  // Checked: https://learn.microsoft.com/en-us/azure/ai-foundry/openai/api-version-lifecycle
  azure: P({
    name: "azure",
    protocol: "openai",
    base_url_required: true,
    key_env: ["AZURE_OPENAI_API_KEY"],
    key_required: true,
    auth: "AZURE_OPENAI_API_KEY",
    embeddings: true,
    max_tokens_field: "max_completion_tokens",
    docs: "https://learn.microsoft.com/en-us/azure/ai-foundry/openai/api-version-lifecycle",
  }),
  // Google's docs: "Set the environment variable GEMINI_API_KEY or GOOGLE_API_KEY ... If
  // both are set, GOOGLE_API_KEY takes precedence." Header x-goog-api-key.
  // Checked: https://ai.google.dev/gemini-api/docs/api-key
  gemini: P({
    name: "gemini",
    protocol: "gemini",
    base_url: "https://generativelanguage.googleapis.com/v1beta",
    key_env: ["GOOGLE_API_KEY", "GEMINI_API_KEY"],
    key_required: true,
    auth: "GOOGLE_API_KEY or GEMINI_API_KEY (GOOGLE_API_KEY wins if both are set)",
    embeddings: true,
    docs: "https://ai.google.dev/api/generate-content",
  }),
  bedrock: P({
    name: "bedrock",
    protocol: "bedrock",
    key_env: [],
    key_required: false,
    auth: "the standard AWS credential chain (AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY, AWS_PROFILE, SSO, web identity, instance/container role) and a region (AWS_REGION, or `region` in the config)",
    embeddings: true,
    docs: "https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_Converse.html",
  }),
  "openai-compatible": P({
    name: "openai-compatible",
    protocol: "openai",
    base_url_required: true,
    key_env: [],
    key_required: false,
    auth: "the variable named by api_key_env (no key is sent if api_key_env is not set)",
    embeddings: true,
    max_tokens_field: "max_tokens",
    docs: "https://platform.openai.com/docs/api-reference/chat",
  }),
  // Checked: https://openrouter.ai/docs/quickstart
  openrouter: P({
    name: "openrouter",
    protocol: "openai",
    base_url: "https://openrouter.ai/api/v1",
    key_env: ["OPENROUTER_API_KEY"],
    key_required: true,
    auth: "OPENROUTER_API_KEY",
    embeddings: true,
    max_tokens_field: "max_tokens",
    docs: "https://openrouter.ai/docs/quickstart",
  }),
  // Checked: https://console.groq.com/docs/openai
  groq: P({
    name: "groq",
    protocol: "openai",
    base_url: "https://api.groq.com/openai/v1",
    key_env: ["GROQ_API_KEY"],
    key_required: true,
    auth: "GROQ_API_KEY",
    embeddings: false,
    max_tokens_field: "max_tokens",
    docs: "https://console.groq.com/docs/openai",
  }),
  // Checked: https://docs.together.ai/docs/openai-api-compatibility (base https://api.together.ai/v1)
  together: P({
    name: "together",
    protocol: "openai",
    base_url: "https://api.together.ai/v1",
    key_env: ["TOGETHER_API_KEY"],
    key_required: true,
    auth: "TOGETHER_API_KEY",
    embeddings: true,
    max_tokens_field: "max_tokens",
    docs: "https://docs.together.ai/docs/openai-api-compatibility",
  }),
  // Checked: https://api-docs.deepseek.com/ (base_url https://api.deepseek.com, key DEEPSEEK_API_KEY)
  deepseek: P({
    name: "deepseek",
    protocol: "openai",
    base_url: "https://api.deepseek.com",
    key_env: ["DEEPSEEK_API_KEY"],
    key_required: true,
    auth: "DEEPSEEK_API_KEY",
    embeddings: false,
    max_tokens_field: "max_tokens",
    docs: "https://api-docs.deepseek.com/",
  }),
  // Checked: https://docs.mistral.ai/api/ (https://api.mistral.ai/v1/chat/completions, MISTRAL_API_KEY)
  mistral: P({
    name: "mistral",
    protocol: "openai",
    base_url: "https://api.mistral.ai/v1",
    key_env: ["MISTRAL_API_KEY"],
    key_required: true,
    auth: "MISTRAL_API_KEY",
    embeddings: true,
    max_tokens_field: "max_tokens",
    docs: "https://docs.mistral.ai/api/",
  }),
  // Checked: https://docs.x.ai/developers/model-capabilities/legacy/chat-completions
  // xAI now calls /v1/chat/completions a "legacy endpoint" (new features go to its Responses
  // API first) but still serves it; that is the endpoint this preset uses.
  xai: P({
    name: "xai",
    protocol: "openai",
    base_url: "https://api.x.ai/v1",
    key_env: ["XAI_API_KEY"],
    key_required: true,
    auth: "XAI_API_KEY",
    embeddings: false,
    max_tokens_field: "max_tokens",
    docs: "https://docs.x.ai/developers/model-capabilities/legacy/chat-completions",
  }),
  // Checked: https://docs.fireworks.ai/getting-started/quickstart (FIREWORKS_API_KEY) and
  // https://docs.fireworks.ai/tools-sdks/openai-compatibility (base URL).
  fireworks: P({
    name: "fireworks",
    protocol: "openai",
    base_url: "https://api.fireworks.ai/inference/v1",
    key_env: ["FIREWORKS_API_KEY"],
    key_required: true,
    auth: "FIREWORKS_API_KEY",
    embeddings: true,
    max_tokens_field: "max_tokens",
    docs: "https://docs.fireworks.ai/tools-sdks/openai-compatibility",
  }),
  // Checked: https://docs.ollama.com/api/openai-compatibility (http://localhost:11434/v1/,
  // key "required but ignored" by OpenAI client libraries; invariant sends none). /v1/embeddings supported.
  ollama: P({
    name: "ollama",
    protocol: "openai",
    base_url: "http://localhost:11434/v1",
    key_env: [],
    key_required: false,
    auth: "no key (local server)",
    embeddings: true,
    max_tokens_field: "max_tokens",
    docs: "https://docs.ollama.com/api/openai-compatibility",
  }),
  // Checked: https://lmstudio.ai/docs/developer/openai-compat (http://localhost:1234/v1)
  lmstudio: P({
    name: "lmstudio",
    protocol: "openai",
    base_url: "http://localhost:1234/v1",
    key_env: [],
    key_required: false,
    auth: "no key (local server)",
    embeddings: true,
    max_tokens_field: "max_tokens",
    docs: "https://lmstudio.ai/docs/developer/openai-compat",
  }),
  // vLLM's server has no fixed public address, so base_url is required (vllm serve listens
  // on :8000 by default). It checks a key only when started with --api-key / VLLM_API_KEY;
  // invariant sends VLLM_API_KEY when it is set. Tool calls need the server started with
  // --enable-auto-tool-choice and a --tool-call-parser.
  // Checked: https://github.com/vllm-project/vllm/blob/main/docs/features/tool_calling.md, vllm/envs.py
  vllm: P({
    name: "vllm",
    protocol: "openai",
    base_url_required: true,
    key_env: ["VLLM_API_KEY"],
    key_required: false,
    auth: "VLLM_API_KEY if the server was started with an API key (optional)",
    embeddings: true,
    max_tokens_field: "max_tokens",
    docs: "https://docs.vllm.ai/en/latest/serving/online_serving/",
  }),
};

export const KNOWN_PROVIDERS: readonly string[] = Object.keys(PROVIDERS);

export class ModelConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelConfigError";
  }
}

export interface ModelRef {
  provider: string;
  model: string;
}

/** "provider:model", split on the first colon only. Throws ModelConfigError with the known providers listed. */
export function parseModelRef(ref: string): ModelRef {
  const i = ref.indexOf(":");
  if (i <= 0 || i === ref.length - 1) {
    throw new ModelConfigError(
      `model reference "${ref}" is not of the form provider:model (e.g. anthropic:claude-sonnet-4-5, ollama:qwen2.5:3b). ` +
        `Known providers: ${KNOWN_PROVIDERS.join(", ")}.`
    );
  }
  const provider = ref.slice(0, i).trim();
  const model = ref.slice(i + 1).trim();
  if (!PROVIDERS[provider]) {
    throw new ModelConfigError(`unknown provider "${provider}" in model reference "${ref}". Known providers: ${KNOWN_PROVIDERS.join(", ")}.`);
  }
  if (model === "") throw new ModelConfigError(`model reference "${ref}" has an empty model id.`);
  return { provider, model };
}

/** One configured model role, as in invariant.config.yaml `models.<role>`. */
export interface ModelSpec {
  /** "provider:model". */
  model: string;
  base_url?: string;
  api_key_env?: string;
  params?: ModelParams;
  /** azure only: use the dated api-version route instead of the v1 API. */
  api_version?: string;
  /** bedrock only: AWS region (otherwise the SDK's own resolution: AWS_REGION, profile...). */
  region?: string;
}

/** Everything needed to build a client, credentials resolved. */
export interface ResolvedModel {
  ref: string;
  provider: string;
  model: string;
  info: ProviderInfo;
  base_url: string | null;
  /** Host (and port) of base_url; null for bedrock until the SDK resolves its region. */
  endpoint: string | null;
  /** The key, when the provider takes one and it is set. Never logged. */
  api_key: string | null;
  /** Which variable the key came from, or which ones were looked for. */
  key_source: string | null;
  params: ModelParams;
  api_version?: string;
  region?: string;
}

/** Host[:port] of a URL. Credentials and path are dropped by construction. */
export function endpointHost(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).host || null;
  } catch {
    return null;
  }
}

/** The env variables a spec's credentials are read from, in precedence order. */
export function credentialEnvNames(spec: ModelSpec): string[] {
  const { provider } = parseModelRef(spec.model);
  if (spec.api_key_env) return [spec.api_key_env];
  return [...PROVIDERS[provider]!.key_env];
}

export interface CredentialStatus {
  /** "present": a key is set; "missing": a required key is not; "not_needed": keyless; "aws_chain": resolved by the AWS SDK at call time. */
  state: "present" | "missing" | "not_needed" | "aws_chain";
  /** The variable the key was read from (present), or the ones looked for (missing). */
  env: string[];
}

export function credentialStatus(spec: ModelSpec, env: NodeJS.ProcessEnv = process.env): CredentialStatus {
  const { provider } = parseModelRef(spec.model);
  const info = PROVIDERS[provider]!;
  if (info.protocol === "bedrock" && !spec.api_key_env) return { state: "aws_chain", env: [] };
  const names = credentialEnvNames(spec);
  const found = names.find((n) => (env[n] ?? "") !== "");
  if (found) return { state: "present", env: [found] };
  const required = spec.api_key_env !== undefined || info.key_required;
  return required ? { state: "missing", env: names } : { state: "not_needed", env: names };
}

/**
 * The missing-key error, in the repo's style: what is missing, why there is no offline
 * fallback, what to do. `purpose` says what the call was for ("Running a trial drives the
 * agent under test", ...).
 */
export function missingCredentialMessage(spec: ModelSpec, purpose: string, consequence: string): string {
  const { provider } = parseModelRef(spec.model);
  const names = credentialEnvNames(spec);
  const which = names.length === 1 ? names[0]! : names.join(" or ");
  const verb = names.length === 1 ? "is" : "are";
  return (
    `${which} ${verb} not set. ${purpose} (${spec.model}, provider ${provider}) and needs a real key, ` +
    `there is no offline fallback because ${consequence}. Set ${names.length === 1 ? "it" : "one of them"} and re-run` +
    (spec.api_key_env ? ` (api_key_env in invariant.config.yaml names ${spec.api_key_env}).` : ".")
  );
}

/**
 * Resolve a spec: provider, base URL, endpoint host, key. Throws ModelConfigError for a
 * config problem (unknown provider, missing base_url) and, when `requireKey`, for a
 * missing key (with `missing` supplying the message).
 */
export function resolveModel(
  spec: ModelSpec,
  options: { env?: NodeJS.ProcessEnv; requireKey?: boolean; missing?: (spec: ModelSpec) => string } = {}
): ResolvedModel {
  const env = options.env ?? process.env;
  const { provider, model } = parseModelRef(spec.model);
  const info = PROVIDERS[provider]!;
  const baseUrl = (spec.base_url ?? info.base_url ?? null)?.replace(/\/+$/, "") ?? null;
  if (info.base_url_required && !spec.base_url) {
    throw new ModelConfigError(
      `provider ${provider} needs base_url in invariant.config.yaml (${
        provider === "azure" ? "e.g. https://<resource>.openai.azure.com/openai/v1" : "the server's OpenAI-compatible URL, e.g. http://localhost:8000/v1"
      }).`
    );
  }
  if (spec.api_version !== undefined && provider !== "azure") throw new ModelConfigError(`api_version applies to provider azure only, not ${provider}.`);
  if (spec.region !== undefined && provider !== "bedrock") throw new ModelConfigError(`region applies to provider bedrock only, not ${provider}.`);
  const status = credentialStatus(spec, env);
  if (status.state === "missing" && options.requireKey) {
    throw new ModelConfigError(
      options.missing ? options.missing(spec) : missingCredentialMessage(spec, "This call goes to a real model", "a faked response would measure nothing")
    );
  }
  let endpoint = endpointHost(baseUrl);
  if (info.protocol === "bedrock" && !baseUrl) {
    const region = spec.region ?? env.AWS_REGION ?? env.AWS_DEFAULT_REGION;
    endpoint = region ? `bedrock-runtime.${region}.amazonaws.com` : null;
  }
  return {
    ref: `${provider}:${model}`,
    provider,
    model,
    info,
    base_url: baseUrl,
    endpoint,
    api_key: status.state === "present" ? env[status.env[0]!]! : null,
    key_source: status.env.length > 0 ? status.env.join(" or ") : null,
    params: { ...(spec.params ?? {}) },
    ...(spec.api_version !== undefined ? { api_version: spec.api_version } : {}),
    ...(spec.region !== undefined ? { region: spec.region } : {}),
  };
}
