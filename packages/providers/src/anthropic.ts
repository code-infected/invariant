/**
 * Anthropic Messages API (https://docs.anthropic.com/en/api/messages), plain fetch.
 *
 * max_tokens is the one field this protocol requires, so it is always sent (2048 unless
 * params.max_tokens says otherwise) and reported in params_sent. Nothing else is set that
 * the config did not ask for.
 */
import { obj, postJson, splitParams, str, num, type ParsedError } from "./http.js";
import type { ResolvedModel } from "./registry.js";
import type { ChatMessage, ChatRequest, ChatResponse, ModelClient, StopReason, ToolCall } from "./types.js";

export const ANTHROPIC_VERSION = "2023-06-01";
export const ANTHROPIC_DEFAULT_MAX_TOKENS = 2048;

export function anthropicMessages(messages: ChatMessage[]): unknown[] {
  return messages.map((m) => {
    if (m.role === "user") return { role: "user", content: m.content };
    if (m.role === "tool") {
      return {
        role: "user",
        content: m.results.map((r) => ({ type: "tool_result", tool_use_id: r.tool_call_id, content: r.content, is_error: r.is_error })),
      };
    }
    if (m.native?.protocol === "anthropic") return { role: "assistant", content: m.native.content };
    const content: unknown[] = [];
    if (m.text !== "") content.push({ type: "text", text: m.text });
    for (const c of m.tool_calls) content.push({ type: "tool_use", id: c.id, name: c.name, input: c.input });
    return { role: "assistant", content };
  });
}

export function anthropicStop(raw: string | null): StopReason {
  if (raw === "tool_use") return "tool_use";
  if (raw === "end_turn" || raw === "stop_sequence") return "end_turn";
  if (raw === "max_tokens") return "max_tokens";
  return "other";
}

export function parseAnthropicError(body: unknown): ParsedError {
  const e = obj(obj(body).error);
  return { message: str(e.message), code: str(e.type) };
}

export function createAnthropicClient(m: ResolvedModel): ModelClient {
  const base = m.base_url ?? "https://api.anthropic.com";
  return {
    provider: m.provider,
    protocol: "anthropic",
    model: m.model,
    endpoint: m.endpoint,
    async chat(req: ChatRequest): Promise<ChatResponse> {
      const p = splitParams({ ...m.params, ...req.params });
      const maxTokens = p.max_tokens ?? ANTHROPIC_DEFAULT_MAX_TOKENS;
      const paramsSent: Record<string, unknown> = { max_tokens: maxTokens };
      const body: Record<string, unknown> = { model: m.model, max_tokens: maxTokens };
      if (req.system !== "") body.system = req.system;
      if (req.tools.length > 0) body.tools = req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema }));
      body.messages = anthropicMessages(req.messages);
      if (p.temperature !== undefined) body.temperature = paramsSent.temperature = p.temperature;
      if (p.top_p !== undefined) body.top_p = paramsSent.top_p = p.top_p;
      if (p.stop !== undefined) body.stop_sequences = paramsSent.stop = p.stop;
      for (const [k, v] of Object.entries(p.rest)) body[k] = paramsSent[k] = v;

      const headers: Record<string, string> = { "anthropic-version": ANTHROPIC_VERSION };
      if (m.api_key) headers["x-api-key"] = m.api_key;
      const { data, headers: h } = await postJson(m.provider, `${base}/v1/messages`, headers, body, {
        signal: req.signal,
        parseError: parseAnthropicError,
        requestIdHeader: "request-id",
      });
      const d = obj(data);
      const content = Array.isArray(d.content) ? (d.content as Array<Record<string, unknown>>) : [];
      const toolCalls: ToolCall[] = content
        .filter((b) => b.type === "tool_use")
        .map((b) => ({ id: String(b.id ?? ""), name: String(b.name ?? ""), input: obj(b.input) }));
      const text = content
        .filter((b) => b.type === "text")
        .map((b) => String(b.text ?? ""))
        .join("\n")
        .trim();
      const raw = str(d.stop_reason) ?? null;
      const usage = obj(d.usage);
      return {
        text,
        tool_calls: toolCalls,
        stop_reason: anthropicStop(raw),
        raw_stop_reason: raw,
        usage: { input_tokens: num(usage.input_tokens), output_tokens: num(usage.output_tokens) },
        model: str(d.model) ?? null,
        request_id: h.get("request-id") ?? str(d.id) ?? null,
        endpoint: m.endpoint,
        params_sent: paramsSent,
        native: { protocol: "anthropic", content },
      };
    },
  };
}
