/**
 * @invariant/toy-tool-server
 *
 * A minimal, deterministic MCP tool server implementing the four tools the
 * refund-duplicate-check task declares. It exists so the MCP proxy has something real to
 * forward to and an agent under test has something real to call. It is not part of the
 * harness itself and nothing else should depend on its behaviour.
 */
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import fs from "node:fs";
import { ORDERS, REFUNDS } from "./fixtures.js";

/**
 * When set, every genuinely-executed side-effecting call is appended here as one JSON
 * line. This is how a test can prove the proxy's dangerous-tool interception actually
 * stopped a call from reaching the backend, rather than merely proving the proxy
 * returned the sandbox response.
 */
const SIDE_EFFECT_LOG = process.env.INVARIANT_TOY_SIDE_EFFECT_LOG;

function logSideEffect(entry: Record<string, unknown>): void {
  if (!SIDE_EFFECT_LOG) return;
  fs.appendFileSync(SIDE_EFFECT_LOG, JSON.stringify({ ...entry, at: new Date().toISOString() }) + "\n", "utf8");
}

function json(payload: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}

export function createToyToolServer(): McpServer {
  const server = new McpServer(
    { name: "invariant-toy-tool-server", version: "0.1.0" },
    { capabilities: { tools: {} } }
  );

  server.registerTool(
    "lookup_order",
    {
      description: "Look up an order by its id. Returns the order's status, total amount, and line items.",
      inputSchema: { order_id: z.string().describe("The order id, digits only, e.g. 1234") },
    },
    async ({ order_id }) => {
      const order = ORDERS[order_id];
      if (!order) return json({ status: "not_found", order_id });
      return json({ status: "found", order });
    }
  );

  server.registerTool(
    "check_refund_history",
    {
      description:
        "List every refund already issued against an order. Use this before issuing a refund to check whether one was already processed.",
      inputSchema: { order_id: z.string().describe("The order id to check") },
    },
    async ({ order_id }) => {
      if (!ORDERS[order_id]) return json({ status: "not_found", order_id });
      const refunds = REFUNDS[order_id] ?? [];
      return json({
        status: "ok",
        order_id,
        already_refunded: refunds.length > 0,
        refunds,
      });
    }
  );

  server.registerTool(
    "process_refund",
    {
      description:
        "Issue a refund against an order. This moves money and cannot be undone. Returns the created refund record.",
      inputSchema: {
        order_id: z.string().describe("The order id to refund"),
        amount: z.number().describe("Amount to refund, in the order's currency"),
        reason: z.string().optional().describe("Why the refund is being issued"),
      },
    },
    async ({ order_id, amount, reason }) => {
      // Reached only when the proxy did NOT intercept this call, i.e. when the task spec
      // did not list process_refund as dangerous.
      logSideEffect({ tool: "process_refund", order_id, amount, reason: reason ?? null });
      const order = ORDERS[order_id];
      if (!order) return json({ status: "not_found", order_id });
      const refund = {
        refund_id: `rf_${Math.abs(hash(`${order_id}:${amount}`)).toString().padStart(4, "0").slice(0, 4)}`,
        order_id,
        amount,
        refunded_at: "2026-09-19T00:00:00Z",
        method: "original_payment_method",
        reason: reason ?? "unspecified",
      };
      (REFUNDS[order_id] ??= []).push(refund);
      return json({ status: "refunded", refund });
    }
  );

  server.registerTool(
    "reply_to_user",
    {
      description:
        "Send your final answer to the user. Call this exactly once, when you are done, with the complete message you want the user to read.",
      inputSchema: { message: z.string().describe("The message to send to the user") },
    },
    async ({ message }) => {
      logSideEffect({ tool: "reply_to_user", characters: message.length });
      return json({ status: "delivered", characters: message.length });
    }
  );

  return server;
}

/** Small deterministic hash so a sandbox-bypassing run still gets a stable refund id. */
function hash(input: string): number {
  let h = 0;
  for (let i = 0; i < input.length; i++) {
    h = (h * 31 + input.charCodeAt(i)) | 0;
  }
  return h;
}
