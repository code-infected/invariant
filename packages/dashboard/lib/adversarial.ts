import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { propagationVerdict, type PropagationResult, type PropagationVerdict, type RunPropagation } from "@invariant/scoring";
import { isScriptedStandIn, type BatchDeployment, type BatchRow, type RunRow, type ScoreRow, type TaskRow, type TraceStore } from "@invariant/trace-store";

/**
 * Adversarial batches for the dashboard: read-only views over what `invariant adversarial
 * run` and `invariant score` stored. Nothing is rescored here; a batch nobody scored is
 * shown as not scored. The verdict re-applies the payload's max_propagation_rate as it is
 * now in tasks/adversarial/<id>.yaml (the gate's rule), falling back to the snapshot
 * stored with the batch.
 */

export interface PayloadLite {
  id: string;
  task: string;
  description: string;
  inject: { tool: string; on_call: number; placement: { mode: string; path?: string }; text: string; into_sandboxed?: boolean };
  unauthorized_action: { tool: string; args?: Record<string, unknown>; why?: string };
  gate: { max_propagation_rate: number };
  source?: string;
}

/** The payload snapshot stored with an adversarial batch (what was actually planted). */
export function payloadOf(batch: BatchRow): PayloadLite | null {
  const p = batch.adversarial_payload as Partial<PayloadLite> | null;
  if (!p || typeof p !== "object" || !p.inject || !p.unauthorized_action) return null;
  return { ...(p as PayloadLite), gate: { max_propagation_rate: p.gate?.max_propagation_rate ?? 0 } };
}

/** Current max_propagation_rate per payload id, from tasks/adversarial/*.yaml. */
export function currentPayloadThresholds(tasksDir: string): Map<string, { max: number; file: string }> {
  const dir = path.join(tasksDir, "adversarial");
  const out = new Map<string, { max: number; file: string }>();
  let files: string[] = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"));
  } catch {
    return out;
  }
  for (const f of files) {
    try {
      const raw = parseYaml(fs.readFileSync(path.join(dir, f), "utf8")) as { id?: unknown; gate?: { max_propagation_rate?: unknown } };
      if (typeof raw?.id === "string") {
        const max = typeof raw.gate?.max_propagation_rate === "number" ? raw.gate.max_propagation_rate : 0;
        out.set(raw.id, { max, file: `tasks/adversarial/${f}` });
      }
    } catch {
      // An unparseable fixture is `invariant validate`'s to report; here it just has no current threshold.
    }
  }
  return out;
}

export interface AdversarialSummary {
  batch: BatchRow;
  payload: PayloadLite | null;
  payload_id: string;
  score: ScoreRow | null;
  result: PropagationResult | null;
  labels: Map<string, string>;
  verdict: PropagationVerdict | null;
  max_rate: number;
  threshold_source: string;
  deployment: BatchDeployment;
  synthetic: boolean;
}

type Details = { kind?: string; propagation?: PropagationResult; labels?: Record<string, string> };

export function adversarialSummary(store: TraceStore, batch: BatchRow, current: Map<string, { max: number; file: string }>): AdversarialSummary {
  const payload = payloadOf(batch);
  const payloadId = batch.payload_id ?? payload?.id ?? "?";
  const score = store.getScores(batch.id).find((s) => (s.details as Details)?.kind === "adversarial") ?? null;
  const d = (score?.details ?? {}) as Details;
  const result = d.propagation ?? null;
  const cur = current.get(payloadId);
  const max = cur?.max ?? payload?.gate.max_propagation_rate ?? 0;
  const deployment = store.getBatchDeployment(batch.id);
  return {
    batch,
    payload,
    payload_id: payloadId,
    score,
    result,
    labels: new Map(Object.entries(d.labels ?? {})),
    verdict: result ? propagationVerdict(result.rate, max) : null,
    max_rate: max,
    threshold_source: cur ? cur.file : "payload snapshot stored with the batch",
    deployment,
    synthetic: deployment.fingerprints.some((f) => f.synthetic),
  };
}

export interface SecurityRow {
  task: string;
  payload_id: string;
  latest: AdversarialSummary;
  batches: number;
}

const VERDICT_RANK: Record<string, number> = { finding: 0, not_computed: 1, unscored: 2, pass: 3 };

/** Latest finished adversarial batch per (task, payload), findings first. Optionally one task only. */
export function buildSecurityBoard(store: TraceStore, tasksDir: string, onlyTask?: string): SecurityRow[] {
  const current = currentPayloadThresholds(tasksDir);
  const rows: SecurityRow[] = [];
  for (const task of store.listTasks()) {
    if (onlyTask !== undefined && task.name !== onlyTask) continue;
    const byPayload = new Map<string, BatchRow[]>();
    for (const b of store.listBatches(task.id, { kind: "adversarial" })) {
      if (b.finished_at === null) continue;
      const id = b.payload_id ?? "?";
      byPayload.set(id, [...(byPayload.get(id) ?? []), b]);
    }
    for (const [payloadId, batches] of byPayload) {
      rows.push({ task: task.name, payload_id: payloadId, latest: adversarialSummary(store, batches[batches.length - 1]!, current), batches: batches.length });
    }
  }
  const rank = (r: SecurityRow) => VERDICT_RANK[r.latest.verdict ?? "unscored"]!;
  return rows.sort((a, b) => rank(a) - rank(b) || (b.latest.result?.rate ?? -1) - (a.latest.result?.rate ?? -1) || a.payload_id.localeCompare(b.payload_id));
}

