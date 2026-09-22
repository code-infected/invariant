import { createRequire } from "node:module";
import path from "node:path";
import { listUpstreamTools } from "@invariant/agent-driver";
import type { UpstreamConfig } from "@invariant/mcp-proxy";
import type { LoadedTask } from "./load-tasks.js";
import { REPO_ROOT } from "./paths.js";

const require_ = createRequire(import.meta.url);

/**
 * The tool server the proxy forwards to.
 *
 * Hardcoded to the toy server for now, on purpose: this milestone proves the
 * instrumentation path end to end, and the toy server is the only tool server in the
 * repo. Pointing the harness at somebody else's real MCP server is a per-target
 * deployment decision (see the proxy notes in internal-docs/TECHNICAL_SPEC.md section 8),
 * so it belongs in invariant.config.yaml once there is a second target to configure for,
 * not in an invented config key nothing reads yet.
 */
export function defaultUpstream(): UpstreamConfig {
  return {
    command: process.execPath,
    args: [require_.resolve("@invariant/toy-tool-server/bin")],
  };
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

export interface ToolCoverage {
  /** Tool names the upstream serves, sorted. */
  served: string[];
  /** Task name -> declared tools the upstream does not serve. Only tasks with a gap appear. */
  missing: Map<string, string[]>;
}

/**
 * Which tasks' declared tools the upstream actually serves.
 *
 * The agent's tool surface is whatever the upstream serves, not what the task spec says,
 * so a task written for a different tool server would run happily against the wrong
 * tools and fill the trace store with runs that measure nothing. `run` refuses (or, with
 * --runnable-only, skips) such tasks; `gate` reports them as not gated.
 */
export async function toolCoverage(tasks: readonly LoadedTask[], upstream: UpstreamConfig): Promise<ToolCoverage> {
  const served = await listUpstreamTools(upstream);
  const set = new Set(served);
  const missing = new Map<string, string[]>();
  for (const task of tasks) {
    const gap = task.spec.tools.allowed.filter((t) => !set.has(t));
    if (gap.length > 0) missing.set(task.spec.name, gap);
  }
  return { served, missing };
}
