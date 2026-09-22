import { createHash } from "node:crypto";
import { AXES, evaluateGate, type AxisName, type Thresholds } from "@invariant/scoring";
import { isScriptedStandIn, type RunRow, type ToolCallRow, type TraceStore } from "@invariant/trace-store";
import { ERROR_TYPE, GEN_AI, INV } from "./attributes.js";

/**
 * The mapping from one stored batch to one OpenTelemetry trace, as plain data.
 *
 *   trace   = the batch (trace id = the batch id's 32 hex digits)
 *   root    = "invariant.batch" span: batch metadata, the latest stored score's axes as
 *             attributes, one gen_ai.evaluation.result event per axis
 *   child   = one "invoke_agent" span per run (every attempt, superseded infra retries
 *             included and marked, since they are evidence too)
 *   leaf    = one "execute_tool <name>" span per recorded tool call, sandboxed ones marked
 *
 * Every timestamp is one the harness recorded: batch created/finished, run started/
 * finished (raw trace; else created_at + latency_ms), each tool call's timestamp, the
 * score's computed_at. Nothing is stamped with export time. The proxy records when a
 * tool call started but not when it returned, so tool spans are zero-length at the
 * recorded call time, and say so (invariant.tool.timing = "start_only").
 *
 * Span ids are derived from the run id / tool call position, so exporting the same batch
 * twice produces the same ids.
 *
 * Pure apart from reading the store; the SDK side is in emit.ts.
 */
export interface PlannedEvent {
  name: string;
  time: Date;
  attributes: Record<string, AttrValue>;
}

export type AttrValue = string | number | boolean | string[];

export interface PlannedSpan {
  name: string;
  spanId: string;
  start: Date;
  end: Date;
  attributes: Record<string, AttrValue>;
  events: PlannedEvent[];
  /** Set for runs that ended without a behavioural answer (infra_error). */
  error?: string;
  children: PlannedSpan[];
}

export interface TracePlan {
  traceId: string;
  batchId: string;
  task: string;
  root: PlannedSpan;
  counts: { runs: number; tool_calls: number; sandboxed_tool_calls: number };
  /** Null when the batch has no stored score (run `invariant score` first to include one). */
  score: { id: string; computed_at: string; verdict: string } | null;
}

export interface PlanOptions {
  /**
   * Thresholds for the per-axis pass/fail, with where they came from. The CLI passes
   * tasks/<name>.yaml as it is now, like the gate; default: the copy stored with the task.
   */
  thresholds?: { thresholds: Thresholds; source: string };
  /** Longest string attribute value (prompt, final output, tool args/result). Default 4096. */
  maxValueLength?: number;
}

/** 32 lowercase hex digits of a UUID, the natural trace id for a batch. */
export function traceIdForBatch(batchId: string): string {
  const hex = batchId.replace(/-/g, "").toLowerCase();
  if (/^[0-9a-f]{32}$/.test(hex) && !/^0+$/.test(hex)) return hex;
  return createHash("sha256").update(`batch:${batchId}`).digest("hex").slice(0, 32);
}

export function spanIdFor(key: string): string {
  const id = createHash("sha256").update(key).digest("hex").slice(0, 16);
  return id === "0000000000000000" ? "0000000000000001" : id;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max - 1) + "…";
}

function jsonString(value: unknown, max: number): string {
  return truncate(typeof value === "string" ? value : JSON.stringify(value ?? null), max);
}

function parseThresholds(raw: unknown): Thresholds | null {
  if (!raw || typeof raw !== "object") return null;
  const t = raw as Record<string, unknown>;
  const keys = ["outcome_consistency_min", "tool_path_consistency_min", "state_mutation_consistency"] as const;
  return keys.every((k) => typeof t[k] === "number") ? (t as unknown as Thresholds) : null;
}

/** What run-trial.ts writes to the raw trace blob; every field optional, since blobs can be old or missing. */
interface RawTrace {
  /** Written since the agent driver became provider-neutral; absent in older blobs. */
  provider?: string;
  model?: string;
  model_versions_seen?: string[];
  stop_reason?: string | null;
  error?: { kind?: string; message?: string } | null;
  started_at?: string;
  finished_at?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
  messages?: Array<{ role: string; content?: unknown; tool_calls?: Array<{ id?: unknown; name?: unknown }> }>;
}

