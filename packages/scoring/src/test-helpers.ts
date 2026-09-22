import type { ScoringRun, ScoringToolCall } from "./types.js";

/** Shorthand for a hand-built run. `calls` entries are tool names or [name, args]. */
export function run(
  id: string,
  calls: Array<string | [string, unknown]>,
  final_output: string | null = "done",
  status: ScoringRun["status"] = "ok"
): ScoringRun {
  const tool_calls: ScoringToolCall[] = calls.map((c) =>
    typeof c === "string" ? { tool_name: c, args: {} } : { tool_name: c[0], args: c[1] }
  );
  return { run_id: id, status, final_output, tool_calls };
}