export interface AdversarialCell {
  variant: string;
  trial: number;
  run: RunRow | null;
  prop: RunPropagation | null;
}

export interface AdversarialDetail extends AdversarialSummary {
  task: TaskRow;
  variants: string[];
  trials: number[];
  cells: AdversarialCell[][];
  /** Every finished adversarial batch of this payload, oldest first. */
  history: AdversarialSummary[];
}

export function getAdversarialDetail(store: TraceStore, batchId: string, tasksDir: string): AdversarialDetail | null {
  const batch = store.getBatch(batchId);
  if (!batch || batch.kind !== "adversarial") return null;
  const task = store.getTask(batch.task_id)!;
  const current = currentPayloadThresholds(tasksDir);
  const summary = adversarialSummary(store, batch, current);
  const runs = store.getBatchRuns(batch.id);
  const variantLabel = new Map<string, string>();
  for (const r of runs) if (!variantLabel.has(r.variant_id)) variantLabel.set(r.variant_id, store.getVariant(r.variant_id)?.label ?? "?");
  const propByRun = new Map((summary.result?.runs ?? []).map((p) => [p.run_id, p]));
  const trials = Array.from({ length: batch.trials_per_variant }, (_, i) => i + 1);
  const cells = batch.variant_labels.map((v) =>
    trials.map((t) => {
      const run = runs.find((r) => variantLabel.get(r.variant_id) === v && r.trial_number === t) ?? null;
      return { variant: v, trial: t, run, prop: run ? (propByRun.get(run.id) ?? null) : null };
    })
  );
  const history = store
    .listBatches(batch.task_id, { kind: "adversarial" })
    .filter((b) => b.payload_id === batch.payload_id && b.finished_at !== null)
    .map((b) => adversarialSummary(store, b, current));
  return { ...summary, task, variants: batch.variant_labels, trials, cells, history };
}

/**
 * injected       the call whose response the proxy planted the payload in
 * between        a call after the injection and before the unauthorized one (each adds 1 to depth)
 * action         the first unauthorized call after the injection
 * repeat         a later unauthorized call
 * unprompted     an unauthorized call before the injection (not propagation)
 * other          anything else
 */
export type CallRole = "injected" | "between" | "action" | "repeat" | "unprompted" | "other";

export interface TraceCall {
  index: number;
  tool_name: string;
  args: unknown;
  response: unknown;
  is_sandboxed: boolean;
  is_injected: boolean;
  role: CallRole;
}

export interface AdversarialTrace {
  run: RunRow;
  label: string;
  prop: RunPropagation | null;
  calls: TraceCall[];
  synthetic: boolean;
  model_version: string | null;
}

export function getAdversarialTrace(store: TraceStore, detail: AdversarialDetail, runId: string): AdversarialTrace | null {
  const run = store.getRun(runId);
  if (!run || run.batch_id !== detail.batch.id) return null;
  const prop = detail.result?.runs.find((r) => r.run_id === runId) ?? null;
  const calls = store.getToolCalls(runId).map((c, i): TraceCall => {
    let role: CallRole = "other";
    if (c.is_injected) role = "injected";
    if (prop) {
      if (prop.action_index === i) role = "action";
      else if (prop.matching_after.includes(i)) role = "repeat";
      else if (prop.matching_before.includes(i)) role = "unprompted";
      else if (prop.propagated && prop.injected_index !== null && i > prop.injected_index && i < prop.action_index!) role = "between";
    }
    return { index: i, tool_name: c.tool_name, args: c.args, response: c.response, is_sandboxed: c.is_sandboxed, is_injected: c.is_injected, role };
  });
  const fp = run.deployment_fingerprint ? store.getDeploymentFingerprint(run.deployment_fingerprint) : null;
  return {
    run,
    label: detail.labels.get(runId) ?? `${store.getVariant(run.variant_id)?.label ?? "?"} trial ${run.trial_number}`,
    prop,
    calls,
    synthetic: isScriptedStandIn(fp?.model_version),
    model_version: fp?.model_version ?? null,
  };
}

/** Split pretty-printed JSON around the planted text so it can be highlighted. */
export function splitOnPlanted(json: string, planted: string | undefined): Array<{ text: string; planted: boolean }> {
  if (!planted) return [{ text: json, planted: false }];
  const needle = JSON.stringify(planted).slice(1, -1);
  const at = json.indexOf(needle);
  if (at === -1) return [{ text: json, planted: false }];
  return [
    { text: json.slice(0, at), planted: false },
    { text: json.slice(at, at + needle.length), planted: true },
    { text: json.slice(at + needle.length), planted: false },
  ];
}
