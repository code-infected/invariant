import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { DangerousTool, Injection, UpstreamConfig } from "./config.js";
import { injectIntoResult } from "./inject.js";

/**
 * One recorded tool call, shaped exactly like the trace schema in
 * internal-docs/TECHNICAL_SPEC.md section 3 (minus run_id, which the recorder owns —
 * the proxy records for whichever run it was launched for and doesn't need to know it).
 */
export interface ProxyToolCallRecord {
  sequence_index: number;
  tool_name: string;
  args: unknown;
  response: unknown;
  is_sandboxed: boolean;
  timestamp: string;
  /** Present only when the proxy planted this payload's text into the response. */
  injection_payload_id?: string;
}

export type ToolCallRecorder = (record: ProxyToolCallRecord) => void;

export interface ProxyOptions {
  upstream: UpstreamConfig;
  dangerous_tools?: DangerousTool[];
  /**
   * Called synchronously for every tool call, before the response is returned to the
   * agent, so that a call is never observable by the agent without also being recorded.
   */
  record: ToolCallRecorder;
  /** Identity the proxy advertises to the agent. Defaults to the upstream's own identity. */
  serverInfo?: { name: string; version: string };
  /** Where the upstream server's stderr goes. Defaults to inheriting this process's. */
  upstreamStderr?: "inherit" | "ignore";
  /**
   * Adversarial mode: plant a payload into one targeted response. Absent (the default and
   * every consistency run), the proxy never modifies a response.
   */
  injection?: Injection;
  /** Told when the targeted call happened but the payload could not be planted, and why. */
  onInjectionSkipped?: (reason: string) => void;
}

/**
 * Unwrap an MCP tool result into the plain response value the trace schema records.
 *
 * TECHNICAL_SPEC section 3 shows `"response": {"status": "sandboxed", ...}` — the tool's
 * own payload, not the MCP content envelope around it. Nearly every tool server returns
 * a single JSON text block, so that case is unwrapped; anything else (multiple blocks,
 * images, non-JSON text, an error result) is recorded as the full envelope rather than
 * being mangled to fit. Error results are never unwrapped, because isError lives on the
 * envelope and dropping it would hide a failed call from the scoring engine later.
 */
