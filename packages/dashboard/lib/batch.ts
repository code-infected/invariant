import { canonicalJson, type AxisGate, type GateVerdict } from "@invariant/scoring";
import type { BatchDeployment, BatchRow, RunRow, ScoreRow, TaskRow, TraceStore } from "@invariant/trace-store";
import { isScriptedStandIn } from "@invariant/trace-store";
import { detailsOf, thresholdsFor, verdictFor } from "./scores";
import type { TaskSpecLite } from "./specs";

export type GroupingKind = "mutation" | "path" | "outcome";

export interface GroupMember {
  run_id: string;
  variant: string;
  trial: number;
}

export interface Group {
  /** "A", "B", ... in the order the scorer ranked them (largest first). */
  letter: string;
  /** What the members share: a mutation signature, a tool path, an answer. */
  label: string;
  members: GroupMember[];
}

export interface Grouping {
  kind: GroupingKind;
  title: string;
  /** Where the grouping came from, shown next to it. */
  source: string;
  groups: Group[];
  /** Why there is no grouping, or a caveat about it. */
  note: string | null;
}

export interface MatrixCell {
  variant: string;
  trial: number;
  run: RunRow | null;
  /** Earlier attempts replaced by an infra retry (evidence, not part of the matrix). */
  superseded: RunRow[];
  path: string[];
  /** Letter of this run's group in each grouping, when it has one. */
  groups: Partial<Record<GroupingKind, string>>;
  synthetic: boolean;
}

export interface BatchDetail {
  task: TaskRow;
  batch: BatchRow;
  variants: string[];
  trials: number[];
  /** cells[variantIndex][trialIndex] */
  cells: MatrixCell[][];
  groupings: Grouping[];
  score: ScoreRow | null;
  axes: AxisGate[] | null;
  verdict: GateVerdict | null;
  thresholds_source: string | null;
  deployment: BatchDeployment;
  /** A run from the largest state-mutation group (else the first run): the default comparison side. */
  reference_run: string | null;
  runs_total: number;
  excluded: Array<{ run_id: string; status: string }>;
}

const letter = (i: number) => (i < 26 ? String.fromCharCode(65 + i) : `G${i + 1}`);

function signatureLabel(signature: Array<{ tool_name: string; args: unknown }>): string {
  return signature.length === 0 ? "(no dangerous calls)" : signature.map((c) => `${c.tool_name} ${canonicalJson(c.args)}`).join(" ; ");
}

