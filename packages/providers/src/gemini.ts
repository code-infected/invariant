/**
 * Gemini API, native generateContent (https://ai.google.dev/api/generate-content), plain
 * fetch; not Google's OpenAI-compatibility shim.
 *
 *   tools          one Tool with functionDeclarations; each declaration carries the MCP
 *                  input schema as parametersJsonSchema (full JSON Schema), not
 *                  `parameters` (an OpenAPI subset that rejects keys MCP servers use).
 *   system prompt  systemInstruction.
 *   model turns    replayed verbatim on the next request: Gemini attaches thoughtSignature
 *                  to parts (function calls included) and expects them back unchanged.
 *   tool results   one user turn with a functionResponse part per call, in call order:
 *                  {name, id?, response: {output}} or {error} for a failed call (the API
 *                  reference suggests "output"/"error" keys).
 *   call ids       FunctionCall.id is optional in the API. When the model sends one it is
 *                  echoed on the functionResponse; when it does not, the adapter makes one
 *                  up (prefix GENERATED_ID_PREFIX) for the harness's own bookkeeping and
 *                  sends no id, so nothing the provider did not say is put in its mouth.
 *   passthrough    params keys other than the four neutral ones go into generationConfig
 *                  (e.g. thinkingConfig).
 *   usage          output_tokens = candidatesTokenCount + thoughtsTokenCount (thinking
 *                  tokens are generated and billed as output).
 *   stop reason    finishReason is STOP for a turn that calls functions too, so any turn
 *                  with a functionCall is tool_use.
 *
 * Errors: {error: {code, message, status, details}}. status (e.g. RESOURCE_EXHAUSTED,
 * UNAVAILABLE) becomes ProviderError.code; a RetryInfo detail's retryDelay ("30s") is used
 * as retry-after when there is no header.
 */
import { obj, postJson, splitParams, str, num, type ParsedError } from "./http.js";
import type { ResolvedModel } from "./registry.js";
import type { ChatMessage, ChatRequest, ChatResponse, EmbedResponse, ModelClient, StopReason, ToolCall } from "./types.js";

export const GENERATED_ID_PREFIX = "invariant-generated:";

export function geminiContents(messages: ChatMessage[]): unknown[] {
  return messages.map((m) => {
    if (m.role === "user") return { role: "user", parts: [{ text: m.content }] };
    if (m.role === "tool") {
      return {
        role: "user",
        parts: m.results.map((r) => ({
          functionResponse: {
            ...(r.tool_call_id.startsWith(GENERATED_ID_PREFIX) ? {} : { id: r.tool_call_id }),
            name: r.name,
            response: r.is_error ? { error: r.content } : { output: r.content },
          },
        })),
      };
    }
    if (m.native?.protocol === "gemini") return m.native.content;
    const parts: unknown[] = [];
    if (m.text !== "") parts.push({ text: m.text });
    for (const c of m.tool_calls) {
      parts.push({ functionCall: { ...(c.id.startsWith(GENERATED_ID_PREFIX) ? {} : { id: c.id }), name: c.name, args: c.input } });
    }
    return { role: "model", parts };
  });
}

function parseDuration(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const m = /^(\d+(?:\.\d+)?)s$/.exec(value.trim());
  return m ? Math.round(Number(m[1]) * 1000) : undefined;
}

export function parseGeminiError(body: unknown): ParsedError {
  const b = Array.isArray(body) ? obj(body[0]) : obj(body);
  const e = obj(b.error);
  const details = Array.isArray(e.details) ? (e.details as Array<Record<string, unknown>>) : [];
  const retry = details.find((d) => String(d["@type"] ?? "").endsWith("google.rpc.RetryInfo"));
  const retryAfterMs = parseDuration(retry?.retryDelay);
  return { message: str(e.message), code: str(e.status), ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) };
}

export function geminiStop(raw: string | null, hasToolCalls: boolean): StopReason {
  if (hasToolCalls) return "tool_use";
  if (raw === "STOP") return "end_turn";
  if (raw === "MAX_TOKENS") return "max_tokens";
  return "other";
}

