import { classifyStatus, parseRetryAfter, ProviderError } from "./types.js";

/** What an adapter pulls out of a provider's error body. */
export interface ParsedError {
  message?: string;
  code?: string;
  param?: string;
  retryAfterMs?: number;
}

export interface HttpResult {
  data: unknown;
  headers: Headers;
  status: number;
}

/**
 * One POST, no retries. A transport failure (no response, including an abort from the
 * caller's signal) is infra with no status; an HTTP error is classified by status, with
 * the provider's own code, message and retry-after attached.
 */
export async function postJson(
  provider: string,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  options: { signal?: AbortSignal; parseError?: (body: unknown) => ParsedError; requestIdHeader?: string } = {}
): Promise<HttpResult> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: options.signal,
    });
  } catch (err) {
    throw new ProviderError(`${provider} request failed with no response: ${err instanceof Error ? err.message : String(err)}`, {
      provider,
      kind: "infra",
    });
  }
  const requestId = res.headers.get(options.requestIdHeader ?? "x-request-id") ?? undefined;
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let parsed: ParsedError = {};
    try {
      parsed = options.parseError ? options.parseError(JSON.parse(text)) : {};
    } catch {
      // Not JSON (a proxy's HTML error page, say): the raw text goes in the message.
    }
    const retryAfterMs =
      parseRetryAfter(res.headers.get("retry-after")) ??
      (res.headers.get("retry-after-ms") !== null && Number.isFinite(Number(res.headers.get("retry-after-ms")))
        ? Number(res.headers.get("retry-after-ms"))
        : undefined) ??
      parsed.retryAfterMs;
    throw new ProviderError(`${provider} API request failed (${res.status}): ${parsed.message ?? text.slice(0, 2000)}`, {
      provider,
      kind: classifyStatus(res.status),
      status: res.status,
      ...(parsed.code !== undefined ? { code: parsed.code } : {}),
      ...(parsed.param !== undefined ? { param: parsed.param } : {}),
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      ...(requestId !== undefined ? { requestId } : {}),
    });
  }
  let data: unknown;
  try {
    data = await res.json();
  } catch (err) {
    // A 200 whose body is not JSON: the provider answered, but not with anything usable.
    throw new ProviderError(`${provider} returned a non-JSON success body: ${err instanceof Error ? err.message : String(err)}`, {
      provider,
      kind: "infra",
      status: res.status,
    });
  }
  return { data, headers: res.headers, status: res.status };
}

export function obj(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Split params into the four neutral keys and the rest (passed through verbatim). */
export function splitParams(params: Record<string, unknown> | undefined): {
  temperature?: unknown;
  top_p?: unknown;
  max_tokens?: unknown;
  stop?: unknown;
  rest: Record<string, unknown>;
} {
  const { temperature, top_p, max_tokens, stop, ...rest } = params ?? {};
  return {
    ...(temperature !== undefined ? { temperature } : {}),
    ...(top_p !== undefined ? { top_p } : {}),
    ...(max_tokens !== undefined ? { max_tokens } : {}),
    ...(stop !== undefined ? { stop } : {}),
    rest,
  };
}

/** Parse a tool call's JSON-text arguments; a non-object is kept as input_error rather than guessed at. */
export function parseArguments(raw: unknown): { input: Record<string, unknown>; input_error?: string } {
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) return { input: raw as Record<string, unknown> };
  if (typeof raw !== "string" || raw.trim() === "") return { input: {} };
  try {
    const parsed = JSON.parse(raw);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) return { input: parsed as Record<string, unknown> };
  } catch {
    // fall through
  }
  return { input: {}, input_error: raw };
}
