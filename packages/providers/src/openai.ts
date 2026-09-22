/**
 * OpenAI Chat Completions (https://platform.openai.com/docs/api-reference/chat), plain
 * fetch. Serves `openai`, `azure`, `openai-compatible` and every preset in registry.ts
 * (openrouter, groq, together, deepseek, mistral, xai, fireworks, ollama, lmstudio, vllm).
 *
 * Differences handled here and nowhere else:
 *   - auth: `Authorization: Bearer` (openai and compatibles; omitted when there is no key,
 *     e.g. a local ollama) or `api-key` (azure).
 *   - azure's URL: the v1 API (base_url .../openai/v1, model = deployment name), or with
 *     api_version the dated route /openai/deployments/<deployment>/chat/completions.
 *   - max tokens: openai and azure take max_completion_tokens (max_tokens is deprecated
 *     there and refused by reasoning models); the compatible servers take max_tokens.
 *
 * Assistant turns are rebuilt from the neutral fields rather than replayed verbatim, except
 * that each tool call keeps the exact `arguments` string the model produced. Replaying the
 * whole message would echo provider extensions some servers refuse as input (DeepSeek's
 * reasoning_content, for one).
 *
 * One tool result per `tool` message, in call order. Chat Completions has no is_error
 * flag, so a failed tool call is returned with its error text as the content.
 */
import { obj, parseArguments, postJson, splitParams, str, num, type ParsedError } from "./http.js";
import type { ResolvedModel } from "./registry.js";
import type { ChatMessage, ChatRequest, ChatResponse, EmbedResponse, ModelClient, StopReason, ToolCall } from "./types.js";

interface NativeOpenAiMessage {
  content: string | null;
  tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>;
}

export function openAiMessages(system: string, messages: ChatMessage[]): unknown[] {
  const out: unknown[] = [];
  if (system !== "") out.push({ role: "system", content: system });
  for (const m of messages) {
    if (m.role === "user") {
      out.push({ role: "user", content: m.content });
    } else if (m.role === "tool") {
      for (const r of m.results) out.push({ role: "tool", tool_call_id: r.tool_call_id, content: r.content });
    } else {
      const native = m.native?.protocol === "openai" ? (m.native.content as NativeOpenAiMessage) : null;
      const msg: Record<string, unknown> = { role: "assistant", content: m.text === "" ? null : m.text };
      if (m.tool_calls.length > 0) {
        msg.tool_calls = m.tool_calls.map((c) => {
          const original = native?.tool_calls?.find((t) => t.id === c.id);
          return {
            id: c.id,
            type: "function",
            function: { name: c.name, arguments: original?.function.arguments ?? JSON.stringify(c.input) },
          };
        });
      }
      out.push(msg);
    }
  }
  return out;
}

export function openAiStop(raw: string | null, hasToolCalls: boolean): StopReason {
  if (raw === "tool_calls" || raw === "function_call") return "tool_use";
  if (raw === "length") return "max_tokens";
  // Some compatible servers report "stop" on a turn that does carry tool calls.
  if (hasToolCalls) return "tool_use";
  if (raw === "stop") return "end_turn";
  return "other";
}

export function parseOpenAiError(body: unknown): ParsedError {
  const b = obj(body);
  if (typeof b.error === "string") return { message: b.error };
  const e = obj(b.error);
  const code = str(e.code) ?? (typeof e.code === "number" ? String(e.code) : undefined) ?? str(e.type);
  return { message: str(e.message) ?? str(b.message), code, param: str(e.param) };
}

function isAzure(m: ResolvedModel): boolean {
  return m.provider === "azure";
}

function authHeaders(m: ResolvedModel): Record<string, string> {
  if (!m.api_key) return {};
  return isAzure(m) ? { "api-key": m.api_key } : { authorization: `Bearer ${m.api_key}` };
}

function url(m: ResolvedModel, path: "chat/completions" | "embeddings"): string {
  const base = m.base_url!;
  if (isAzure(m) && m.api_version) {
    return `${base}/openai/deployments/${encodeURIComponent(m.model)}/${path}?api-version=${encodeURIComponent(m.api_version)}`;
  }
  return `${base}/${path}`;
}

export function createOpenAiClient(m: ResolvedModel): ModelClient {
  const maxField = m.info.max_tokens_field ?? "max_tokens";
  const client: ModelClient = {
    provider: m.provider,
    protocol: "openai",
    model: m.model,
    endpoint: m.endpoint,
    async chat(req: ChatRequest): Promise<ChatResponse> {
      const p = splitParams({ ...m.params, ...req.params });
      const paramsSent: Record<string, unknown> = {};
      const body: Record<string, unknown> = { model: m.model, messages: openAiMessages(req.system, req.messages) };
      if (req.tools.length > 0) {
        body.tools = req.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema } }));
      }
      if (p.temperature !== undefined) body.temperature = paramsSent.temperature = p.temperature;
      if (p.top_p !== undefined) body.top_p = paramsSent.top_p = p.top_p;
      if (p.max_tokens !== undefined) body[maxField] = paramsSent.max_tokens = p.max_tokens;
      if (p.stop !== undefined) body.stop = paramsSent.stop = p.stop;
      for (const [k, v] of Object.entries(p.rest)) body[k] = paramsSent[k] = v;

      const { data, headers } = await postJson(m.provider, url(m, "chat/completions"), authHeaders(m), body, {
        signal: req.signal,
        parseError: parseOpenAiError,
      });
      const d = obj(data);
      const choice = obj(Array.isArray(d.choices) ? d.choices[0] : undefined);
      const message = obj(choice.message);
      const rawCalls = Array.isArray(message.tool_calls) ? (message.tool_calls as Array<Record<string, unknown>>) : [];
      const toolCalls: ToolCall[] = rawCalls.map((c, i) => {
        const fn = obj(c.function);
        const parsed = parseArguments(fn.arguments);
        return {
          id: str(c.id) ?? `call_${i}`,
          name: String(fn.name ?? ""),
          input: parsed.input,
          ...(parsed.input_error !== undefined ? { input_error: parsed.input_error } : {}),
        };
      });
      const raw = str(choice.finish_reason) ?? null;
      const usage = obj(d.usage);
      const text = typeof message.content === "string" ? message.content.trim() : "";
      return {
        text,
        tool_calls: toolCalls,
        stop_reason: openAiStop(raw, toolCalls.length > 0),
        raw_stop_reason: raw,
        usage: { input_tokens: num(usage.prompt_tokens), output_tokens: num(usage.completion_tokens) },
        model: str(d.model) ?? null,
        request_id: headers.get("x-request-id") ?? headers.get("apim-request-id") ?? str(d.id) ?? null,
        endpoint: m.endpoint,
        params_sent: paramsSent,
        native: { protocol: "openai", content: message },
      };
    },
  };
  if (m.info.embeddings) {
    client.embed = async (texts: string[], signal?: AbortSignal): Promise<EmbedResponse> => {
      const { data } = await postJson(m.provider, url(m, "embeddings"), authHeaders(m), { model: m.model, input: texts }, { signal, parseError: parseOpenAiError });
      const d = obj(data);
      const rows = (Array.isArray(d.data) ? (d.data as Array<Record<string, unknown>>) : []).slice();
      rows.sort((a, b) => num(a.index) - num(b.index));
      return { vectors: rows.map((r) => (Array.isArray(r.embedding) ? (r.embedding as number[]) : [])), model: str(d.model) ?? null };
    };
  }
  return client;
}
