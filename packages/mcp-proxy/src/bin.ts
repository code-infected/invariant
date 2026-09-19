#!/usr/bin/env node
/**
 * The proxy as a standalone MCP server process.
 *
 * This is the shape the architecture calls for: the agent under test points its MCP
 * client at the proxy instead of at the real tool server, with no change to the agent
 * itself. The proxy spawns the real server, forwards to it, and writes every call
 * straight into the trace store, so a trace exists even if the driver process dies.
 *
 * Usage: invariant-mcp-proxy --config <path-to-proxy-config.json>
 *        (or set INVARIANT_PROXY_CONFIG)
 */
import fs from "node:fs";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { openTraceStore } from "@invariant/trace-store";
import { ProxyConfigSchema } from "./config.js";
import { createProxy } from "./proxy.js";

function configPathFromArgv(argv: string[]): string | undefined {
  const flag = argv.indexOf("--config");
  if (flag !== -1 && argv[flag + 1]) return argv[flag + 1];
  const inline = argv.find((a) => a.startsWith("--config="));
  return inline ? inline.slice("--config=".length) : undefined;
}

const configPath = configPathFromArgv(process.argv.slice(2)) ?? process.env.INVARIANT_PROXY_CONFIG;
if (!configPath) {
  process.stderr.write(
    "invariant-mcp-proxy: no config given. Pass --config <path> or set INVARIANT_PROXY_CONFIG.\n"
  );
  process.exit(2);
}

const config = ProxyConfigSchema.parse(JSON.parse(fs.readFileSync(configPath, "utf8")));
const store = openTraceStore({ root: config.trace_store_root });

if (!store.getRun(config.run_id)) {
  process.stderr.write(
    `invariant-mcp-proxy: run ${config.run_id} does not exist in the trace store at ` +
      `${config.trace_store_root}. The caller has to open the run before starting the proxy.\n`
  );
  process.exit(2);
}

async function start() {
  return createProxy({
    upstream: config.upstream,
    dangerous_tools: config.dangerous_tools,
    record: (record) => {
      store.recordToolCall({
        run_id: config.run_id,
        sequence_index: record.sequence_index,
        tool_name: record.tool_name,
        args: record.args,
        response: record.response,
        is_sandboxed: record.is_sandboxed,
        called_at: record.timestamp,
      });
    },
  });
}

const proxy = await start().catch((err: unknown) => {
  // Most often: the upstream tool server command is wrong or died on startup. Say so on
  // stderr and exit, rather than letting the agent hang on a half-built proxy.
  process.stderr.write(
    `invariant-mcp-proxy: could not start upstream "${config.upstream.command}": ` +
      `${err instanceof Error ? err.message : String(err)}\n`
  );
  store.close();
  process.exit(1);
});

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  await proxy.close();
  store.close();
}

process.on("SIGTERM", () => void shutdown().then(() => process.exit(0)));
process.on("SIGINT", () => void shutdown().then(() => process.exit(0)));

await proxy.connect(new StdioServerTransport());
process.stderr.write(
  `invariant-mcp-proxy: recording run ${config.run_id}, ` +
    `forwarding to "${config.upstream.command} ${(config.upstream.args ?? []).join(" ")}", ` +
    `sandboxing [${config.dangerous_tools.map((t) => t.name).join(", ") || "nothing"}]\n`
);
