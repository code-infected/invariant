/**
 * The thinnest possible Anthropic Messages API client: just enough for a tool-use loop.
 *
 * Deliberately plain fetch rather than the vendor SDK, matching the existing
 * variants-regen command in @invariant/cli. The harness calls exactly one endpoint and
 * the request/response shape it depends on is small; a dependency would mostly buy
 * surface area this project doesn't use.
 */

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock | { type: string; [k: string]: unknown };

export interface Message {
  role: "user" | "assistant";
  content: string | ContentBlock[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface MessagesResponse {
  id: string;
  model: string;
  stop_reason: string | null;
  content: ContentBlock[];
  usage: { input_tokens: number; output_tokens: number };
}

/**
 * A provider-side failure: rate limit, overload, timeout, dropped connection. The
 * architecture treats these as infra flakiness, not agent inconsistency, so they are
 * distinguishable from everything else. A single trial only reports the classification;
 * whether it is retried is decided by the batch runner's retry policy (retry.ts), which
 * reads the HTTP status off this error.
 */
export class ProviderInfraError extends Error {
  constructor(
    message: string,
    /** HTTP status; undefined for a transport-level failure (no response at all). */
    readonly status?: number,
    /** Parsed from the provider's retry-after header, when it sent one. */
    readonly retryAfterMs?: number
  ) {
    super(message);
    this.name = "ProviderInfraError";
  }
}

/**
 * The provider answered, and refused: 400 (malformed request), 401/403 (bad key), 404
 * (unknown model), and so on. Not transient, so never retried, and not a harness bug
 * either; kept distinct so a run matrix full of 401s reads as "fix the key", not "flaky".
 */
export class ProviderRejectedError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = "ProviderRejectedError";
  }
}

/** retry-after is either delta-seconds or an HTTP date. Anything else is ignored. */
export function parseRetryAfter(header: string | null, now = Date.now()): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const at = Date.parse(header);
  if (!Number.isNaN(at)) return Math.max(0, at - now);
  return undefined;
}

const INFRA_STATUS = new Set([408, 429, 500, 502, 503, 504, 529]);

export function requireApiKey(explicit?: string): string {
  const apiKey = explicit ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set. Running a trial drives the agent under test through " +
        "the real Messages API and needs a real key, there is no offline fallback because " +
        "a faked agent response would produce a trace that measures nothing. Set the key " +
        "and re-run."
    );
  }
  return apiKey;
}

export interface CallMessagesOptions {
  apiKey: string;
  model: string;
  system: string;
  messages: Message[];
  tools: ToolDefinition[];
  maxTokens?: number;
  /** Aborts the request; used to enforce the task's max_wall_clock_seconds. */
  signal?: AbortSignal;
}

export async function callMessages(options: CallMessagesOptions): Promise<MessagesResponse> {
  let res: Response;
  try {
    res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": options.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: options.model,
        max_tokens: options.maxTokens ?? 2048,
        system: options.system,
        tools: options.tools,
        messages: options.messages,
      }),
      signal: options.signal,
    });
  } catch (err) {
    // Network-level failure, including an abort from the wall-clock deadline.
    throw new ProviderInfraError(err instanceof Error ? err.message : String(err));
  }

  if (!res.ok) {
    const body = await res.text();
    const message = `Anthropic API request failed (${res.status}): ${body}`;
    if (INFRA_STATUS.has(res.status)) {
      throw new ProviderInfraError(message, res.status, parseRetryAfter(res.headers.get("retry-after")));
    }
    throw new ProviderRejectedError(message, res.status);
  }

  return (await res.json()) as MessagesResponse;
}

export function isToolUse(block: ContentBlock): block is ToolUseBlock {
  return block.type === "tool_use";
}

export function textOf(content: ContentBlock[]): string {
  return content
    .filter((b): b is TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}
