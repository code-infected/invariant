import type { ScoringRun } from "./types.js";

/**
 * Outcome consistency.
 *
 *   1. Runs whose final output is the identical string (after trimming) are one node:
 *      they are trivially equivalent, and asking a judge about a string versus itself
 *      would only spend calls. A `timeout` run has no final answer, so all timeouts form
 *      one node of their own ("timed out" is an outcome category, ARCHITECTURE.md
 *      section 7), different from every answered node without asking anyone.
 *   2. Embedding pre-filter, when an embedder is supplied: for each pair of answered
 *      nodes, cosine >= high is auto-equivalent and cosine < low is auto-different. Only
 *      the band in between goes to the judge. With no embedder, every pair is in the band.
 *   3. The judge (task rubric, temperature 0, majority of N votes) decides each remaining
 *      pair.
 *   4. Equivalent pairs are edges of a similarity graph; clusters are its connected
 *      components. Score = runs in the largest cluster / runs scored, the same shape as
 *      the state-mutation score on purpose.
 *
 * Cost note: a judged pair whose two nodes are already in the same component is skipped.
 * Connected components depend only on which edges exist, and an edge inside a component
 * changes nothing, so this gives exactly the result of judging every pair. It does NOT
 * help between clusters that really differ: every cross-cluster pair has to be judged to
 * be sure none of them links the clusters, so a 50/50 split of 80 runs with distinct
 * wording is ~1600 judged pairs x votes calls. That is the cost the pre-filter exists to
 * cut, which is why configuring models.embedder matters on a large tier.
 *
 * Also inherent to connected components: similarity chains. If A~B and B~C, A and C share
 * a cluster even if the judge would call A and C different. That is the decided formula;
 * the judged pair list in the result is there so a reader can see when it happened.
 */

export type Vote = "same" | "different" | "abstain";

export interface JudgeVerdict {
  equivalent: boolean;
  votes: Vote[];
}

/** Decides whether two final answers satisfy the same outcome under the task's rubric. */
export type JudgeFn = (a: string, b: string, rubric: string) => Promise<JudgeVerdict>;

/** Returns one vector per input text, in order. */
export type EmbedFn = (texts: string[]) => Promise<number[][]>;

export class JudgeUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JudgeUnavailableError";
  }
}

export interface OutcomeOptions {
  judge?: JudgeFn;
  /**
   * The embedding pre-filter. The CLI sets it only when invariant.config.yaml configures
   * models.embedder (createModelEmbedder); otherwise every non-identical pair of answers
   * goes to the judge, and the result says so. It is never fed by a fake embedder.
   */
  embed?: EmbedFn;
  prefilter?: { high: number; low: number };
}

export const DEFAULT_PREFILTER = { high: 0.95, low: 0.4 };

export interface OutcomeNode {
  /** The trimmed final output; null for the timeout node. */
  text: string | null;
  run_ids: string[];
}

export type PairVia =
  | "status" // timeout vs answered: different by definition
  | "embedding_high" // cosine >= high: equivalent without a judge
  | "embedding_low" // cosine < low: different without a judge
  | "judge"
  | "same_cluster"; // already connected when reached: skipped, cannot change the result

export interface PairDecision {
  /** Indices into `nodes`. */
  a: number;
  b: number;
  via: PairVia;
  /** Null only for same_cluster, where no decision was needed. */
  equivalent: boolean | null;
  cosine?: number;
  votes?: Vote[];
}

export interface OutcomeCluster {
  run_ids: string[];
  /** Indices into `nodes`. */
  nodes: number[];
}

export interface OutcomeResult {
  axis: "outcome";
  /** Largest cluster / runs scored. Null when fewer than 2 runs were scored. */
  score: number | null;
  runs_scored: number;
  nodes: OutcomeNode[];
  clusters: OutcomeCluster[];
  decisions: PairDecision[];
  judged_pairs: number;
  prefilter: "embedding" | "none";
  notes: string[];
}

export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) throw new Error(`cosine: vector lengths differ (${a.length} vs ${b.length})`);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / Math.sqrt(na * nb);
}

class UnionFind {
  private readonly parent: number[];
  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i);
  }
  find(x: number): number {
    while (this.parent[x] !== x) {
      this.parent[x] = this.parent[this.parent[x]!]!;
      x = this.parent[x]!;
    }
    return x;
  }
  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent[rb] = ra;
  }
}

