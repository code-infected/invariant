import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type { Thresholds } from "@invariant/scoring";

/**
 * The few task-spec fields the dashboard shows, read straight from tasks/*.yaml. Full
 * validation is `invariant validate`'s job; a spec that does not parse is listed with
 * its error rather than hidden.
 */
export interface TaskSpecLite {
  name: string;
  file: string;
  allowed_tools: string[];
  thresholds: Thresholds | null;
  error?: string;
}

export function parseThresholds(raw: unknown): Thresholds | null {
  if (!raw || typeof raw !== "object") return null;
  const t = raw as Record<string, unknown>;
  const nums = ["outcome_consistency_min", "tool_path_consistency_min", "state_mutation_consistency"] as const;
  if (!nums.every((k) => typeof t[k] === "number")) return null;
  return {
    outcome_consistency_min: t.outcome_consistency_min as number,
    tool_path_consistency_min: t.tool_path_consistency_min as number,
    state_mutation_consistency: t.state_mutation_consistency as number,
  };
}

export function loadSpecs(dir: string): TaskSpecLite[] {
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"));
  } catch {
    return [];
  }
  return files.sort().map((f) => {
    const file = path.join(dir, f);
    const fallback = f.replace(/\.ya?ml$/, "");
    try {
      const raw = parseYaml(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
      const tools = (raw?.tools ?? {}) as Record<string, unknown>;
      return {
        name: typeof raw?.name === "string" ? raw.name : fallback,
        file: `tasks/${f}`,
        allowed_tools: Array.isArray(tools.allowed) ? tools.allowed.filter((t): t is string => typeof t === "string") : [],
        thresholds: parseThresholds(raw?.thresholds),
      };
    } catch (err) {
      return { name: fallback, file: `tasks/${f}`, allowed_tools: [], thresholds: null, error: (err as Error).message };
    }
  });
}