export function normalizeToolResponse(result: CallToolResult): unknown {
  if (result.isError) return result;
  if (result.structuredContent !== undefined) return result.structuredContent;
  const content = result.content ?? [];
  if (content.length === 1 && content[0]?.type === "text") {
    const text = (content[0] as { text: string }).text;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return result;
}

/**
 * A transparent MCP proxy: an MCP server on one side, an MCP client to the real tool
 * server on the other.
 *
 * Every tool call is forwarded verbatim and recorded, except calls to tools the task spec
 * declared dangerous, which are answered with the spec's sandbox_response and never reach
 * the upstream server. The recording is the point: it's what turns an ordinary agent run
 * into a trace the consistency scoring can run on, and it requires no change to the agent,
 * which only sees an MCP server that behaves like the real one.
 *
 * This uses the SDK's low-level `Server` rather than `McpServer` on purpose. `McpServer`
 * wants tools declared with Zod schemas it converts to JSON Schema; a proxy must republish
 * the upstream's JSON Schema byte-for-byte, because the tool schema is part of what the
 * agent sees and therefore part of what's being measured. Round-tripping it through Zod
 * would quietly change it.
 *
 * Security note, repeated from internal-docs/TECHNICAL_SPEC.md section 9: this is a
 * transparent forward proxy holding the same credentials the agent already had. It is not
 * a sandbox, beyond the explicitly configured dangerous-tool interception.
 */
export class InvariantProxy {
  private sequenceIndex = 0;
  private readonly dangerous: Map<string, DangerousTool>;
  /** Calls seen so far per tool name, for picking the injection's on_call-th call. */
  private readonly callsPerTool = new Map<string, number>();
  private closed = false;

  private constructor(
    readonly server: Server,
    private readonly upstreamClient: Client,
    private readonly upstreamTransport: StdioClientTransport,
    dangerousTools: DangerousTool[],
    private readonly record: ToolCallRecorder,
    private readonly injection: Injection | undefined,
    private readonly onInjectionSkipped: (reason: string) => void
  ) {
    this.dangerous = new Map(dangerousTools.map((t) => [t.name, t]));
  }

  static async create(options: ProxyOptions): Promise<InvariantProxy> {
    const upstreamClient = new Client(
      { name: "invariant-mcp-proxy", version: "0.1.0" },
      { capabilities: {} }
    );
    const upstreamTransport = new StdioClientTransport({
      command: options.upstream.command,
      args: options.upstream.args ?? [],
      // Inherit the parent environment so the upstream server keeps whatever credentials
      // it normally runs with; the proxy is not supposed to change how it behaves.
      env: { ...(process.env as Record<string, string>), ...(options.upstream.env ?? {}) },
      cwd: options.upstream.cwd,
      stderr: options.upstreamStderr ?? "inherit",
    });
    await upstreamClient.connect(upstreamTransport);

    const upstreamInfo = upstreamClient.getServerVersion();
    const server = new Server(
      options.serverInfo ?? {
        name: upstreamInfo?.name ?? "invariant-mcp-proxy",
        version: upstreamInfo?.version ?? "0.1.0",
      },
      { capabilities: { tools: {} } }
    );

    const proxy = new InvariantProxy(
      server,
      upstreamClient,
      upstreamTransport,
      options.dangerous_tools ?? [],
      options.record,
      options.injection,
      options.onInjectionSkipped ?? (() => undefined)
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => {
      // Asked upstream every time rather than cached at startup: a tool list that goes
      // stale is a tool list that no longer describes what the agent is really calling.
      const { tools } = await upstreamClient.listTools();
      return { tools: tools as Tool[] };
    });

    server.setRequestHandler(CallToolRequestSchema, async (request) => proxy.handleToolCall(request.params));

    return proxy;
  }

  /** Tool calls observed so far on this proxy instance. */
  get callCount(): number {
    return this.sequenceIndex;
  }

  private async handleToolCall(params: {
    name: string;
    arguments?: Record<string, unknown>;
  }): Promise<CallToolResult> {
    const sequenceIndex = this.sequenceIndex++;
    const timestamp = new Date().toISOString();
    const args = params.arguments ?? {};
    const sandboxed = this.dangerous.get(params.name);
    const nthCall = (this.callsPerTool.get(params.name) ?? 0) + 1;
    this.callsPerTool.set(params.name, nthCall);

    let result: CallToolResult;
    if (sandboxed) {
      result = { content: [{ type: "text", text: sandboxed.sandbox_response }] };
    } else {
      try {
        result = (await this.upstreamClient.callTool({
          name: params.name,
          arguments: args,
        })) as CallToolResult;
      } catch (err) {
        // An upstream failure is still a tool call the agent made and reacted to, so it is
        // recorded like any other, and relayed as a tool error rather than a protocol error
        // so the agent sees what it would have seen talking to the server directly.
        const message = err instanceof Error ? err.message : String(err);
        result = { content: [{ type: "text", text: message }], isError: true };
      }
    }

    let injectedWith: string | undefined;
    const inj = this.injection;
    if (inj && inj.tool === params.name && inj.on_call === nthCall) {
      if (sandboxed && !inj.into_sandboxed) {
        this.onInjectionSkipped(
          `${params.name} call ${nthCall} is sandboxed and payload ${inj.payload_id} does not set into_sandboxed; relayed unmodified`
        );
      } else {
        const outcome = injectIntoResult(result, inj.placement, inj.text);
        if (outcome.ok) {
          result = outcome.result;
          injectedWith = inj.payload_id;
        } else {
          this.onInjectionSkipped(`payload ${inj.payload_id} not planted in ${params.name} call ${nthCall}: ${outcome.reason}; relayed unmodified`);
        }
      }
    }

    // Recorded as the agent receives it: an injected response is recorded injected, and
    // flagged, so the trace shows exactly what the agent saw and where the payload entered.
    this.record({
      sequence_index: sequenceIndex,
      tool_name: params.name,
      args,
      response: normalizeToolResponse(result),
      is_sandboxed: sandboxed !== undefined,
      timestamp,
      ...(injectedWith !== undefined ? { injection_payload_id: injectedWith } : {}),
    });
    return result;
  }

  /** Start serving the agent-facing side of the proxy. */
  async connect(transport: Transport): Promise<void> {
    await this.server.connect(transport);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.server.close().catch(() => undefined);
    await this.upstreamClient.close().catch(() => undefined);
    await this.upstreamTransport.close().catch(() => undefined);
  }
}

export async function createProxy(options: ProxyOptions): Promise<InvariantProxy> {
  return InvariantProxy.create(options);
}