export function getBatchDetail(store: TraceStore, batchId: string, specs: TaskSpecLite[]): BatchDetail | null {
  const batch = store.getBatch(batchId);
  if (!batch) return null;
  const task = store.getTask(batch.task_id)!;
  const all = store.getBatchRuns(batch.id, { includeSuperseded: true });
  const matrix = all.filter((r) => !r.superseded);
  const variantLabel = new Map<string, string>();
  for (const r of all) if (!variantLabel.has(r.variant_id)) variantLabel.set(r.variant_id, store.getVariant(r.variant_id)?.label ?? "?");
  const member = (runId: string): GroupMember | null => {
    const r = matrix.find((x) => x.id === runId);
    return r ? { run_id: r.id, variant: variantLabel.get(r.variant_id)!, trial: r.trial_number } : null;
  };
  const members = (ids: string[]) =>
    ids
      .map(member)
      .filter((m): m is GroupMember => m !== null)
      .sort((a, b) => a.variant.localeCompare(b.variant, undefined, { numeric: true }) || a.trial - b.trial);

  const score = store.getScores(batch.id)[0] ?? null;
  const d = detailsOf(score);
  const groupings: Grouping[] = [];

  const sm = d.state_mutation?.result;
  groupings.push({
    kind: "mutation",
    title: "Mutation signature",
    source: "scores.details (state-mutation axis: dangerous calls, volatile fields masked, exact match)",
    groups: sm ? sm.groups.map((g, i) => ({ letter: letter(i), label: signatureLabel(g.signature), members: members(g.run_ids) })) : [],
    note: score ? (sm ? null : "no state-mutation evidence in the stored score") : "batch not scored yet: run invariant score",
  });

  const tp = d.tool_path?.result;
  groupings.push({
    kind: "path",
    title: "Tool path",
    source: "scores.details (tool-path axis: ordered tool names)",
    groups: tp
      ? tp.distinct_paths.map((p, i) => ({ letter: letter(i), label: p.path.length ? p.path.join(" > ") : "(no tool calls)", members: members(p.run_ids) }))
      : [],
    note: score ? (tp ? null : "no tool-path evidence in the stored score") : "batch not scored yet: run invariant score",
  });

  const oc = d.outcome?.result;
  if (oc) {
    groupings.push({
      kind: "outcome",
      title: "Outcome cluster",
      source: "scores.details (outcome axis: identical answers merged, the rest judged)",
      groups: oc.clusters.map((c, i) => {
        const text = oc.nodes[c.nodes[0]!]?.text ?? null;
        return {
          letter: letter(i),
          label: text === null ? "(timed out)" : text + (c.nodes.length > 1 ? `  (+${c.nodes.length - 1} judged-equivalent wording)` : ""),
          members: members(c.run_ids),
        };
      }),
      note: null,
    });
  } else {
    // No clusters without the judge. Group by identical final text instead and say so:
    // it is a strictly weaker grouping (two wordings of the same answer land apart).
    const byText = new Map<string, string[]>();
    for (const r of matrix) {
      if (r.status !== "ok" && r.status !== "timeout") continue;
      const key = r.status === "timeout" ? "\u0000timeout" : (r.final_output ?? "").trim();
      byText.set(key, [...(byText.get(key) ?? []), r.id]);
    }
    const groups = [...byText.entries()]
      .sort((a, b) => b[1].length - a[1].length)
      .map(([text, ids], i) => ({ letter: letter(i), label: text === "\u0000timeout" ? "(timed out)" : text || "(empty answer)", members: members(ids) }));
    groupings.push({
      kind: "outcome",
      title: "Final answer (identical text)",
      source: "run final_output, grouped by exact text",
      groups,
      note: score
        ? `outcome axis NOT COMPUTED${d.outcome?.error ? `: ${d.outcome.error.split(".")[0]}` : ""}. These groups are exact-text matches, not judged outcome clusters.`
        : "batch not scored yet; grouped by exact final text only.",
    });
  }

  const letterOf = new Map<string, Partial<Record<GroupingKind, string>>>();
  for (const g of groupings) for (const grp of g.groups) for (const m of grp.members) {
    letterOf.set(m.run_id, { ...(letterOf.get(m.run_id) ?? {}), [g.kind]: grp.letter });
  }

  const variants = batch.variant_labels;
  const trials = Array.from({ length: batch.trials_per_variant }, (_, i) => i + 1);
  const fpSynthetic = new Map<string, boolean>();
  const synthetic = (hash: string | null) => {
    if (!hash) return false;
    if (!fpSynthetic.has(hash)) fpSynthetic.set(hash, isScriptedStandIn(store.getDeploymentFingerprint(hash)?.model_version));
    return fpSynthetic.get(hash)!;
  };
  const cells = variants.map((v) =>
    trials.map((t) => {
      const here = all.filter((r) => variantLabel.get(r.variant_id) === v && r.trial_number === t);
      const run = here.find((r) => !r.superseded) ?? null;
      return {
        variant: v,
        trial: t,
        run,
        superseded: here.filter((r) => r.superseded).sort((a, b) => a.attempt - b.attempt),
        path: run ? store.getToolCalls(run.id).map((c) => c.tool_name) : [],
        groups: run ? (letterOf.get(run.id) ?? {}) : {},
        synthetic: synthetic(run?.deployment_fingerprint ?? null),
      };
    })
  );

  const th = thresholdsFor(task, specs.find((s) => s.name === task.name));
  const v = score && th ? verdictFor(score, th.thresholds) : null;
  const reference = groupings[0]!.groups[0]?.members[0]?.run_id ?? matrix[0]?.id ?? null;
  return {
    task,
    batch,
    variants,
    trials,
    cells,
    groupings,
    score,
    axes: v?.axes ?? null,
    verdict: v?.verdict ?? null,
    thresholds_source: th?.source ?? null,
    deployment: store.getBatchDeployment(batch.id),
    reference_run: reference,
    runs_total: matrix.length,
    excluded: matrix.filter((r) => r.status !== "ok" && r.status !== "timeout").map((r) => ({ run_id: r.id, status: r.status })),
  };
}

/** "v1 t1, v1 t3; v2 t2" style listing, grouped by variant. */
export function memberSummary(ms: GroupMember[]): string {
  const byVariant = new Map<string, number[]>();
  for (const m of ms) byVariant.set(m.variant, [...(byVariant.get(m.variant) ?? []), m.trial]);
  return [...byVariant.entries()]
    .sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }))
    .map(([v, ts]) => `${v}: trial${ts.length > 1 ? "s" : ""} ${ts.sort((a, b) => a - b).join(", ")}`)
    .join("; ");
}
