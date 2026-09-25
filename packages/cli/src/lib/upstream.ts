import { createRequire } from "node:module";
import path from "node:path";
import { listUpstreamTools } from "@invariant/agent-driver";
import type { UpstreamConfig } from "@invariant/mcp-proxy";
import type { ToyServerName } from "@invariant/toy-tool-server";
import type { ValidTask } from "./load-tasks.js";
import { REPO_ROOT } from "./paths.js";

const require_ = createRequire(import.meta.url);

/**
 * The tool-server registry: which MCP server the proxy forwards to, per task.
 *
 * An explicit task -> server mapping, never inferred from tool names: two servers can
 * serve a tool with the same name and different behaviour, and guessing would silently
 * run a task against the wrong backend. A task not listed here has no tool server and
 * `invariant run` refuses it.
 *
 * It lives in code rather than invariant.config.yaml because every server it names is a
 * toy server built from this repo (resolved through node's module resolution, not a path
 * a config file would have to hardcode). Pointing a task at somebody else's real MCP
 * server is a per-target deployment decision (internal-docs/TECHNICAL_SPEC.md section
 * 8); when the first such target exists, this is the table a config section replaces.
 */
export const TOOL_SERVERS: Record<string, { toy: ToyServerName; description: string }> = {
  "toy-refund": { toy: "refund", description: "orders and refunds (fixture: order 1234 already refunded)" },
  "toy-workspace": { toy: "workspace", description: "in-memory project workspace with a build/ of temp files and artifacts" },
  "toy-research": { toy: "research", description: "search and fetch over a small fixed, fictional web corpus" },
};

export const TASK_TOOL_SERVERS: Record<string, string> = {
  "refund-duplicate-check": "toy-refund",
  "code-agent-destructive-command": "toy-workspace",
  "research-citation-integrity": "toy-research",
};

export interface TaskUpstream {
  /** Registry name, e.g. "toy-refund". */
  server: string;
  upstream: UpstreamConfig;
}

export function toolServerUpstream(server: string): UpstreamConfig {
  const entry = TOOL_SERVERS[server];
  if (!entry) throw new Error(`no tool server named "${server}" in the registry (known: ${Object.keys(TOOL_SERVERS).join(", ")})`);
  return { command: process.execPath, args: [require_.resolve("@invariant/toy-tool-server/bin"), entry.toy] };
}

/** The registered tool server for a task, or null when the task has none. */
export function upstreamForTask(taskName: string): TaskUpstream | null {
  const server = TASK_TOOL_SERVERS[taskName];
  return server === undefined ? null : { server, upstream: toolServerUpstream(server) };
}

/** Like upstreamForTask, but a task without a server is an error naming the fix. */
export function requireUpstream(taskName: string): TaskUpstream {
  const found = upstreamForTask(taskName);
  if (!found) {
    throw new Error(
      `no tool server is registered for task "${taskName}". Add it to TASK_TOOL_SERVERS in packages/cli/src/lib/upstream.ts.`
    );
  }
  return found;
}

/** For messages and reports: node for this node binary, repo-relative paths for files in the repo. */
export function describeUpstream(upstream: UpstreamConfig): string {
  const short = (p: string) => {
    if (p === process.execPath) return "node";
    const rel = path.relative(REPO_ROOT, p);
    return path.isAbsolute(p) && !rel.startsWith("..") ? rel : p;
  };
  return [short(upstream.command), ...upstream.args.map(short)].join(" ");
}

/** Why a task cannot run: no registered server, or a server that lacks some declared tools. */
export interface CoverageGap {
  /** Registry name, or null when the task has no registered server. */
  server: string | null;
  upstream: UpstreamConfig | null;
  /** Tools the server serves, sorted; empty when there is no server. */
  served: string[];
  /** Declared tools the server does not serve; every declared tool when there is no server. */
  missing: string[];
}

/** Resolves a task to its tool server; the registry by default, replaceable in tests. */
export type UpstreamResolver = (taskName: string) => TaskUpstream | null;

/**
 * Which tasks cannot run, and why.
 *
 * The agent's tool surface is whatever the task's server serves, not what the task spec
 * says, so a task pointed at a server that lacks its tools would run happily against the
 * wrong tools and fill the trace store with runs that measure nothing. `run` refuses (or,
 * with --runnable-only, skips) such tasks; `gate` reports them as not gated. Each distinct
 * server is asked for its tool list once.
 */
export async function toolCoverage(
  tasks: readonly ValidTask[],
  resolve: UpstreamResolver = upstreamForTask
): Promise<Map<string, CoverageGap>> {
  const servedBy = new Map<string, Promise<string[]>>();
  const gaps = new Map<string, CoverageGap>();
  for (const task of tasks) {
    const found = resolve(task.spec.name);
    if (!found) {
      gaps.set(task.spec.name, { server: null, upstream: null, served: [], missing: [...task.spec.tools.allowed] });
      continue;
    }
    const key = JSON.stringify(found.upstream);
    if (!servedBy.has(key)) servedBy.set(key, listUpstreamTools(found.upstream));
    const served = await servedBy.get(key)!;
    const set = new Set(served);
    const missing = task.spec.tools.allowed.filter((t) => !set.has(t));
    if (missing.length > 0) gaps.set(task.spec.name, { server: found.server, upstream: found.upstream, served, missing });
  }
  return gaps;
}

/** One line on why a task cannot run, for run's refusal and gate's "not gated" entry. */
export function describeGap(gap: CoverageGap): string {
  if (gap.server === null || gap.upstream === null) {
    return "no tool server is registered for it (TASK_TOOL_SERVERS in packages/cli/src/lib/upstream.ts)";
  }
  return (
    `its tool server ${gap.server} (${describeUpstream(gap.upstream)}) serves [${gap.served.join(", ")}] ` +
    `and not [${gap.missing.join(", ")}]`
  );
}
