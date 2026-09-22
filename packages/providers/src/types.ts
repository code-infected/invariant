/**
 * The provider-neutral model interface every model call in invariant goes through: the
 * agent under test, the outcome judge, the paraphraser and the embedder.
 *
 * Deliberately small, and deliberately lossless where it matters for measurement: every
 * response carries the model id the provider REPORTED (not the one asked for), the raw
 * stop reason next to the normalized one, the usage the provider counted, and its request
 * id. Adapters never retry and never rewrite a request; retry policy belongs to the
 * harness, which has to tell infra flakiness from behaviour.
 */

/** The four wire protocols invariant speaks natively. Every provider maps onto one. */
export type WireProtocol = "anthropic" | "openai" | "gemini" | "bedrock";

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema for the tool's input, exactly as the tool server exposed it. */
  input_schema: Record<string, unknown>;
}

export interface ToolCall {
  /** Provider-assigned id when there is one; otherwise one the adapter made up (see gemini.ts). */
  id: string;
  name: string;
  input: Record<string, unknown>;
  /**
   * Set when the provider returned arguments that are not a JSON object (a malformed
   * function call from the model). `input` is then {} and the raw text is kept here.
   */
  input_error?: string;
}

export interface ToolResult {
  tool_call_id: string;
  /** The tool's name; Gemini's functionResponse is matched by name, so every result carries it. */
  name: string;
  content: string;
  is_error: boolean;
}

/**
 * The assistant turn exactly as the provider sent it, for replaying it on the next request
 * of the same conversation. Some providers require this (Gemini's thoughtSignature must be
 * returned unchanged; Anthropic thinking blocks likewise), and re-deriving it from the
 * neutral fields would silently drop what they did not model.
 */
export interface NativeTurn {
  protocol: WireProtocol;
  content: unknown;
}

export type ChatMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; text: string; tool_calls: ToolCall[]; native?: NativeTurn }
  | { role: "tool"; results: ToolResult[] };

/**
 * Model parameters. Four neutral keys are mapped to each provider's own field name
 * (temperature, top_p, max_tokens, stop); every other key is passed through verbatim into
 * the request body (Bedrock: additionalModelRequestFields), so provider-specific knobs such
 * as reasoning_effort need no code change. Nothing is ever set that is not in here, apart
 * from the one field a protocol requires (Anthropic's max_tokens), which is reported in
 * ChatResponse.params_sent like everything else.
 */
export type ModelParams = Record<string, unknown>;

export interface ChatRequest {
  system: string;
  messages: ChatMessage[];
  tools: ToolSpec[];
  params?: ModelParams;
  /** Aborts the request; the agent driver uses it to enforce the task's wall clock. */
  signal?: AbortSignal;
}

export type StopReason = "tool_use" | "end_turn" | "max_tokens" | "other";

export interface Usage {
  input_tokens: number;
  output_tokens: number;
}

export interface ChatResponse {
  text: string;
  /** In the order the provider listed them. */
  tool_calls: ToolCall[];
  stop_reason: StopReason;
  /** The provider's own value (e.g. "tool_calls", "STOP", "end_turn"); null if it sent none. */
  raw_stop_reason: string | null;
  usage: Usage;
  /** The model id the provider reported answering with; null when the API does not report one (Bedrock Converse). */
  model: string | null;
  request_id: string | null;
  /** Host (and port) of the endpoint that answered. Never a full URL, never credentials. */
  endpoint: string | null;
  /** The parameters actually sent, in neutral form. */
  params_sent: ModelParams;
  native: NativeTurn;
}

export interface EmbedResponse {
  vectors: number[][];
  model: string | null;
}

export interface ModelClient {
  /** Provider name as configured, e.g. "openai", "ollama", "anthropic". */
  readonly provider: string;
  readonly protocol: WireProtocol;
  /** Model id as configured (the part after "provider:"). */
  readonly model: string;
  /** Host of the configured endpoint, when known before the first call; see ChatResponse.endpoint. */
  readonly endpoint: string | null;
  chat(request: ChatRequest): Promise<ChatResponse>;
  /** Present only for providers with an embeddings API. */
  embed?(texts: string[], signal?: AbortSignal): Promise<EmbedResponse>;
  /**
   * Present only for providers whose credentials come from somewhere other than one env
   * variable (bedrock: the AWS chain). Resolves them without calling the model; throws if
   * they cannot be found. Never returns or logs them.
   */
  checkCredentials?(): Promise<void>;
}

