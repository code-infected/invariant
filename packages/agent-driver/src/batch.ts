import type { BatchKind, Tier } from "@invariant/trace-store";
import { runTrial as realRunTrial, type TrialDeps, type TrialPlan, type TrialResult } from "./run-trial.js";
import { runWithConcurrency } from "./pool.js";
import { backoffDelayMs, isRetryableInfraFailure, type RetryPolicy } from "./retry.js";

export interface BatchVariant {
  variant_id: string;
  variant_label: string;
  prompt_text: string;
}

/** The per-trial fields that are identical across every cell of a batch. */
export type TrialTemplate = Omit<
  TrialPlan,
  "task_id" | "task_name" | "variant_id" | "variant_label" | "prompt_text" | "trial_number" | "batch_id" | "attempt"
>;

/**
 * One fan-out, fully resolved: which variants, how many trials of each, and how to run
 * them. Like TrialPlan, this is built by the caller (the CLI) from the task spec, so the
 * driver never needs to know the YAML format or how a tier maps to counts.
 */
export interface BatchPlan {
  task_id: string;
  task_name: string;
  tier: Tier;
  /** Variants to run, in fixture order. */
  variants: BatchVariant[];
  /** What the tier asked for; recorded so a short fixture stays visible. */
  variants_requested: number;
  trials: number;
  trial: TrialTemplate;
  concurrency: number;
  retry: RetryPolicy;
  /** Defaults to "consistency". "adversarial" batches carry trial.injection. */
  kind?: BatchKind;
  /** Adversarial batches: the payload's id and a snapshot of it, stored on the batch. */
  payload_id?: string;
  adversarial_payload?: unknown;
}

export type BatchEvent =
  | {
      type: "retrying";
      cell: CellRef;
      failed_attempt: number;
      next_attempt: number;
      delay_ms: number;
      reason: string;
    }
  | { type: "cell_done"; cell: CellResult; done: number; total: number };