/** Ids the Gemini adapter makes up when the API sends none (@invariant/providers GENERATED_ID_PREFIX): not provider ids, never exported as one. */
const GENERATED_ID_PREFIX = "invariant-generated:";

function readRaw(store: TraceStore, run: RunRow): RawTrace | null {
  if (!run.trace_blob_ref) return null;
  try {
    const raw = store.readRawTrace(run.trace_blob_ref);
    return raw && typeof raw === "object" ? (raw as RawTrace) : null;
  } catch {
    return null;
  }
}

/** tool_use ids in the order the agent issued them, if they line up one-to-one with the recorded calls. */
function toolUseIds(raw: RawTrace | null, calls: ToolCallRow[]): Array<string | undefined> {
  const uses: Array<{ id: string; name: string }> = [];
  for (const m of raw?.messages ?? []) {
    if (m.role !== "assistant") continue;
    if (Array.isArray(m.tool_calls)) {
      // Provider-neutral transcript (current driver): calls in the order the model listed them.
      for (const c of m.tool_calls) if (typeof c.id === "string" && typeof c.name === "string") uses.push({ id: c.id, name: c.name });
    } else if (Array.isArray(m.content)) {
      // Older blobs: Anthropic content blocks.
      for (const b of m.content as Array<Record<string, unknown>>) {
        if (b.type === "tool_use" && typeof b.id === "string" && typeof b.name === "string") uses.push({ id: b.id, name: b.name });
      }
    }
  }
  const aligned = uses.length === calls.length && uses.every((u, i) => u.name === calls[i]!.tool_name);
  return calls.map((_, i) => (aligned && !uses[i]!.id.startsWith(GENERATED_ID_PREFIX) ? uses[i]!.id : undefined));
}

const ms = (iso: string) => new Date(iso);

