/**
 * Volatile-field masking, shared by every axis that compares tool-call arguments.
 *
 * A task declares argument fields whose values are expected to differ between otherwise
 * identical calls (request ids, timestamps, trace ids). Before two calls are compared, the
 * value of any object key named in `volatile_fields` is replaced with MASKED, at any depth
 * (nested objects and arrays included). Matching is by exact key name, case-sensitive.
 *
 * The key itself is kept, only its value is replaced, matching the trace example in
 * TECHNICAL_SPEC.md section 3 ("request_id": "<masked>"). So a call that carries a
 * request_id and one that omits it still differ: masking forgives a changing value, not
 * a changing call shape.
 */
export const MASKED = "<masked>";

export function maskVolatile(value: unknown, volatileFields: readonly string[]): unknown {
  if (volatileFields.length === 0) return value;
  const fields = new Set(volatileFields);
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v !== null && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, inner] of Object.entries(v as Record<string, unknown>)) {
        out[k] = fields.has(k) ? MASKED : walk(inner);
      }
      return out;
    }
    return v;
  };
  return walk(value);
}

/**
 * JSON with object keys sorted at every level, so two argument objects that differ only
 * in key order serialise identically. Values are otherwise untouched: "42" and 42 differ,
 * as they should for an exact-match comparison.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}
