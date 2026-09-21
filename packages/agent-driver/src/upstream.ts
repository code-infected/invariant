import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { UpstreamConfig } from "@invariant/mcp-proxy";

/**
 * Names of the tools an upstream MCP server actually serves.
 *
 * Used as a preflight before spending model calls: the agent's whole tool surface is
 * whatever the upstream serves, so a task whose declared tools the upstream does not
 * serve would produce traces of the agent working with the wrong tools. Talks to the
 * upstream directly rather than through the proxy, since the proxy relays the upstream's
 * tool list unchanged and there is no run to record yet.
 */
export async function listUpstreamTools(upstream: UpstreamConfig): Promise<string[]> {
  const client = new Client({ name: "invariant-preflight", version: "0.1.0" }, { capabilities: {} });
  try {
    await client.connect(
      new StdioClientTransport({
        command: upstream.command,
        args: upstream.args,
        // Same environment the proxy gives the upstream, so the preflight sees what a trial sees.
        env: { ...(process.env as Record<string, string>), ...(upstream.env ?? {}) },
        cwd: upstream.cwd,
        stderr: "ignore",
      })
    );
    const { tools } = await client.listTools();
    return tools.map((t) => t.name).sort();
  } finally {
    await client.close().catch(() => undefined);
  }
}
