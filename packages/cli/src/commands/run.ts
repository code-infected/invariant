import path from "node:path";
import { openTraceStore, type TraceStore } from "@invariant/trace-store";
import {
  requireApiKey,
  runBatch,
  runTrial,
  type BatchEvent,
  type BatchSummary,
  type TrialPlan,
} from "@invariant/agent-driver";
import { loadConfig } from "../lib/config.js";
import { loadAllTasks, loadValidTask, type LoadedTask } from "../lib/load-tasks.js";
import { INVARIANT_DIR, REPO_ROOT } from "../lib/paths.js";
import { selectTier, type Tier } from "../lib/tier.js";
import { planForExport, sendPlans } from "./export.js";
import { describeGap, describeUpstream, requireUpstream, toolCoverage } from "../lib/upstream.js";

export interface RunOptions {
  /** Required with --variant; with a tier, omitted means every task under tasks/. */
  task?: string;
  /** Single-trial debugging mode: run exactly this variant once, no retries. */
  variant?: string;
  /** Fan-out mode. Defaults to execution.default_tier from invariant.config.yaml. */
  tier?: Tier;
  /** Only meaningful with --variant. */
  trial?: number;
  /** Overrides execution.worker_concurrency. */
  concurrency?: number;
  model?: string;
  /**
   * Tier runs only: skip (and name) tasks with no registered tool server, or whose server
   * does not serve their declared tools, instead of refusing the whole run. `gate` reports
   * the skipped tasks as not gated.
   */
  runnableOnly?: boolean;
  /**
   * Tier runs only: export each finished batch as an OpenTelemetry trace afterwards (same
   * as `invariant export --batch=<id>`). A batch is not scored yet at this point, so its
   * trace carries no axis results; export again after `invariant score` to include them.
   */
  otel?: boolean;
  /** OTLP endpoint for --otel; see `invariant export`. */
  otelEndpoint?: string;
  json: boolean;
}

export async function runRun(opts: RunOptions): Promise<void> {
  if (opts.variant !== undefined) {
    if (opts.tier !== undefined) throw new Error("--variant runs one trial and --tier runs a fan-out; pass one, not both.");
    if (opts.concurrency !== undefined) throw new Error("--concurrency only applies to a tier run, not a single --variant trial.");
    if (opts.task === undefined) throw new Error("--variant needs --task.");
    if (opts.runnableOnly) throw new Error("--runnable-only applies to a tier run, not a single --variant trial.");
    if (opts.otel) throw new Error("--otel exports a tier run's batches; a single --variant trial has no batch to export.");
    return runSingle(opts.task, opts.variant, opts.trial ?? 1, opts);
  }
  if (opts.trial !== undefined) throw new Error("--trial only applies with --variant; a tier run numbers its own trials.");
  return runTier(opts);
}


/**
 * Refuse to run tasks that have no registered tool server, or whose server does not serve
 * every tool the task declares (see toolCoverage). Checked once, before any model call.
 * With `skipUnrunnable`, those tasks are dropped with a notice instead, and only an empty
 * remainder is an error.
 */
async function preflightTools(tasks: LoadedTask[], options: { skipUnrunnable?: boolean } = {}): Promise<LoadedTask[]> {
  const gaps = await toolCoverage(tasks);
  if (gaps.size === 0) return tasks;
  const problems = [...gaps].map(([name, gap]) => `${name}: ${describeGap(gap)}`);
  if (options.skipUnrunnable) {
    const runnable = tasks.filter((t) => !gaps.has(t.spec.name));
    for (const p of problems) console.error(`skipping ${p} (--runnable-only); it will not be run or gated`);
    if (runnable.length === 0) throw new Error(`--runnable-only: no task left to run.`);
    return runnable;
  }
  throw new Error(
    `refusing to run: not every task has a tool server that serves the tools it declares:\n` +
      problems.map((p) => `  - ${p}`).join("\n") +
      `\nThe agent would be given the wrong tools and its traces would measure nothing. ` +
      `Pass --runnable-only to run the rest and skip these.`
  );
}

