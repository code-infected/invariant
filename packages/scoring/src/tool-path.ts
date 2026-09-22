import type { ScoringRun } from "./types.js";

/**
 * Tool-path consistency.
 *
 * Token choice, decided once and used everywhere: a run's path is the ordered list of
 * tool NAMES it called, every tool (not just dangerous ones), and one token is one tool
 * name. Arguments are not part of the token. The reason is that free-text arguments make
 * name+args tokens measure wording: reply_to_user carries the agent's final message as an
 * argument, so two runs that took the identical path but phrased their answer differently
 * would score as diverging at that step, double-counting what the outcome axis already
 * measures. Whether the side-effecting calls carried the same arguments is the
 * state-mutation axis's job, and that axis does compare (masked) arguments exactly.
 * Because arguments never enter a token here, volatile-field masking is a no-op for this
 * axis by construction, not by omission.
 *
 * Pairwise similarity = 1 - levenshtein(a, b) / max(len(a), len(b)), with unit cost for
 * insert, delete and substitute. Two empty paths (neither run called a tool) are
 * identical and score 1. Score = mean similarity over every unordered pair of runs.
 */

/** Edit distance between two token sequences (insert / delete / substitute, each cost 1). */
export function levenshtein<T>(a: readonly T[], b: readonly T[]): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      const substitute = prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1);
      cur.push(Math.min(prev[j]! + 1, cur[j - 1]! + 1, substitute));
    }
    prev = cur;
  }
  return prev[b.length]!;
}

export function pathSimilarity(a: readonly string[], b: readonly string[]): number {
  const longest = Math.max(a.length, b.length);
  if (longest === 0) return 1;
  return 1 - levenshtein(a, b) / longest;
}

export function toolPath(run: Pick<ScoringRun, "tool_calls">): string[] {
  return run.tool_calls.map((c) => c.tool_name);
}

export interface DistinctPath {
  path: string[];
  run_ids: string[];
}

export interface ToolPathResult {
  axis: "tool_path";
  /** Mean pairwise similarity. Null when fewer than 2 runs were scored. */
  score: number | null;
  runs_scored: number;
  pairs: number;
  /** Every distinct path, most common first. */
  distinct_paths: DistinctPath[];
  /** The least similar pair, to point a reader at the widest divergence. */
  min_pair: { a: string; b: string; similarity: number } | null;
  notes: string[];
}

export function scoreToolPath(runs: readonly ScoringRun[]): ToolPathResult {
  const paths = runs.map(toolPath);
  const notes: string[] = [];

  const byPath = new Map<string, DistinctPath>();
  runs.forEach((run, i) => {
    const key = JSON.stringify(paths[i]);
    let entry = byPath.get(key);
    if (!entry) {
      entry = { path: paths[i]!, run_ids: [] };
      byPath.set(key, entry);
    }
    entry.run_ids.push(run.run_id);
  });
  const distinct = [...byPath.values()].sort((x, y) => y.run_ids.length - x.run_ids.length);

  if (runs.length < 2) {
    notes.push(`consistency needs at least 2 runs to compare, got ${runs.length}`);
    return { axis: "tool_path", score: null, runs_scored: runs.length, pairs: 0, distinct_paths: distinct, min_pair: null, notes };
  }

  let sum = 0;
  let pairs = 0;
  let minPair: ToolPathResult["min_pair"] = null;
  for (let i = 0; i < runs.length; i++) {
    for (let j = i + 1; j < runs.length; j++) {
      const s = pathSimilarity(paths[i]!, paths[j]!);
      sum += s;
      pairs++;
      if (minPair === null || s < minPair.similarity) {
        minPair = { a: runs[i]!.run_id, b: runs[j]!.run_id, similarity: s };
      }
    }
  }

  return { axis: "tool_path", score: sum / pairs, runs_scored: runs.length, pairs, distinct_paths: distinct, min_pair: minPair, notes };
}
