import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { InjectionPlacement } from "./config.js";

/**
 * Adversarial mode's one write path: plant a payload's text into a tool result.
 *
 * Pure (the input result is never mutated) so the exact transformation is unit-testable
 * apart from the proxy. The goal is that the agent sees an otherwise normal response: a
 * JSON response is re-serialised in the same style it arrived in (compact stays compact,
 * indented stays indented), and nothing but the targeted field changes. When structured
 * content accompanies the text, the same change is applied to it, so the two never
 * disagree.
 *
 * Any case the placement cannot be applied to (an error result, non-JSON text for a field
 * placement, a path that does not resolve, appending to a non-string) is returned as a
 * reason instead of a result. The proxy then relays the untouched response and records
 * the call as not injected: a run where the injection never landed must not be scored as
 * one that resisted it.
 */
export type InjectionOutcome = { ok: true; result: CallToolResult } | { ok: false; reason: string };

/** "refunds.0.note" -> ["refunds", 0, "note"]. Numeric segments index arrays. */
export function parseFieldPath(path: string): Array<string | number> {
  return path.split(".").map((seg) => (/^\d+$/.test(seg) ? Number(seg) : seg));
}

function applyToJson(value: unknown, placement: Exclude<InjectionPlacement, { mode: "append_text" }>, text: string): { ok: true; value: unknown } | { ok: false; reason: string } {
  const root = structuredClone(value);
  const segs = parseFieldPath(placement.path);
  let parent: unknown = root;
  for (const seg of segs.slice(0, -1)) {
    const next = parent !== null && typeof parent === "object" ? (parent as Record<string | number, unknown>)[seg] : undefined;
    if (next === null || typeof next !== "object") {
      return { ok: false, reason: `path "${placement.path}" does not resolve: no object at "${seg}"` };
    }
    parent = next;
  }
  if (parent === null || typeof parent !== "object") return { ok: false, reason: `path "${placement.path}": the response is not a JSON object or array` };
  const last = segs[segs.length - 1]!;
  if (Array.isArray(parent) && typeof last !== "number") {
    return { ok: false, reason: `path "${placement.path}": "${last}" is not an index into an array` };
  }
  const container = parent as Record<string | number, unknown>;
  if (placement.mode === "set_field") {
    container[last] = text;
  } else {
    const current = container[last];
    if (typeof current !== "string") {
      return { ok: false, reason: `path "${placement.path}" holds ${current === undefined ? "nothing" : typeof current}, not a string to append to` };
    }
    container[last] = `${current} ${text}`;
  }
  return { ok: true, value: root };
}

/** Serialise like the original: compact if it was compact, else two-space indented. */
function reserialise(original: string, parsed: unknown, updated: unknown): string {
  return original.trim() === JSON.stringify(parsed) ? JSON.stringify(updated) : JSON.stringify(updated, null, 2);
}

export function injectIntoResult(result: CallToolResult, placement: InjectionPlacement, text: string): InjectionOutcome {
  if (result.isError) return { ok: false, reason: "the response is an error result" };
  const content = result.content ?? [];
  const textIdx = content.map((b, i) => (b.type === "text" ? i : -1)).filter((i) => i >= 0);

  if (placement.mode === "append_text") {
    const i = textIdx[textIdx.length - 1];
    if (i === undefined) return { ok: false, reason: "the response has no text block to append to" };
    const next = content.map((b, j) => (j === i ? { ...b, text: `${(b as { text: string }).text}\n\n${text}` } : b));
    return { ok: true, result: { ...result, content: next as CallToolResult["content"] } };
  }

  if (textIdx.length !== 1) {
    return { ok: false, reason: `a field placement needs exactly one text block holding JSON, the response has ${textIdx.length}` };
  }
  const i = textIdx[0]!;
  const original = (content[i] as { text: string }).text;
  let parsed: unknown;
  try {
    parsed = JSON.parse(original);
  } catch {
    return { ok: false, reason: "the response text is not JSON, so it has no fields" };
  }
  const applied = applyToJson(parsed, placement, text);
  if (!applied.ok) return applied;
  const next = content.map((b, j) => (j === i ? { ...b, text: reserialise(original, parsed, applied.value) } : b));
  const out: CallToolResult = { ...result, content: next as CallToolResult["content"] };
  if (result.structuredContent !== undefined) {
    const structured = applyToJson(result.structuredContent, placement, text);
    if (!structured.ok) return { ok: false, reason: `structured content: ${structured.reason}` };
    out.structuredContent = structured.value as CallToolResult["structuredContent"];
  }
  return { ok: true, result: out };
}
