#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { isToyServerName, TOY_SERVERS } from "./servers.js";

// Usage: invariant-toy-tool-server [refund|workspace|research]   (default: refund)
const name = process.argv[2] ?? "refund";
if (!isToyServerName(name)) {
  process.stderr.write(`unknown toy server "${name}"; expected one of: ${Object.keys(TOY_SERVERS).join(", ")}\n`);
  process.exit(2);
}
const server = TOY_SERVERS[name]();
await server.connect(new StdioServerTransport());
// stdout is the MCP channel; anything human-readable has to go to stderr.
process.stderr.write(`invariant toy tool server (${name}) listening on stdio\n`);
