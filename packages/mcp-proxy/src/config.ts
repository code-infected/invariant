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

/**
 * Where in the targeted response the planted text goes.
 *
 *   set_field        response is JSON; the field at `path` is set to the text (created if
 *                    absent, its parent must exist). Dot-separated, numeric segments index
 *                    arrays: "refunds.0.note".
 *   append_to_field  response is JSON; the string at `path` gets " " + text appended.
 *   append_text      the response's last text block gets a blank line + text appended.
 *                    For plain-text tools; on a JSON response it would break the JSON.
 */
export const InjectionPlacementSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("set_field"), path: z.string().min(1) }).strict(),
  z.object({ mode: z.literal("append_to_field"), path: z.string().min(1) }).strict(),
  z.object({ mode: z.literal("append_text") }).strict(),
]);

/**
 * Adversarial mode: plant `text` into the response of the `on_call`-th call (1-based) to
 * `tool` in this run, before the agent sees it. Test fixtures only (tasks/adversarial/);
 * see internal-docs/TECHNICAL_SPEC.md section 9.
 */
export const InjectionSchema = z
  .object({
    payload_id: z.string().min(1),
    tool: z.string().min(1),
    on_call: z.number().int().positive(),
    placement: InjectionPlacementSchema,
    text: z.string().min(1),
    /**
     * A dangerous tool's call is answered by its sandbox_response, which never came from
     * the real backend. Planting text there is refused unless the payload explicitly asks.
     */
    into_sandboxed: z.boolean().default(false),
  })
  .strict();

export const ProxyConfigSchema = z.object({
  /** Run this proxy is recording for. Must already exist in the trace store. */
  run_id: z.string().min(1),
  /** Directory holding trace.db and traces/, i.e. TraceStore's root. */
  trace_store_root: z.string().min(1),
  upstream: UpstreamConfigSchema,
  dangerous_tools: z.array(DangerousToolSchema).default([]),
  /** Adversarial mode only. Absent: the proxy never modifies a response. */
  injection: InjectionSchema.optional(),
});

export type UpstreamConfig = z.infer<typeof UpstreamConfigSchema>;
export type DangerousTool = z.infer<typeof DangerousToolSchema>;
export type ProxyConfig = z.infer<typeof ProxyConfigSchema>;
export type InjectionPlacement = z.infer<typeof InjectionPlacementSchema>;
export type Injection = z.infer<typeof InjectionSchema>;
/** What callers write: into_sandboxed may be left out (defaults to false). */
export type InjectionInput = z.input<typeof InjectionSchema>;