/** Upsert the task and the given fixture variants; returns the task id and label -> variant id. */
export function syncTask(
  store: TraceStore,
  task: LoadedTask,
  variants: Array<{ id: string; text: string }>
): { taskId: string; variantIds: Map<string, string> } {
  const fixture = task.fixture!;
  const taskId = store.upsertTask({
    name: task.spec.name,
    prompt_template: task.spec.prompt_template,
    success_rubric: task.spec.success_rubric,
    dangerous_tools: task.spec.tools.dangerous,
    volatile_fields: task.spec.volatile_fields,
    thresholds: task.spec.thresholds,
  });
  const variantIds = new Map<string, string>();
  for (const variant of variants) {
    variantIds.set(
      variant.id,
      store.upsertVariant({
        task_id: taskId,
        label: variant.id,
        phrasing_text: variant.text,
        fixture_version: fixture.fixture_version,
        approved_by: fixture.approved_by,
        generated_at: fixture.generated_at,
      })
    );
  }
  return { taskId, variantIds };
}

/**
 * One trial of one variant, no retries. For debugging a specific case: a provider 429
 * here is shown as-is instead of being absorbed by the retry policy.
 */
async function runSingle(taskName: string, variantLabel: string, trial: number, opts: RunOptions): Promise<void> {
  // Fail before touching the trace store, so a missing key does not leave a half-open run.
  requireApiKey();

  const task = loadValidTask(taskName);
  const fixture = task.fixture!;
  const variant = fixture.variants.find((v) => v.id === variantLabel);
  if (!variant) {
    throw new Error(
      `no variant "${variantLabel}" in tasks/${taskName}.variants.json. ` +
        `Available: ${fixture.variants.map((v) => v.id).join(", ")}`
    );
  }
  await preflightTools([task]);
  const { server, upstream } = requireUpstream(task.spec.name);

  const store = openTraceStore({ root: INVARIANT_DIR });
  try {
    const { taskId, variantIds } = syncTask(store, task, [variant]);

    const plan: TrialPlan = {
      task_id: taskId,
      task_name: task.spec.name,
      variant_id: variantIds.get(variant.id)!,
      variant_label: variant.id,
      prompt_text: variant.text,
      trial_number: trial,
      dangerous_tools: task.spec.tools.dangerous,
      upstream,
      max_wall_clock_seconds: task.spec.execution.max_wall_clock_seconds,
      model: opts.model,
    };

    console.log(`Running ${task.spec.name} / variant ${variant.id} / trial ${trial}`);
    console.log(`  tools : ${server} (${describeUpstream(upstream)})`);
    console.log(`  prompt: ${variant.text}`);
    console.log("");

    const result = await runTrial(plan, { store, log: (m) => console.error(m) });

    if (opts.json) {
      console.log(JSON.stringify(result.record, null, 2));
    } else {
      printRecord(result.record.run.id, result);
    }
    console.log("");
    console.log(`  trace record : ${path.relative(REPO_ROOT, store.dbPath)} (run ${result.run_id})`);
    console.log(`  raw trace    : ${path.relative(REPO_ROOT, store.resolveTraceRef(result.raw_trace_ref))}`);

    if (result.status !== "ok") {
      process.exitCode = 1;
    }
  } finally {
    store.close();
  }
}

/**
 * Fan out a tier: for each task, every selected variant x every trial, bounded by the
 * worker concurrency, with infra failures retried per invariant.config.yaml.
 *
 * Exit code is nonzero only when the run matrix is incomplete (a cell ended with no
 * behavioural answer). Whether the answers that did come back are consistent is the
 * scoring engine's and the gate's call, not this command's.
 */
