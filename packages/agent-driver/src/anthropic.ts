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
 * distinguishable from everything else. Retrying them is the worker pool's job in the
 * fan-out milestone; a single trial just reports the classification.
 */
export class ProviderInfraError extends Error {
  constructor(
    message: string,
    readonly status?: number
  ) {
    super(message);
    this.name = "ProviderInfraError";
  }
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
    if (INFRA_STATUS.has(res.status)) throw new ProviderInfraError(message, res.status);
    throw new Error(message);
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
