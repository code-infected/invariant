import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createToyToolServer } from "./server.js";
import { createWorkspaceToolServer } from "./workspace.js";
import { createResearchToolServer } from "./research.js";

/**
 * Every toy server in this package, by the name `invariant-toy-tool-server <name>` takes.
 * Which task uses which is decided by the CLI's tool-server registry, not here.
 */
export const TOY_SERVERS = {
  refund: createToyToolServer,
  workspace: createWorkspaceToolServer,
  research: createResearchToolServer,
} as const satisfies Record<string, () => McpServer>;

export type ToyServerName = keyof typeof TOY_SERVERS;

export function isToyServerName(name: string): name is ToyServerName {
  return Object.prototype.hasOwnProperty.call(TOY_SERVERS, name);
}