async function runTier(opts: RunOptions): Promise<void> {
  requireApiKey();
  const config = loadConfig();
  const tier = opts.tier ?? config.execution.default_tier;
  const concurrency = opts.concurrency ?? config.execution.worker_concurrency;
  const retry = config.providers.retry;

  const requested = opts.task !== undefined ? [loadValidTask(opts.task)] : loadAllTasks().map((t) => loadValidTask(t.name));
  if (requested.length === 0) throw new Error("no task specs under tasks/, nothing to run.");

  const tasks = await preflightTools(requested, { skipUnrunnable: opts.runnableOnly });

  const store = openTraceStore({ root: INVARIANT_DIR });
  const summaries: BatchSummary[] = [];
  try {
    for (const task of tasks) {
      const selection = selectTier(task.spec, task.fixture!, tier);
      const { server, upstream } = requireUpstream(task.spec.name);
      const { taskId, variantIds } = syncTask(store, task, selection.variants);

      console.error(
        `${task.spec.name}: ${tier} tier, ${selection.variants.length} variant(s) x ${selection.trials} trial(s) = ` +
          `${selection.variants.length * selection.trials} runs, concurrency ${concurrency}, ` +
          `up to ${retry.max_attempts} attempt(s) per run on [${retry.retry_on.join(", ")}], tool server ${server}`
      );
      if (selection.shortfall > 0) {
        console.error(
          `  warning: the ${tier} tier asks for ${selection.variants_requested} variants but ` +
            `tasks/${task.spec.name}.variants.json has ${task.fixture!.variants.length}; running all of them, ` +
            `not padding with repeats. Add variants with: invariant variants regen --task=${task.spec.name}`
        );
      }

      const summary = await runBatch(
        {
          task_id: taskId,
          task_name: task.spec.name,
          tier,
          variants: selection.variants.map((v) => ({
            variant_id: variantIds.get(v.id)!,
            variant_label: v.id,
            prompt_text: v.text,
          })),
          variants_requested: selection.variants_requested,
          trials: selection.trials,
          trial: {
            dangerous_tools: task.spec.tools.dangerous,
            upstream,
            max_wall_clock_seconds: task.spec.execution.max_wall_clock_seconds,
            model: opts.model,
          },
          concurrency,
          retry,
        },
        { store, onEvent: printEvent }
      );
      summaries.push(summary);
    }
  } finally {
    store.close();
  }

  if (opts.json) {
    console.log(JSON.stringify(summaries.map(summaryJson), null, 2));
  } else {
    for (const summary of summaries) printSummary(summary);
    if (summaries.length > 1) printTotals(summaries);
    console.log(`  trace store  : ${path.relative(REPO_ROOT, path.join(INVARIANT_DIR, "trace.db"))}`);
  }

  if (summaries.some((s) => s.counts.infra_exhausted + s.counts.errors > 0)) {
    process.exitCode = 1;
  }

  if (opts.otel && summaries.length > 0) {
    try {
      const reader = openTraceStore({ root: INVARIANT_DIR, readonly: true });
      let plans;
      try {
        plans = summaries.map((s) => planForExport(reader, reader.getBatch(s.batch_id)!));
      } finally {
        reader.close();
      }
      const sent = await sendPlans(plans, { endpoint: opts.otelEndpoint }, {});
      for (const p of plans) console.error(`exported batch ${p.batchId} as trace ${p.traceId} to ${sent.url} (unscored: run invariant score, then invariant export, to add axis results)`);
    } catch (err) {
      console.error(`--otel: export failed: ${(err as Error).message}`);
      process.exitCode = 1;
    }
  }
}