export function createGeminiClient(m: ResolvedModel): ModelClient {
  const base = m.base_url!;
  const headers = (): Record<string, string> => (m.api_key ? { "x-goog-api-key": m.api_key } : {});
  let generated = 0;
  return {
    provider: m.provider,
    protocol: "gemini",
    model: m.model,
    endpoint: m.endpoint,
    async chat(req: ChatRequest): Promise<ChatResponse> {
      const p = splitParams({ ...m.params, ...req.params });
      const paramsSent: Record<string, unknown> = {};
      const generationConfig: Record<string, unknown> = {};
      if (p.temperature !== undefined) generationConfig.temperature = paramsSent.temperature = p.temperature;
      if (p.top_p !== undefined) generationConfig.topP = paramsSent.top_p = p.top_p;
      if (p.max_tokens !== undefined) generationConfig.maxOutputTokens = paramsSent.max_tokens = p.max_tokens;
      if (p.stop !== undefined) generationConfig.stopSequences = paramsSent.stop = p.stop;
      for (const [k, v] of Object.entries(p.rest)) generationConfig[k] = paramsSent[k] = v;

      const body: Record<string, unknown> = { contents: geminiContents(req.messages) };
      if (req.system !== "") body.systemInstruction = { parts: [{ text: req.system }] };
      if (req.tools.length > 0) {
        body.tools = [
          { functionDeclarations: req.tools.map((t) => ({ name: t.name, description: t.description, parametersJsonSchema: t.input_schema })) },
        ];
      }
      if (Object.keys(generationConfig).length > 0) body.generationConfig = generationConfig;

      const { data, headers: h } = await postJson(m.provider, `${base}/models/${encodeURIComponent(m.model)}:generateContent`, headers(), body, {
        signal: req.signal,
        parseError: parseGeminiError,
      });
      const d = obj(data);
      const candidate = obj(Array.isArray(d.candidates) ? d.candidates[0] : undefined);
      const content = obj(candidate.content);
      const parts = Array.isArray(content.parts) ? (content.parts as Array<Record<string, unknown>>) : [];
      const toolCalls: ToolCall[] = parts
        .filter((part) => part.functionCall !== undefined)
        .map((part) => {
          const fc = obj(part.functionCall);
          return { id: str(fc.id) ?? `${GENERATED_ID_PREFIX}${++generated}`, name: String(fc.name ?? ""), input: obj(fc.args) };
        });
      const text = parts
        .filter((part) => typeof part.text === "string" && part.thought !== true)
        .map((part) => part.text as string)
        .join("")
        .trim();
      // A prompt blocked before any candidate: no finishReason, the block reason says why.
      const raw = str(candidate.finishReason) ?? (str(obj(d.promptFeedback).blockReason) ? `BLOCKED:${str(obj(d.promptFeedback).blockReason)}` : null);
      const usage = obj(d.usageMetadata);
      return {
        text,
        tool_calls: toolCalls,
        stop_reason: geminiStop(raw, toolCalls.length > 0),
        raw_stop_reason: raw,
        usage: { input_tokens: num(usage.promptTokenCount), output_tokens: num(usage.candidatesTokenCount) + num(usage.thoughtsTokenCount) },
        model: str(d.modelVersion) ?? null,
        request_id: str(d.responseId) ?? h.get("x-request-id") ?? null,
        endpoint: m.endpoint,
        params_sent: paramsSent,
        native: { protocol: "gemini", content: { role: "model", parts } },
      };
    },
    async embed(texts: string[], signal?: AbortSignal): Promise<EmbedResponse> {
      const { data } = await postJson(
        m.provider,
        `${base}/models/${encodeURIComponent(m.model)}:batchEmbedContents`,
        headers(),
        { requests: texts.map((t) => ({ model: `models/${m.model}`, content: { parts: [{ text: t }] } })) },
        { signal, parseError: parseGeminiError }
      );
      const d = obj(data);
      const rows = Array.isArray(d.embeddings) ? (d.embeddings as Array<Record<string, unknown>>) : [];
      return { vectors: rows.map((r) => (Array.isArray(r.values) ? (r.values as number[]) : [])), model: null };
    },
  };
}
