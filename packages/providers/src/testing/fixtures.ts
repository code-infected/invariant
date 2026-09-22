/** Shared request fixtures for the adapter tests. */
import type { ChatMessage, ToolSpec } from "../types.js";

export const TOOLS: ToolSpec[] = [
  {
    name: "lookup_order",
    description: "Look up an order.",
    input_schema: { type: "object", properties: { order_id: { type: "string" } }, required: ["order_id"], additionalProperties: false },
  },
  {
    name: "check_refund_history",
    description: "Refunds already issued for an order.",
    input_schema: { type: "object", properties: { order_id: { type: "string" } }, required: ["order_id"] },
  },
];

export const SYSTEM = "You are an assistant. Call reply_to_user when done.";

/** user -> assistant (two tool calls, no native turn) -> both results, the second an error. */
export function twoCallConversation(ids: [string, string] = ["call_a", "call_b"]): ChatMessage[] {
  return [
    { role: "user", content: "Refund order 1234." },
    {
      role: "assistant",
      text: "Checking.",
      tool_calls: [
        { id: ids[0], name: "lookup_order", input: { order_id: "1234" } },
        { id: ids[1], name: "check_refund_history", input: { order_id: "1234" } },
      ],
    },
    {
      role: "tool",
      results: [
        { tool_call_id: ids[0], name: "lookup_order", content: '{"order_id":"1234","amount":42}', is_error: false },
        { tool_call_id: ids[1], name: "check_refund_history", content: "tool failed: timeout", is_error: true },
      ],
    },
  ];
}

/** The ProviderError a call rejected with; fails the test if it resolved or threw something else. */
export async function rejection(p: Promise<unknown>): Promise<import("../types.js").ProviderError> {
  const { ProviderError } = await import("../types.js");
  try {
    await p;
  } catch (e) {
    if (e instanceof ProviderError) return e;
    throw new Error(`expected a ProviderError, got: ${e instanceof Error ? e.stack : String(e)}`);
  }
  throw new Error("expected the call to fail, it succeeded");
}