/** Collapse runs into nodes of identical outcome; largest node first. */
export function outcomeNodes(runs: readonly ScoringRun[]): OutcomeNode[] {
  const byKey = new Map<string, OutcomeNode>();
  for (const run of runs) {
    const text = run.status === "timeout" ? null : (run.final_output ?? "").trim();
    const key = text === null ? "timeout" : `answer:${text}`;
    let node = byKey.get(key);
    if (!node) {
      node = { text, run_ids: [] };
      byKey.set(key, node);
    }
    node.run_ids.push(run.run_id);
  }
  return [...byKey.values()].sort((x, y) => y.run_ids.length - x.run_ids.length);
}

export async function scoreOutcome(
  runs: readonly ScoringRun[],
  rubric: string,
  options: OutcomeOptions = {}
): Promise<OutcomeResult> {
  const prefilter = options.prefilter ?? DEFAULT_PREFILTER;
  const notes: string[] = [];
  const nodes = outcomeNodes(runs);
  const uf = new UnionFind(nodes.length);
  const decisions: PairDecision[] = [];
  let judged = 0;

  const answered = nodes.map((n, i) => (n.text === null ? -1 : i)).filter((i) => i >= 0);
  const timeoutNode = nodes.findIndex((n) => n.text === null);
  if (timeoutNode >= 0) {
    for (const i of answered) {
      const [a, b] = timeoutNode < i ? [timeoutNode, i] : [i, timeoutNode];
      decisions.push({ a, b, via: "status", equivalent: false });
    }
  }

  // Pairs of answered nodes, in node order (largest nodes first, so big clusters form
  // early and more later pairs can be skipped as same_cluster).
  const band: Array<{ a: number; b: number; cosine?: number }> = [];
  let vectors: number[][] | null = null;
  if (options.embed && answered.length >= 2) {
    vectors = await options.embed(answered.map((i) => nodes[i]!.text!));
    if (vectors.length !== answered.length) {
      throw new Error(`embedder returned ${vectors.length} vectors for ${answered.length} texts`);
    }
  }
  for (let x = 0; x < answered.length; x++) {
    for (let y = x + 1; y < answered.length; y++) {
      const a = answered[x]!;
      const b = answered[y]!;
      if (vectors) {
        const cosine = cosineSimilarity(vectors[x]!, vectors[y]!);
        if (cosine >= prefilter.high) {
          uf.union(a, b);
          decisions.push({ a, b, via: "embedding_high", equivalent: true, cosine });
          continue;
        }
        if (cosine < prefilter.low) {
          decisions.push({ a, b, via: "embedding_low", equivalent: false, cosine });
          continue;
        }
        band.push({ a, b, cosine });
      } else {
        band.push({ a, b });
      }
    }
  }
  if (!options.embed) {
    notes.push("embedding pre-filter not configured (no models.embedder in invariant.config.yaml): every pair of non-identical answers went to the judge");
  }

  for (const pair of band) {
    if (uf.find(pair.a) === uf.find(pair.b)) {
      decisions.push({ ...pair, via: "same_cluster", equivalent: null });
      continue;
    }
    if (!options.judge) {
      throw new JudgeUnavailableError(
        `${band.length} pair(s) of differing answers need the judge, and no judge is configured`
      );
    }
    const verdict = await options.judge(nodes[pair.a]!.text!, nodes[pair.b]!.text!, rubric);
    judged++;
    if (verdict.equivalent) uf.union(pair.a, pair.b);
    decisions.push({ ...pair, via: "judge", equivalent: verdict.equivalent, votes: verdict.votes });
  }

  const components = new Map<number, OutcomeCluster>();
  nodes.forEach((node, i) => {
    const root = uf.find(i);
    let cluster = components.get(root);
    if (!cluster) {
      cluster = { run_ids: [], nodes: [] };
      components.set(root, cluster);
    }
    cluster.nodes.push(i);
    cluster.run_ids.push(...node.run_ids);
  });
  const clusters = [...components.values()].sort((x, y) => y.run_ids.length - x.run_ids.length);

  let score: number | null = null;
  if (runs.length < 2) {
    notes.push(`consistency needs at least 2 runs to compare, got ${runs.length}`);
  } else {
    score = clusters[0]!.run_ids.length / runs.length;
  }

  return {
    axis: "outcome",
    score,
    runs_scored: runs.length,
    nodes,
    clusters,
    decisions,
    judged_pairs: judged,
    prefilter: options.embed ? "embedding" : "none",
    notes,
  };
}