export function planBatchTrace(store: TraceStore, batchId: string, options: PlanOptions = {}): TracePlan {
  const max = options.maxValueLength ?? 4096;
  const batch = store.getBatch(batchId);
  if (!batch) throw new Error(`no batch with id ${batchId} in the trace store.`);
  const task = store.getTask(batch.task_id);
  if (!task) throw new Error(`batch ${batchId} references task ${batch.task_id}, which is not in the store.`);
  const traceId = traceIdForBatch(batch.id);
  const deployment = store.getBatchDeployment(batch.id);
  const syntheticHashes = new Set(deployment.fingerprints.filter((f) => f.synthetic).map((f) => f.hash));

  const counts = { runs: 0, tool_calls: 0, sandboxed_tool_calls: 0 };
  const runs = store.getBatchRuns(batch.id, { includeSuperseded: true });
  const runSpans: PlannedSpan[] = runs.map((run) => {
    counts.runs++;
    const variant = store.getVariant(run.variant_id);
    const raw = readRaw(store, run);
    const calls = store.getToolCalls(run.id);
    const ids = toolUseIds(raw, calls);

    let start: Date;
    let end: Date;
    let timing: string;
    if (raw?.started_at && raw.finished_at) {
      start = ms(raw.started_at);
      end = ms(raw.finished_at);
      timing = "raw_trace";
    } else {
      start = ms(run.created_at);
      const lastCall = calls.length ? ms(calls[calls.length - 1]!.timestamp).getTime() : start.getTime();
      end = new Date(run.latency_ms !== null ? start.getTime() + run.latency_ms : lastCall);
      timing = run.latency_ms !== null ? "created_at_plus_latency" : "unfinished";
    }

    const runSpanId = spanIdFor(`run:${run.id}`);
    const toolSpans: PlannedSpan[] = calls.map((call, i) => {
      counts.tool_calls++;
      if (call.is_sandboxed) counts.sandboxed_tool_calls++;
      const at = ms(call.timestamp);
      const attributes: Record<string, AttrValue> = {
        [GEN_AI.OPERATION_NAME]: GEN_AI.OP_EXECUTE_TOOL,
        [GEN_AI.TOOL_NAME]: call.tool_name,
        [GEN_AI.TOOL_TYPE]: "function",
        [GEN_AI.TOOL_CALL_ARGUMENTS]: jsonString(call.args, max),
        [GEN_AI.TOOL_CALL_RESULT]: jsonString(call.response, max),
        [INV.RUN_ID]: run.id,
        [INV.TASK]: task.name,
        [INV.TOOL_NAME]: call.tool_name,
        [INV.TOOL_SANDBOXED]: call.is_sandboxed,
        [INV.TOOL_SEQUENCE]: call.sequence_index,
        [INV.TOOL_TIMING]: "start_only",
      };
      if (ids[i]) attributes[GEN_AI.TOOL_CALL_ID] = ids[i]!;
      return {
        name: `${GEN_AI.OP_EXECUTE_TOOL} ${call.tool_name}`,
        spanId: spanIdFor(`tool:${run.id}:${call.sequence_index}`),
        start: at,
        end: at,
        attributes,
        events: [],
        children: [],
      };
    });

    const synthetic = run.deployment_fingerprint !== null && syntheticHashes.has(run.deployment_fingerprint);
    const responseModel = raw?.model_versions_seen?.[0];
    const attributes: Record<string, AttrValue> = {
      [GEN_AI.OPERATION_NAME]: GEN_AI.OP_INVOKE_AGENT,
      [INV.RUN_ID]: run.id,
      [INV.TASK]: task.name,
      [INV.VARIANT_ID]: run.variant_id,
      [INV.VARIANT_LABEL]: variant?.label ?? "?",
      [INV.TRIAL]: run.trial_number,
      [INV.ATTEMPT]: run.attempt,
      [INV.SUPERSEDED]: run.superseded,
      [INV.RUN_STATUS]: run.status,
      [INV.TIMING_SOURCE]: timing,
      [INV.BATCH_ID]: batch.id,
    };
    if (run.deployment_fingerprint) attributes[INV.DEPLOYMENT_FINGERPRINT] = run.deployment_fingerprint;
    if (synthetic) attributes[INV.SYNTHETIC] = true;
    // A scripted stand-in never talked to a provider, so no provider is claimed for it. The
    // provider comes from the raw trace, else the run's fingerprint; a raw trace written
    // before the driver was provider-neutral (a model, no provider field) was Anthropic, the
    // only provider that driver could call.
    else {
      const fpProvider = run.deployment_fingerprint ? store.getDeploymentFingerprint(run.deployment_fingerprint)?.provider : null;
      const provider = raw?.provider ?? fpProvider ?? (raw?.model && raw.provider === undefined ? GEN_AI.PROVIDER_ANTHROPIC : undefined);
      if (provider && provider !== "scripted") attributes[GEN_AI.PROVIDER_NAME] = provider;
    }
    if (raw?.model) attributes[GEN_AI.REQUEST_MODEL] = raw.model;
    if (responseModel) attributes[GEN_AI.RESPONSE_MODEL] = responseModel;
    if (typeof raw?.usage?.input_tokens === "number") attributes[GEN_AI.USAGE_INPUT_TOKENS] = raw.usage.input_tokens;
    if (typeof raw?.usage?.output_tokens === "number") attributes[GEN_AI.USAGE_OUTPUT_TOKENS] = raw.usage.output_tokens;
    if (raw?.stop_reason) attributes[INV.STOP_REASON] = raw.stop_reason;
    if (run.latency_ms !== null) attributes[INV.LATENCY_MS] = run.latency_ms;
    if (variant) attributes[INV.PROMPT] = truncate(variant.phrasing_text, max);
    if (run.final_output !== null) attributes[INV.FINAL_OUTPUT] = truncate(run.final_output, max);

    let error: string | undefined;
    if (run.status === "infra_error") {
      attributes[ERROR_TYPE] = raw?.error?.kind ?? "infra_error";
      error = raw?.error?.message ?? "run ended without a behavioural answer (infra_error)";
    }

    return {
      name: GEN_AI.OP_INVOKE_AGENT,
      spanId: runSpanId,
      start,
      end: end.getTime() < start.getTime() ? start : end,
      attributes,
      events: [],
      error,
      children: toolSpans,
    };
  });

  // Batch timing: as recorded, widened only if a run somehow falls outside it.
  const created = ms(batch.created_at).getTime();
  const runStart = Math.min(created, ...runSpans.map((s) => s.start.getTime()));
  const runEnd = Math.max(runStart, ...runSpans.map((s) => s.end.getTime()));
  const batchEnd = batch.finished_at ? Math.max(ms(batch.finished_at).getTime(), runEnd) : runEnd;

  const matrix = runs.filter((r) => !r.superseded).length;
  const fingerprints = deployment.fingerprints.map((f) => f.hash);
  const attributes: Record<string, AttrValue> = {
    [INV.BATCH_ID]: batch.id,
    [INV.TASK]: task.name,
    [INV.TIER]: batch.tier,
    [INV.TRIALS_PER_VARIANT]: batch.trials_per_variant,
    [INV.VARIANTS]: batch.variant_labels,
    [INV.VARIANTS_REQUESTED]: batch.variants_requested,
    [INV.RUNS_IN_MATRIX]: matrix,
    [INV.RUNS_EXPORTED]: runs.length,
    [INV.DEPLOYMENT_MIXED]: deployment.mixed,
  };
  // The most common fingerprint; all of them when the deployment changed mid-batch.
  if (fingerprints[0]) attributes[INV.DEPLOYMENT_FINGERPRINT] = fingerprints[0];
  if (fingerprints.length) attributes[INV.DEPLOYMENT_FINGERPRINTS] = fingerprints;
  if (deployment.fingerprints.some((f) => f.synthetic)) attributes[INV.SYNTHETIC] = true;

  const events: PlannedEvent[] = [];
  const score = store.getScores(batch.id)[0] ?? null;
  let scoreSummary: TracePlan["score"] = null;
  const thresholds =
    options.thresholds ??
    (parseThresholds(task.thresholds) ? { thresholds: parseThresholds(task.thresholds)!, source: "copy stored with the task" } : null);

  if (!score) {
    attributes[INV.SCORE_STATUS] = "not_scored";
  } else {
    attributes[INV.SCORE_STATUS] = "scored";
    attributes[INV.SCORE_ID] = score.id;
    attributes[INV.SCORE_COMPUTED_AT] = score.computed_at;
    attributes[INV.RUNS_SCORED] = score.runs_scored;
    const details = (score.details && typeof score.details === "object" ? score.details : {}) as Record<string, unknown>;
    const value: Record<AxisName, number | null> = {
      state_mutation: score.state_mutation_consistency,
      tool_path: score.tool_path_consistency,
      outcome: score.outcome_consistency,
    };
    for (const axis of AXES) if (value[axis] !== null) attributes[INV.axis(axis)] = value[axis]!;

    let verdict = "no_thresholds";
    if (thresholds) {
      const axisInput = (axis: AxisName) => ({
        score: value[axis],
        threshold: 0,
        verdict: "n/a" as const,
        error: (details[axis] as { error?: string } | undefined)?.error,
      });
      const gate = evaluateGate(
        {
          state_mutation: axisInput("state_mutation"),
          tool_path: axisInput("tool_path"),
          outcome: axisInput("outcome"),
          runs_scored: score.runs_scored,
          runs_in_batch: typeof details.runs_in_batch === "number" ? details.runs_in_batch : score.runs_scored,
        },
        thresholds.thresholds
      );
      verdict = gate.verdict;
      attributes[INV.GATE_VERDICT] = gate.verdict;
      attributes[INV.THRESHOLDS_SOURCE] = thresholds.source;
      for (const a of gate.axes) {
        attributes[INV.axisThreshold(a.axis)] = a.threshold;
        attributes[INV.axisResult(a.axis)] = a.result;
        const ev: Record<string, AttrValue> = {
          [GEN_AI.EVALUATION_NAME]: INV.axis(a.axis),
          [GEN_AI.EVALUATION_SCORE_LABEL]: a.result,
          [GEN_AI.EVALUATION_EXPLANATION]:
            a.score === null ? (a.reason ?? "no score") : `${a.score.toFixed(3)} ${a.result === "pass" ? ">=" : "<"} threshold ${a.threshold}`,
          [INV.axisThreshold(a.axis)]: a.threshold,
          [INV.SCORE_ID]: score.id,
        };
        if (a.score !== null) ev[GEN_AI.EVALUATION_SCORE_VALUE] = a.score;
        events.push({ name: GEN_AI.EVALUATION_RESULT_EVENT, time: ms(score.computed_at), attributes: ev });
      }
    }
    scoreSummary = { id: score.id, computed_at: score.computed_at, verdict };
  }

  return {
    traceId,
    batchId: batch.id,
    task: task.name,
    root: {
      name: "invariant.batch",
      spanId: spanIdFor(`batch:${batch.id}`),
      start: new Date(runStart),
      end: new Date(batchEnd),
      attributes,
      events,
      children: runSpans,
    },
    counts,
    score: scoreSummary,
  };
}