export interface BatchDeps extends TrialDeps {
  /** Progress events. Defaults to nothing; the CLI renders them. */
  onEvent?: (event: BatchEvent) => void;
  /** Test seams: the trial runner, the backoff sleep, and the jitter source. */
  runTrial?: (plan: TrialPlan, deps: TrialDeps) => Promise<TrialResult>;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

export interface CellRef {
  variant_label: string;
  variant_id: string;
  trial_number: number;
}

/**
 * How a (variant, trial) cell ended.
 *
 *   completed        the agent gave a behavioural answer (run status ok or timeout). This
 *                    is the only outcome that belongs to the consistency matrix, and it
 *                    counts on the first attempt that produces it, full stop.
 *   infra_exhausted  every attempt failed with a retryable provider error. The final run
 *                    row is infra_error: there is no behavioural answer for this cell.
 *   error            a failure that is not retried: the provider rejecting the request
 *                    (400/401/404), a transient provider status not on retry_on, a
 *                    harness error, or the trial runner itself throwing. Also no answer.
 */
export type CellOutcome = "completed" | "infra_exhausted" | "error";

export interface AttemptRecord {
  attempt: number;
  run_id: string;
  status: TrialResult["status"];
  stop_reason: TrialResult["stop_reason"];
  error?: TrialResult["error"];
  tokens: number;
}

export interface CellResult extends CellRef {
  outcome: CellOutcome;
  /** The attempt that counts (the last one). Absent only if the trial runner threw. */
  final?: TrialResult;
  attempts: AttemptRecord[];
  /** Set when the trial runner threw instead of returning a result. */
  crash?: string;
}

export interface BatchCounts {
  cells: number;
  completed: number;
  ok: number;
  timeout: number;
  infra_exhausted: number;
  errors: number;
  /** Attempts that failed with a retryable infra error and were retried. */
  retried_attempts: number;
  /** Cells that needed at least one retry and then completed. */
  recovered_after_retry: number;
}

export interface BatchSummary {
  batch_id: string;
  task_name: string;
  tier: Tier;
  trials: number;
  variants_run: string[];
  variants_requested: number;
  concurrency: number;
  cells: CellResult[];
  counts: BatchCounts;
  wall_ms: number;
  /** Tokens across every attempt, retried ones included: they were spent either way. */
  total_tokens: number;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Run every (variant x trial) cell of a batch, at most `plan.concurrency` at a time.
 *
 * Each attempt is a normal runTrial call and so a normal, complete run row in the trace
 * store. When an attempt is a retryable infra failure it is flagged superseded and the
 * cell is tried again after a backoff, up to retry.max_attempts; the superseded row and
 * its tool calls stay in the store as evidence but drop out of the matrix, which is
 * "runs where batch_id = ? and superseded = 0" (TraceStore.getBatchRuns).
 */
export async function runBatch(plan: BatchPlan, deps: BatchDeps): Promise<BatchSummary> {
  if (plan.variants.length === 0) throw new Error(`batch for ${plan.task_name} has no variants to run`);
  // A planted instruction in a consistency batch would silently contaminate its scores, and
  // an adversarial batch without one would measure nothing: refuse both.
  const adversarial = (plan.kind ?? "consistency") === "adversarial";
  if (adversarial !== (plan.trial.injection !== undefined)) {
    throw new Error(
      adversarial
        ? `adversarial batch for ${plan.task_name} has no injection configured`
        : `consistency batch for ${plan.task_name} must not carry an injection; use kind "adversarial"`
    );
  }
  if (adversarial && plan.payload_id !== plan.trial.injection!.payload_id) {
    throw new Error(`adversarial batch payload_id (${plan.payload_id}) does not match its injection's (${plan.trial.injection!.payload_id})`);
  }
  if (!Number.isInteger(plan.trials) || plan.trials < 1) {
    throw new Error(`batch for ${plan.task_name} needs a positive trial count, got ${plan.trials}`);
  }
  if (!Number.isInteger(plan.retry.max_attempts) || plan.retry.max_attempts < 1) {
    throw new Error(`retry.max_attempts must be a positive integer, got ${plan.retry.max_attempts}`);
  }

  const run = deps.runTrial ?? realRunTrial;
  const sleep = deps.sleep ?? defaultSleep;
  const emit = deps.onEvent ?? (() => undefined);
  const { store } = deps;
  const trialDeps: TrialDeps = { store, log: deps.log, callModel: deps.callModel };

  const batchId = store.createBatch({
    task_id: plan.task_id,
    tier: plan.tier,
    trials_per_variant: plan.trials,
    variants_requested: plan.variants_requested,
    variant_labels: plan.variants.map((v) => v.variant_label),
    kind: plan.kind ?? "consistency",
    payload_id: plan.payload_id ?? null,
    adversarial_payload: plan.adversarial_payload,
  });

  // Trial-major order: every variant gets its trial 1 before any gets trial 2, so the
  // matrix fills evenly and an interrupted batch still covers every phrasing.
  const cells: Array<CellRef & { variant: BatchVariant }> = [];
  for (let trial = 1; trial <= plan.trials; trial++) {
    for (const variant of plan.variants) {
      cells.push({ variant, variant_label: variant.variant_label, variant_id: variant.variant_id, trial_number: trial });
    }
  }

  const startedAt = Date.now();
  let done = 0;

  async function runCell(cell: (typeof cells)[number]): Promise<CellResult> {
    const ref: CellRef = { variant_label: cell.variant_label, variant_id: cell.variant_id, trial_number: cell.trial_number };
    const attempts: AttemptRecord[] = [];
    let final: TrialResult | undefined;
    let outcome: CellOutcome = "error";
    let crash: string | undefined;

    for (let attempt = 1; attempt <= plan.retry.max_attempts; attempt++) {
      let result: TrialResult;
      try {
        result = await run(
          {
            ...plan.trial,
            task_id: plan.task_id,
            task_name: plan.task_name,
            variant_id: cell.variant_id,
            variant_label: cell.variant_label,
            prompt_text: cell.variant.prompt_text,
            trial_number: cell.trial_number,
            batch_id: batchId,
            attempt,
          },
          trialDeps
        );
      } catch (err) {
        // runTrial records its own failures; a throw means the harness itself broke
        // (store unwritable, proxy config unwritable). Record it against the cell and let
        // the rest of the batch carry on rather than losing every other cell's result.
        crash = err instanceof Error ? err.message : String(err);
        outcome = "error";
        break;
      }

      final = result;
      attempts.push({
        attempt,
        run_id: result.run_id,
        status: result.status,
        stop_reason: result.stop_reason,
        error: result.error,
        tokens: result.record.run.token_cost ?? 0,
      });

      if (result.status === "ok" || result.status === "timeout") {
        outcome = "completed";
        break;
      }
      if (!isRetryableInfraFailure(result, plan.retry)) {
        outcome = "error";
        break;
      }
      if (attempt === plan.retry.max_attempts) {
        outcome = "infra_exhausted";
        break;
      }

      store.markSuperseded(result.run_id);
      const delay = backoffDelayMs(attempt + 1, result.error?.retry_after_ms, deps.random);
      emit({
        type: "retrying",
        cell: ref,
        failed_attempt: attempt,
        next_attempt: attempt + 1,
        delay_ms: delay,
        reason: result.error?.message ?? "infra error",
      });
      await sleep(delay);
    }

    const cellResult: CellResult = { ...ref, outcome, final, attempts, crash };
    emit({ type: "cell_done", cell: cellResult, done: ++done, total: cells.length });
    return cellResult;
  }

  let results: CellResult[];
  try {
    results = await runWithConcurrency(cells, plan.concurrency, runCell);
  } finally {
    store.finishBatch(batchId);
  }

  return {
    batch_id: batchId,
    task_name: plan.task_name,
    tier: plan.tier,
    trials: plan.trials,
    variants_run: plan.variants.map((v) => v.variant_label),
    variants_requested: plan.variants_requested,
    concurrency: plan.concurrency,
    cells: results,
    counts: countCells(results),
    wall_ms: Date.now() - startedAt,
    total_tokens: results.reduce((sum, c) => sum + c.attempts.reduce((s, a) => s + a.tokens, 0), 0),
  };
}

export function countCells(cells: CellResult[]): BatchCounts {
  const counts: BatchCounts = {
    cells: cells.length,
    completed: 0,
    ok: 0,
    timeout: 0,
    infra_exhausted: 0,
    errors: 0,
    retried_attempts: 0,
    recovered_after_retry: 0,
  };
  for (const cell of cells) {
    // Every attempt before the last one was, by construction, a retried infra failure.
    const retried = Math.max(0, cell.attempts.length - 1);
    counts.retried_attempts += retried;
    if (cell.outcome === "completed") {
      counts.completed++;
      if (cell.final?.status === "ok") counts.ok++;
      else counts.timeout++;
      if (retried > 0) counts.recovered_after_retry++;
    } else if (cell.outcome === "infra_exhausted") {
      counts.infra_exhausted++;
    } else {
      counts.errors++;
    }
  }
  return counts;
}
