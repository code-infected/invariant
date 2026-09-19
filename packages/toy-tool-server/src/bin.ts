#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createToyToolServer } from "./server.js";

const server = createToyToolServer();
await server.connect(new StdioServerTransport());
// stdout is the MCP channel; anything human-readable has to go to stderr.
process.stderr.write("invariant toy tool server listening on stdio\n");
