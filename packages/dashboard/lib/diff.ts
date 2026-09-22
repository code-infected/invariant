import { canonicalJson, maskVolatile, MASKED, pathSimilarity } from "@invariant/scoring";
import { isScriptedStandIn, type RunRow, type ToolCallRow, type TraceStore } from "@invariant/trace-store";
import { align, type AlignOp } from "./align";

export interface CallView {
  sequence_index: number;
  tool_name: string;
  is_sandboxed: boolean;
  args_raw: unknown;
  /** Args with the task's volatile fields replaced by <masked>, as the scorer compares them. */
  args_masked: unknown;
  /** Dotted paths of the fields that were masked. */
  masked_fields: string[];
  response: unknown;
  timestamp: string;
}

export interface RunSide {
  run: RunRow;
  task_name: string;
  batch_id: string | null;
  variant: string;
  prompt: string;
  calls: CallView[];
  fingerprint: string | null;
  model_version: string | null;
  synthetic: boolean;
}

export interface DiffRow {
  op: AlignOp;
  left: CallView | null;
  right: CallView | null;
  /** For matched tool names: whether the masked args are identical. Null otherwise. */
  args_equal: boolean | null;
}

export interface TraceDiff {
  a: RunSide;
  b: RunSide;
  rows: DiffRow[];
  /** Index into rows of the first row that differs (tool or masked args); null if none. */
  first_divergence: number | null;
  divergence_kind: "tool" | "args" | null;
  /** The tool-path axis's pairwise similarity for these two runs. */
  path_similarity: number;
  volatile_fields: string[];
  same_task: boolean;
}

/** Paths of keys whose value maskVolatile would replace. */
export function maskedPaths(value: unknown, fields: readonly string[], prefix = ""): string[] {
  const set = new Set(fields);
  const out: string[] = [];
  const walk = (v: unknown, p: string) => {
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${p}[${i}]`));
    else if (v !== null && typeof v === "object") {
      for (const [k, inner] of Object.entries(v as Record<string, unknown>)) {
        const here = p ? `${p}.${k}` : k;
        if (set.has(k)) out.push(here);
        else walk(inner, here);
      }
    }
  };
  walk(value, prefix);
  return out;
}

function callView(c: ToolCallRow, volatile: string[]): CallView {
  return {
    sequence_index: c.sequence_index,
    tool_name: c.tool_name,
    is_sandboxed: c.is_sandboxed,
    args_raw: c.args,
    args_masked: maskVolatile(c.args, volatile),
    masked_fields: maskedPaths(c.args, volatile),
    response: c.response,
    timestamp: c.timestamp,
  };
}

export function volatileFieldsOf(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((f): f is string => typeof f === "string") : [];
}

export function runSide(store: TraceStore, runId: string): RunSide | null {
  const rec = store.getRunRecord(runId);
  if (!rec) return null;
  const volatile = volatileFieldsOf(rec.task.volatile_fields);
  const fp = rec.run.deployment_fingerprint ? store.getDeploymentFingerprint(rec.run.deployment_fingerprint) : null;
  return {
    run: rec.run,
    task_name: rec.task.name,
    batch_id: rec.run.batch_id,
    variant: rec.variant.label,
    prompt: rec.variant.phrasing_text,
    calls: rec.tool_calls.map((c) => callView(c, volatile)),
    fingerprint: rec.run.deployment_fingerprint,
    model_version: fp?.model_version ?? null,
    synthetic: isScriptedStandIn(fp?.model_version),
  };
}

export function diffRuns(store: TraceStore, aId: string, bId: string): TraceDiff | null {
  const a = runSide(store, aId);
  const b = runSide(store, bId);
  if (!a || !b) return null;
  // Masking uses run a's task's volatile fields; across tasks the union, and the page says so.
  const taskA = store.getTask(a.run.task_id);
  const taskB = store.getTask(b.run.task_id);
  const volatile = [...new Set([...volatileFieldsOf(taskA?.volatile_fields), ...volatileFieldsOf(taskB?.volatile_fields)])];
  const remask = (s: RunSide) => ({ ...s, calls: s.calls.map((c) => ({ ...c, args_masked: maskVolatile(c.args_raw, volatile), masked_fields: maskedPaths(c.args_raw, volatile) })) });
  const A = remask(a);
  const B = remask(b);
  const steps = align(
    A.calls.map((c) => c.tool_name),
    B.calls.map((c) => c.tool_name)
  );
  const rows: DiffRow[] = steps.map((s) => {
    const left = s.i === null ? null : A.calls[s.i]!;
    const right = s.j === null ? null : B.calls[s.j]!;
    return {
      op: s.op,
      left,
      right,
      args_equal: s.op === "match" ? canonicalJson(left!.args_masked) === canonicalJson(right!.args_masked) : null,
    };
  });
  const firstTool = rows.findIndex((r) => r.op !== "match");
  const firstArgs = rows.findIndex((r) => r.args_equal === false);
  let first: number | null = null;
  let kind: TraceDiff["divergence_kind"] = null;
  const candidates = [firstTool, firstArgs].filter((i) => i >= 0);
  if (candidates.length) {
    first = Math.min(...candidates);
    kind = first === firstTool ? "tool" : "args";
  }
  return {
    a: A,
    b: B,
    rows,
    first_divergence: first,
    divergence_kind: kind,
    path_similarity: pathSimilarity(A.calls.map((c) => c.tool_name), B.calls.map((c) => c.tool_name)),
    volatile_fields: volatile,
    same_task: a.run.task_id === b.run.task_id,
  };
}

export { MASKED };
