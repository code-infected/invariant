/**
 * Sequence alignment for the trace diff: the same edit model as the tool-path axis
 * (unit-cost insert / delete / substitute Levenshtein over tool names), with a backtrace
 * so the two sequences can be laid out side by side. The distance of the returned
 * alignment always equals @invariant/scoring's levenshtein() for the same inputs.
 */
export type AlignOp = "match" | "substitute" | "delete" | "insert";

export interface AlignStep {
  op: AlignOp;
  /** Index into a (null for insert). */
  i: number | null;
  /** Index into b (null for delete). */
  j: number | null;
}

export function align<T>(a: readonly T[], b: readonly T[], eq: (x: T, y: T) => boolean = (x, y) => x === y): AlignStep[] {
  const n = a.length;
  const m = b.length;
  const d: number[][] = Array.from({ length: n + 1 }, (_, i) => Array.from({ length: m + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (eq(a[i - 1]!, b[j - 1]!) ? 0 : 1));
    }
  }
  const steps: AlignStep[] = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    // Prefer the diagonal (match/substitute) so a changed step lines up as one row.
    if (i > 0 && j > 0 && d[i]![j] === d[i - 1]![j - 1]! + (eq(a[i - 1]!, b[j - 1]!) ? 0 : 1)) {
      steps.push({ op: eq(a[i - 1]!, b[j - 1]!) ? "match" : "substitute", i: i - 1, j: j - 1 });
      i--;
      j--;
    } else if (i > 0 && d[i]![j] === d[i - 1]![j]! + 1) {
      steps.push({ op: "delete", i: i - 1, j: null });
      i--;
    } else {
      steps.push({ op: "insert", i: null, j: j - 1 });
      j--;
    }
  }
  return steps.reverse();
}

export function alignmentDistance(steps: AlignStep[]): number {
  return steps.filter((s) => s.op !== "match").length;
}