/**
 * Every provider failure, typed once.
 *
 *   infra     the provider could not answer: rate limit, overload, 5xx, timeout, dropped
 *             connection. Transient; the harness's retry policy decides what to do.
 *   rejected  the provider answered and refused: bad request, bad key, unknown model.
 *             Not transient, never retried, and not a harness bug either.
 *
 * `status` is the HTTP status (absent for a transport failure with no response); `code` is
 * the provider's own error code or type when it sent one (e.g. "rate_limit_error",
 * "RESOURCE_EXHAUSTED", "ThrottlingException", "unsupported_value"); `param` is the
 * request field the provider blamed, when it says (OpenAI does).
 */
export class ProviderError extends Error {
  readonly provider: string;
  readonly kind: "infra" | "rejected";
  readonly status?: number;
  readonly code?: string;
  readonly param?: string;
  readonly retryAfterMs?: number;
  readonly requestId?: string;

  constructor(
    message: string,
    options: {
      provider: string;
      kind: "infra" | "rejected";
      status?: number;
      code?: string;
      param?: string;
      retryAfterMs?: number;
      requestId?: string;
    }
  ) {
    super(message);
    this.name = "ProviderError";
    this.provider = options.provider;
    this.kind = options.kind;
    if (options.status !== undefined) this.status = options.status;
    if (options.code !== undefined) this.code = options.code;
    if (options.param !== undefined) this.param = options.param;
    if (options.retryAfterMs !== undefined) this.retryAfterMs = options.retryAfterMs;
    if (options.requestId !== undefined) this.requestId = options.requestId;
  }
}

export function isProviderError(err: unknown): err is ProviderError {
  return err instanceof ProviderError;
}

/**
 * HTTP statuses that mean "the provider could not answer right now". 529 is Anthropic's
 * overload status; 408 a request timeout. Everything else 4xx is a rejection.
 */
export const INFRA_STATUS: ReadonlySet<number> = new Set([408, 429, 500, 502, 503, 504, 529]);

export function classifyStatus(status: number): "infra" | "rejected" {
  return INFRA_STATUS.has(status) || status >= 500 ? "infra" : "rejected";
}

/** retry-after is either delta-seconds or an HTTP date. Anything else is ignored. */
export function parseRetryAfter(header: string | null | undefined, now = Date.now()): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const at = Date.parse(header);
  if (!Number.isNaN(at)) return Math.max(0, at - now);
  return undefined;
}

/**
 * True when a rejection is the provider refusing the temperature parameter (e.g. OpenAI
 * reasoning models: 400, param "temperature", code "unsupported_value"). Used by the judge
 * to retry once without temperature and RECORD that it did; never to drop it silently.
 */
export function isTemperatureUnsupported(err: unknown): boolean {
  if (!(err instanceof ProviderError) || err.kind !== "rejected" || err.status !== 400) return false;
  if (err.param === "temperature") return true;
  return /temperature/i.test(err.message) && /(unsupported|not support|does not support|invalid|only the default|deprecated)/i.test(err.message);
}

/**
 * Build a ChatResponse by hand. For the scripted stand-ins behind TrialDeps.callModel (the
 * SYNTHETIC fixtures and tests), never for a real provider response.
 */
export function scriptedResponse(turn: {
  text?: string;
  tool_calls?: ToolCall[];
  model?: string | null;
  stop_reason?: StopReason;
  usage?: Usage;
}): ChatResponse {
  const toolCalls = turn.tool_calls ?? [];
  const stop = turn.stop_reason ?? (toolCalls.length > 0 ? "tool_use" : "end_turn");
  return {
    text: turn.text ?? "",
    tool_calls: toolCalls,
    stop_reason: stop,
    raw_stop_reason: stop,
    usage: turn.usage ?? { input_tokens: 10, output_tokens: 5 },
    model: turn.model === undefined ? "scripted-stand-in" : turn.model,
    request_id: null,
    endpoint: null,
    params_sent: {},
    native: { protocol: "anthropic", content: null },
  };
}