function truncate(text: string, max = 140): string {
  const flat = text.replace(/\s+/g, " ");
  return flat.length <= max ? flat : flat.slice(0, max - 1) + "\u2026";
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

function duration(ms: number): string {
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  return m > 0 ? `${m}m ${total % 60}s` : `${total}s`;
}

/** Progress goes to stderr so stdout stays the summary (or clean JSON with --json). */
function printEvent(event: BatchEvent): void {
  if (event.type === "retrying") {
    const c = event.cell;
    console.error(
      `        ${c.variant_label} trial ${c.trial_number}: attempt ${event.failed_attempt} hit an infra error, ` +
        `retrying in ${seconds(event.delay_ms)} (${truncate(event.reason, 100)})`
    );
    return;
  }
  const { cell, done, total } = event;
  const width = String(total).length;
  const prefix = `  [${String(done).padStart(width)}/${total}] ${cell.variant_label} trial ${cell.trial_number}:`;
  const retries = cell.attempts.length > 1 ? `, after ${cell.attempts.length - 1} infra retr${cell.attempts.length === 2 ? "y" : "ies"}` : "";
  if (cell.crash !== undefined) {
    console.error(`${prefix} harness crashed: ${truncate(cell.crash)}`);
    return;
  }
  const final = cell.final!;
  const run = final.record.run;
  if (cell.outcome === "completed") {
    console.error(
      `${prefix} ${final.status} (${final.stop_reason}), ${final.record.tool_calls.length} tool call(s), ` +
        `${run.token_cost ?? 0} tok, ${seconds(run.latency_ms ?? 0)}${retries}`
    );
  } else if (cell.outcome === "infra_exhausted") {
    console.error(`${prefix} INFRA FAILURE, ${cell.attempts.length} attempts exhausted: ${truncate(final.error?.message ?? "")}`);
  } else {
    const label =
      final.error?.kind === "provider_rejected"
        ? `provider rejected the request (${final.error.http_status})`
        : final.error?.kind === "provider"
          ? `provider error ${final.error.http_status ?? "(no response)"} not on retry_on`
          : "harness error";
    console.error(`${prefix} ERROR, not retried, ${label}: ${truncate(final.error?.message ?? "", 110)}`);
  }
}

function printSummary(s: BatchSummary): void {
  const c = s.counts;
  console.log("");
  console.log(`${s.task_name}  (${s.tier} tier, batch ${s.batch_id})`);
  const short =
    s.variants_run.length < s.variants_requested
      ? `  [tier asks for ${s.variants_requested} variants, fixture has ${s.variants_run.length}]`
      : "";
  console.log(
    `  matrix       : ${s.variants_run.length} variants [${s.variants_run.join(", ")}] x ${s.trials} trials = ${c.cells} runs${short}`
  );
  console.log(`  completed    : ${c.completed}  (ok ${c.ok}, timeout ${c.timeout})`);
  console.log(`  infra retries: ${c.retried_attempts} attempt(s) retried, ${c.recovered_after_retry} run(s) recovered`);
  console.log(`  infra failed : ${c.infra_exhausted}  (retries exhausted, no behavioural answer)`);
  console.log(`  other errors : ${c.errors}  (not retried: provider rejected the request, status not on retry_on, or harness error)`);
  console.log(`  wall time    : ${duration(s.wall_ms)}  (concurrency ${s.concurrency})`);
  console.log(`  tokens       : ${s.total_tokens}  (input + output, every attempt incl. retried ones)`);
}

function printTotals(summaries: BatchSummary[]): void {
  const sum = (f: (s: BatchSummary) => number) => summaries.reduce((acc, s) => acc + f(s), 0);
  console.log("");
  console.log(`All tasks (${summaries.length})`);
  console.log(`  runs         : ${sum((s) => s.counts.cells)}, completed ${sum((s) => s.counts.completed)}`);
  console.log(`  infra retries: ${sum((s) => s.counts.retried_attempts)} attempt(s)`);
  console.log(`  infra failed : ${sum((s) => s.counts.infra_exhausted)}, other errors ${sum((s) => s.counts.errors)}`);
  console.log(`  wall time    : ${duration(sum((s) => s.wall_ms))}`);
  console.log(`  tokens       : ${sum((s) => s.total_tokens)}`);
}

/** The summary without full trace records: those are in the store, keyed by run_id. */
function summaryJson(s: BatchSummary): unknown {
  return {
    batch_id: s.batch_id,
    task: s.task_name,
    tier: s.tier,
    trials: s.trials,
    variants_run: s.variants_run,
    variants_requested: s.variants_requested,
    concurrency: s.concurrency,
    counts: s.counts,
    wall_ms: s.wall_ms,
    total_tokens: s.total_tokens,
    cells: s.cells.map((c) => ({
      variant: c.variant_label,
      trial: c.trial_number,
      outcome: c.outcome,
      run_id: c.final?.run_id ?? null,
      status: c.final?.status ?? null,
      stop_reason: c.final?.stop_reason ?? null,
      crash: c.crash ?? null,
      attempts: c.attempts,
    })),
  };
}

function printRecord(runId: string, result: Awaited<ReturnType<typeof runTrial>>): void {
  const { record } = result;
  console.log(`Run ${runId}`);
  console.log(`  status       : ${result.status} (${result.stop_reason})`);
  if (result.error) console.log(`  error        : [${result.error.kind}] ${result.error.message}`);
  console.log(`  latency      : ${record.run.latency_ms} ms`);
  console.log(`  tokens       : ${record.run.token_cost}`);
  console.log(`  tool calls   : ${record.tool_calls.length}`);
  for (const call of record.tool_calls) {
    const flag = call.is_sandboxed ? " [SANDBOXED]" : "";
    console.log(`    ${call.sequence_index}. ${call.tool_name}${flag} ${JSON.stringify(call.args)}`);
    console.log(`       -> ${JSON.stringify(call.response)}`);
  }
  console.log(`  final output :`);
  for (const line of (record.run.final_output ?? "(none)").split("\n")) {
    console.log(`    ${line}`);
  }
}
