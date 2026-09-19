import { z } from "zod";

/**
 * On-disk config for the proxy process. Written by whoever launches a trial (today:
 * @invariant/agent-driver) and handed to the proxy as `--config <path>`, because the
 * proxy's stdio is the MCP channel and cannot carry configuration.
 *
 * Field naming follows the snake_case convention the task specs and variant fixtures
 * already use (internal-docs/TECHNICAL_SPEC.md sections 1-2).
 */
export const UpstreamConfigSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).optional(),
  cwd: z.string().optional(),
});

export const DangerousToolSchema = z.object({
  name: z.string().min(1),
  /** Returned verbatim to the agent instead of forwarding the call upstream. */
  sandbox_response: z.string(),
});

export const ProxyConfigSchema = z.object({
  /** Run this proxy is recording for. Must already exist in the trace store. */
  run_id: z.string().min(1),
  /** Directory holding trace.db and traces/, i.e. TraceStore's root. */
  trace_store_root: z.string().min(1),
  upstream: UpstreamConfigSchema,
  dangerous_tools: z.array(DangerousToolSchema).default([]),
});

export type UpstreamConfig = z.infer<typeof UpstreamConfigSchema>;
export type DangerousTool = z.infer<typeof DangerousToolSchema>;
export type ProxyConfig = z.infer<typeof ProxyConfigSchema>;
