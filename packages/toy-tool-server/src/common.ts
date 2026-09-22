import fs from "node:fs";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/**
 * When INVARIANT_TOY_SIDE_EFFECT_LOG is set, every genuinely-executed side-effecting call
 * is appended there as one JSON line. This is how a test can prove the proxy's
 * dangerous-tool interception actually stopped a call from reaching the backend, rather
 * than merely proving the proxy returned the sandbox response. Shared by every toy server.
 */
export function logSideEffect(entry: Record<string, unknown>): void {
  const file = process.env.INVARIANT_TOY_SIDE_EFFECT_LOG;
  if (!file) return;
  fs.appendFileSync(file, JSON.stringify({ ...entry, at: new Date().toISOString() }) + "\n", "utf8");
}

export function json(payload: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}
