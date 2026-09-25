/**
 * Amazon Bedrock, Converse API
 * (https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_Converse.html),
 * through @aws-sdk/client-bedrock-runtime with the standard AWS credential chain.
 *
 * The client is built with maxAttempts: 1. The SDK's own retries would hide throttling
 * from the harness, which has to see a ThrottlingException to classify it as infra and
 * apply its own policy (providers.retry in invariant.config.yaml).
 *
 * Transport: plain HTTPS/1.1 (NodeHttpHandler). The client's default HTTP/2 handler exists
 * for the bidirectional streaming APIs, which invariant does not use; Converse is an
 * ordinary request/response call either way.
 *
 * Converse does not report which model answered: ChatResponse.model is null, and the
 * fingerprint records "(not reported by the API)" rather than echoing the requested id as
 * if the provider had confirmed it.
 *
 * Embeddings (InvokeModel): Amazon Titan text embeddings ({inputText} -> {embedding}, one
 * text per call) and Cohere embed models ({texts, input_type} -> {embeddings}).
 */
import { BedrockRuntimeClient, ConverseCommand, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { obj, splitParams, str, num } from "./http.js";
import type { ResolvedModel } from "./registry.js";
import { classifyStatus, parseRetryAfter, ProviderError, type ChatMessage, type ChatRequest, type ChatResponse, type EmbedResponse, type ModelClient, type StopReason, type ToolCall } from "./types.js";

/** Exceptions Bedrock documents as transient, classified infra even without a status. */
const INFRA_EXCEPTIONS = new Set([
  "ThrottlingException",
  "ServiceUnavailableException",
  "InternalServerException",
  "ModelNotReadyException",
  "ModelTimeoutException",
]);

export function bedrockMessages(messages: ChatMessage[]): unknown[] {
  return messages.map((m) => {
    if (m.role === "user") return { role: "user", content: [{ text: m.content }] };
    if (m.role === "tool") {
      return {
        role: "user",
        content: m.results.map((r) => ({
          toolResult: { toolUseId: r.tool_call_id, content: [{ text: r.content }], status: r.is_error ? "error" : "success" },
        })),
      };
    }
    if (m.native?.protocol === "bedrock") return { role: "assistant", content: m.native.content };
    const content: unknown[] = [];
    if (m.text !== "") content.push({ text: m.text });
    for (const c of m.tool_calls) content.push({ toolUse: { toolUseId: c.id, name: c.name, input: c.input } });
    return { role: "assistant", content };
  });
}

export function bedrockStop(raw: string | null): StopReason {
  if (raw === "tool_use") return "tool_use";
  if (raw === "end_turn" || raw === "stop_sequence") return "end_turn";
  if (raw === "max_tokens") return "max_tokens";
  return "other";
}

/** Turn whatever the SDK threw into a ProviderError. */
export function bedrockError(provider: string, err: unknown): ProviderError {
  const e = obj(err);
  const name = str(e.name) ?? "Error";
  const message = err instanceof Error ? err.message : String(err);
  const meta = obj(e.$metadata);
  const status = typeof meta.httpStatusCode === "number" ? meta.httpStatusCode : undefined;
  const requestId = str(meta.requestId);
  const headers = obj(obj(e.$response).headers);
  const retryAfterMs = parseRetryAfter(str(headers["retry-after"]) ?? str(headers["Retry-After"]));
  if (status === undefined && !INFRA_EXCEPTIONS.has(name)) {
    // No HTTP response at all (connection refused, DNS, abort): transport-level, infra.
    // Except a local configuration failure the SDK raises before sending anything.
    const local = /credential|region is missing|Could not load/i.test(message);
    return new ProviderError(`bedrock request failed${local ? "" : " with no response"}: ${name}: ${message}`, {
      provider,
      kind: local ? "rejected" : "infra",
      code: name,
      ...(requestId !== undefined ? { requestId } : {}),
    });
  }
  const kind = INFRA_EXCEPTIONS.has(name) ? "infra" : status !== undefined ? classifyStatus(status) : "rejected";
  return new ProviderError(`bedrock API request failed (${status ?? "no status"}): ${name}: ${message}`, {
    provider,
    kind,
    code: name,
    ...(status !== undefined ? { status } : {}),
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    ...(requestId !== undefined ? { requestId } : {}),
  });
}

/**
 * `BedrockRuntimeClientResolvedConfig` is a deep intersection of the SDK's and Smithy's
 * resolved-config interfaces; `region` and `credentials` are real properties on it at
 * runtime (verified against the pinned @aws-sdk/client-bedrock-runtime + @smithy/core: both
 * resolve to functions on a live client), but `keyof` over that many intersected, partly
 * generic interfaces collapses to `never` in ts(5.9), so `Pick` can't name them either.
 * `sdk.config` is read through this hand-written, accurate view instead of `any`.
 */
interface BedrockResolvedConfig {
  region(): Promise<string | undefined>;
  credentials(): Promise<unknown>;
}

export function createBedrockClient(m: ResolvedModel): ModelClient {
  const sdk = new BedrockRuntimeClient({
    maxAttempts: 1,
    requestHandler: new NodeHttpHandler(),
    ...(m.region !== undefined ? { region: m.region } : {}),
    ...(m.base_url ? { endpoint: m.base_url } : {}),
  });
  const resolvedConfig = sdk.config as unknown as BedrockResolvedConfig;
  let endpoint = m.endpoint;
  async function resolveEndpoint(): Promise<string | null> {
    if (endpoint) return endpoint;
    try {
      const region = await resolvedConfig.region();
      endpoint = region ? `bedrock-runtime.${region}.amazonaws.com` : null;
    } catch {
      endpoint = null;
    }
    return endpoint;
  }

  return {
    provider: m.provider,
    protocol: "bedrock",
    model: m.model,
    endpoint,
    async chat(req: ChatRequest): Promise<ChatResponse> {
      const p = splitParams({ ...m.params, ...req.params });
      const paramsSent: Record<string, unknown> = {};
      const inferenceConfig: Record<string, unknown> = {};
      if (p.temperature !== undefined) inferenceConfig.temperature = paramsSent.temperature = p.temperature;
      if (p.top_p !== undefined) inferenceConfig.topP = paramsSent.top_p = p.top_p;
      if (p.max_tokens !== undefined) inferenceConfig.maxTokens = paramsSent.max_tokens = p.max_tokens;
      if (p.stop !== undefined) inferenceConfig.stopSequences = paramsSent.stop = p.stop;
      const additional: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(p.rest)) additional[k] = paramsSent[k] = v;

      const input: Record<string, unknown> = { modelId: m.model, messages: bedrockMessages(req.messages) };
      if (req.system !== "") input.system = [{ text: req.system }];
      if (req.tools.length > 0) {
        input.toolConfig = {
          tools: req.tools.map((t) => ({ toolSpec: { name: t.name, description: t.description, inputSchema: { json: t.input_schema } } })),
        };
      }
      if (Object.keys(inferenceConfig).length > 0) input.inferenceConfig = inferenceConfig;
      if (Object.keys(additional).length > 0) input.additionalModelRequestFields = additional;

      let out: Record<string, unknown>;
      try {
        out = (await sdk.send(new ConverseCommand(input as never), { abortSignal: req.signal })) as unknown as Record<string, unknown>;
      } catch (err) {
        throw bedrockError(m.provider, err);
      }
      const message = obj(obj(out.output).message);
      const content = Array.isArray(message.content) ? (message.content as Array<Record<string, unknown>>) : [];
      const toolCalls: ToolCall[] = content
        .filter((b) => b.toolUse !== undefined)
        .map((b) => {
          const tu = obj(b.toolUse);
          return { id: String(tu.toolUseId ?? ""), name: String(tu.name ?? ""), input: obj(tu.input) };
        });
      const text = content
        .filter((b) => typeof b.text === "string")
        .map((b) => b.text as string)
        .join("\n")
        .trim();
      const raw = str(out.stopReason) ?? null;
      const usage = obj(out.usage);
      return {
        text,
        tool_calls: toolCalls,
        stop_reason: bedrockStop(raw),
        raw_stop_reason: raw,
        usage: { input_tokens: num(usage.inputTokens), output_tokens: num(usage.outputTokens) },
        model: null,
        request_id: str(obj(out.$metadata).requestId) ?? null,
        endpoint: await resolveEndpoint(),
        params_sent: paramsSent,
        native: { protocol: "bedrock", content },
      };
    },
    async checkCredentials(): Promise<void> {
      const region = await resolvedConfig.region();
      if (!region) throw new Error("no AWS region: set AWS_REGION or models.<role>.region");
      await resolvedConfig.credentials();
    },
    async embed(texts: string[], signal?: AbortSignal): Promise<EmbedResponse> {
      const cohere = m.model.includes("cohere.");
      const invoke = async (body: unknown): Promise<Record<string, unknown>> => {
        try {
          const res = await sdk.send(
            new InvokeModelCommand({ modelId: m.model, contentType: "application/json", accept: "application/json", body: JSON.stringify(body) }),
            { abortSignal: signal }
          );
          return obj(JSON.parse(new TextDecoder().decode(res.body)));
        } catch (err) {
          throw bedrockError(m.provider, err);
        }
      };
      if (cohere) {
        const d = await invoke({ texts, input_type: "search_document" });
        return { vectors: Array.isArray(d.embeddings) ? (d.embeddings as number[][]) : [], model: null };
      }
      const vectors: number[][] = [];
      for (const text of texts) {
        const d = await invoke({ inputText: text });
        vectors.push(Array.isArray(d.embedding) ? (d.embedding as number[]) : []);
      }
      return { vectors, model: null };
    },
  };
}
