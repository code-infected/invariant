/**
 * Fan-out and retry policy.
 *
 * Most of these tests replace runTrial with a fake that writes real run rows to a real
 * trace store but skips the proxy and the model, so the scheduling and retry rules can be
 * checked quickly and exactly. The last test runs the real runTrial (real proxy, real
 * tool server, scripted model via TrialDeps.callModel) to show that concurrent trials and
 * a retried attempt land in the store as the matrix the scorer will read.
 */
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { openTraceStore, type TraceStore } from "@invariant/trace-store";
import { runBatch, type BatchDeps, type BatchPlan } from "./batch.js";
import { ProviderInfraError, type CallMessagesOptions, type MessagesResponse } from "./anthropic.js";
import type { TrialPlan, TrialResult, TrialError } from "./run-trial.js";

const require_ = createRequire(import.meta.url);
const TOY_SERVER_BIN = require_.resolve("@invariant/toy-tool-server/bin");

interface Fixture {
  store: TraceStore;
  root: string;
  plan: (overrides?: Partial<BatchPlan>) => BatchPlan;
  cleanup: () => void;
}

function fixture(variantCount: number): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "invariant-batch-test-"));
  const store = openTraceStore({ root: path.join(root, ".invariant") });
  const taskId = store.upsertTask({
    name: "refund-duplicate-check",
    prompt_template: "Refund order #{{order_id}}.",
    success_rubric: "test fixture",
    thresholds: { state_mutation_consistency: 1 },
  });
  const variants = Array.from({ length: variantCount }, (_, i) => {
    const label = `v${i + 1}`;
    const text = `Refund order #1234 (phrasing ${label}).`;
    return {
      variant_label: label,
      prompt_text: text,
      variant_id: store.upsertVariant({ task_id: taskId, label, phrasing_text: text, fixture_version: 1 }),
    };
  });
  return {
    store,
    root,
    plan: (overrides = {}) => ({
      task_id: taskId,
      task_name: "refund-duplicate-check",
      tier: "smoke",
      variants,
      variants_requested: variantCount,
      trials: 2,
      trial: {
        dangerous_tools: [{ name: "process_refund", sandbox_response: '{"status":"sandboxed"}' }],
        upstream: { command: process.execPath, args: [TOY_SERVER_BIN] },
        max_wall_clock_seconds: 60,
      },
      concurrency: 4,
      retry: { max_attempts: 3, retry_on: [429, 503, "timeout"] },
      ...overrides,
    }),
    cleanup: () => {
      store.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

type Behaviour = { status: TrialResult["status"]; stop_reason?: TrialResult["stop_reason"]; error?: TrialError };
const OK: Behaviour = { status: "ok", stop_reason: "reply_to_user" };
const infra = (http_status?: number, retry_after_ms?: number): Behaviour => ({
  status: "infra_error",
  stop_reason: "error",
  error: { kind: "provider", message: `provider ${http_status ?? "network"} failure`, http_status, retry_after_ms },
});

/**
 * A runTrial stand-in: writes a real run row (with the batch id and attempt it was
 * given) and completes it with whatever `behave` says, after an optional delay.
 */
function fakeRunTrial(
  store: TraceStore,
  behave: (plan: TrialPlan) => Behaviour | Promise<Behaviour>
): { run: NonNullable<BatchDeps["runTrial"]>; calls: TrialPlan[] } {
  const calls: TrialPlan[] = [];
  return {
    calls,
    run: async (plan) => {
      calls.push(plan);
      const runId = store.recordRun({
        task_id: plan.task_id,
        variant_id: plan.variant_id,
        trial_number: plan.trial_number,
        batch_id: plan.batch_id,
        attempt: plan.attempt,
      });
      const b = await behave(plan);
      store.completeRun({ run_id: runId, status: b.status, token_cost: 10, latency_ms: 1 });
      return {
        run_id: runId,
        status: b.status,
        stop_reason: b.stop_reason ?? (b.status === "infra_error" ? "error" : "reply_to_user"),
        record: store.getRunRecord(runId)!,
        raw_trace_ref: "",
        error: b.error,
      } as TrialResult;
    },
  };
}

const noSleep = { sleep: async () => undefined, random: () => 0 };
const cellKey = (p: { variant_label: string; trial_number: number }) => `${p.variant_label}#${p.trial_number}`;

describe("runBatch", () => {
  test("runs every variant x trial cell exactly once, as rows of one batch", async () => {
    const f = fixture(3);
    try {
      const fake = fakeRunTrial(f.store, () => OK);
      const summary = await runBatch(f.plan({ trials: 4 }), { store: f.store, runTrial: fake.run, ...noSleep });

      assert.equal(fake.calls.length, 12);
      assert.deepEqual(
        [...new Set(fake.calls.map(cellKey))].sort(),
        ["v1", "v2", "v3"].flatMap((v) => [1, 2, 3, 4].map((t) => `${v}#${t}`)).sort()
      );
      // Trial-major: all variants get trial 1 before any variant gets trial 2.
      assert.deepEqual(fake.calls.slice(0, 3).map((c) => c.trial_number), [1, 1, 1]);
      assert.ok(fake.calls.every((c) => c.batch_id === summary.batch_id && c.attempt === 1));

      assert.equal(summary.counts.cells, 12);
      assert.equal(summary.counts.completed, 12);
      assert.equal(summary.total_tokens, 120);
      assert.equal(f.store.getBatchRuns(summary.batch_id).length, 12);
      const batch = f.store.getBatch(summary.batch_id)!;
      assert.equal(batch.trials_per_variant, 4);
      assert.deepEqual(batch.variant_labels, ["v1", "v2", "v3"]);
      assert.ok(batch.finished_at);
    } finally {
      f.cleanup();
    }
  });

  test("keeps at most `concurrency` trials in flight", async () => {
    const f = fixture(5);
    try {
      let inFlight = 0;
      let peak = 0;
      const fake = fakeRunTrial(f.store, async (plan) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5 + (plan.trial_number % 3) * 4));
        inFlight--;
        return OK;
      });
      await runBatch(f.plan({ trials: 4, concurrency: 3 }), { store: f.store, runTrial: fake.run, ...noSleep });
      assert.equal(fake.calls.length, 20);
      assert.equal(peak, 3);
    } finally {
      f.cleanup();
    }
  });

  test("retries a retryable infra failure and does not count the failed attempt", async () => {
    const f = fixture(2);
    try {
      const failedOnce = new Set<string>();
      const fake = fakeRunTrial(f.store, (plan) => {
        if (cellKey(plan) === "v2#1" && !failedOnce.has("v2#1")) {
          failedOnce.add("v2#1");
          return infra(429, 4_000);
        }
        return OK;
      });
      const sleeps: number[] = [];
      const summary = await runBatch(f.plan(), {
        store: f.store,
        runTrial: fake.run,
        sleep: async (ms) => void sleeps.push(ms),
        random: () => 0,
      });

      assert.equal(summary.counts.cells, 4);
      assert.equal(summary.counts.completed, 4);
      assert.equal(summary.counts.retried_attempts, 1);
      assert.equal(summary.counts.recovered_after_retry, 1);
      assert.equal(summary.counts.infra_exhausted, 0);
      assert.deepEqual(sleeps, [4_000], "the provider's retry-after is honoured");

      const cell = summary.cells.find((c) => cellKey(c) === "v2#1")!;
      assert.deepEqual(cell.attempts.map((a) => a.status), ["infra_error", "ok"]);

      // The matrix has one ok row per cell; the failed attempt is kept but superseded.
      const matrix = f.store.getBatchRuns(summary.batch_id);
      assert.equal(matrix.length, 4);
      assert.ok(matrix.every((r) => r.status === "ok" && !r.superseded));
      const all = f.store.getBatchRuns(summary.batch_id, { includeSuperseded: true });
      assert.equal(all.length, 5);
      const superseded = all.filter((r) => r.superseded);
      assert.equal(superseded.length, 1);
      assert.equal(superseded[0]!.status, "infra_error");
      assert.equal(superseded[0]!.attempt, 1);
      assert.equal(matrix.find((r) => r.id === cell.final!.run_id)!.attempt, 2);
    } finally {
      f.cleanup();
    }
  });

  test("records a cell that exhausts its retries as infra_error, not as a completed run", async () => {
    const f = fixture(1);
    try {
      const fake = fakeRunTrial(f.store, (plan) => (plan.trial_number === 1 ? infra(503) : OK));
      const sleeps: number[] = [];
      const summary = await runBatch(f.plan(), {
        store: f.store,
        runTrial: fake.run,
        sleep: async (ms) => void sleeps.push(ms),
        random: () => 0,
      });

      assert.equal(fake.calls.filter((c) => c.trial_number === 1).length, 3, "max_attempts from the policy");
      assert.deepEqual(sleeps, [500, 1000], "exponential backoff between attempts");
      assert.equal(summary.counts.completed, 1);
      assert.equal(summary.counts.infra_exhausted, 1);
      assert.equal(summary.counts.retried_attempts, 2);
      assert.equal(summary.counts.recovered_after_retry, 0);

      const exhausted = summary.cells.find((c) => c.trial_number === 1)!;
      assert.equal(exhausted.outcome, "infra_exhausted");
      // The matrix row for this cell is the last attempt, and says plainly there is no answer.
      const row = f.store.getBatchRuns(summary.batch_id).find((r) => r.trial_number === 1)!;
      assert.equal(row.status, "infra_error");
      assert.equal(row.attempt, 3);
      assert.equal(row.superseded, false);
    } finally {
      f.cleanup();
    }
  });

  test("counts behavioural outcomes on the first attempt, including timeouts", async () => {
    const f = fixture(2);
    try {
      const fake = fakeRunTrial(f.store, (plan) =>
        plan.variant_label === "v1"
          ? { status: "timeout", stop_reason: "wall_clock_timeout" }
          : { status: "ok", stop_reason: "end_turn" }
      );
      let slept = 0;
      const summary = await runBatch(
        // Even a policy that would retry everything must not touch a behavioural answer.
        f.plan({ retry: { max_attempts: 5, retry_on: [408, 429, 500, 502, 503, 504, 529, "timeout"] } }),
        { store: f.store, runTrial: fake.run, sleep: async () => void slept++ }
      );
      assert.equal(fake.calls.length, 4);
      assert.equal(slept, 0);
      assert.equal(summary.counts.completed, 4);
      assert.equal(summary.counts.timeout, 2);
      assert.equal(summary.counts.ok, 2);
      assert.equal(summary.counts.retried_attempts, 0);
    } finally {
      f.cleanup();
    }
  });

  test("does not retry failures outside the policy: unlisted statuses, rejections, harness errors", async () => {
    const f = fixture(4);
    try {
      const fake = fakeRunTrial(f.store, (plan) => {
        if (plan.variant_label === "v1") return infra(529);
        if (plan.variant_label === "v2") {
          return {
            status: "infra_error",
            error: { kind: "provider_rejected", message: "Anthropic API request failed (401)", http_status: 401 },
          };
        }
        if (plan.variant_label === "v3") return { status: "infra_error", error: { kind: "harness", message: "proxy exited" } };
        return infra(undefined); // no HTTP response: not retried, because "timeout" is not listed below
      });
      const summary = await runBatch(f.plan({ trials: 1, retry: { max_attempts: 3, retry_on: [429, 503] } }), {
        store: f.store,
        runTrial: fake.run,
        ...noSleep,
      });
      assert.equal(fake.calls.length, 4, "each cell ran once");
      assert.equal(summary.counts.errors, 4);
      assert.equal(summary.counts.completed, 0);
      assert.equal(summary.counts.infra_exhausted, 0);
      assert.equal(f.store.getBatchRuns(summary.batch_id, { includeSuperseded: true }).length, 4);
    } finally {
      f.cleanup();
    }
  });

  test("a trial runner that throws fails its own cell, not the batch", async () => {
    const f = fixture(2);
    try {
      const fake = fakeRunTrial(f.store, () => OK);
      const summary = await runBatch(f.plan({ trials: 1 }), {
        store: f.store,
        runTrial: async (plan, deps) => {
          if (plan.variant_label === "v1") throw new Error("could not write proxy config");
          return fake.run(plan, deps);
        },
        ...noSleep,
      });
      assert.equal(summary.counts.completed, 1);
      assert.equal(summary.counts.errors, 1);
      assert.match(summary.cells.find((c) => c.variant_label === "v1")!.crash!, /proxy config/);
      assert.ok(f.store.getBatch(summary.batch_id)!.finished_at);
    } finally {
      f.cleanup();
    }
  });

  test("end to end: concurrent real trials through the proxy, with one retried 429", async () => {
    const f = fixture(2);
    try {
      let rateLimited = false;
      const callModel = async (options: CallMessagesOptions): Promise<MessagesResponse> => {
        const prompt = options.messages[0]!.content as string;
        const turn = options.messages.length; // 1 on the first model call of an attempt
        if (prompt.includes("v2") && turn === 1 && !rateLimited) {
          rateLimited = true;
          throw new ProviderInfraError("Anthropic API request failed (429): rate_limit_error", 429, 0);
        }
        const usage = { input_tokens: 10, output_tokens: 5 };
        if (turn === 1) {
          return {
            id: "m",
            model: "scripted-stand-in",
            stop_reason: "tool_use",
            content: [{ type: "tool_use", id: "t1", name: "check_refund_history", input: { order_id: "1234" } }],
            usage,
          };
        }
        return {
          id: "m",
          model: "scripted-stand-in",
          stop_reason: "tool_use",
          content: [{ type: "tool_use", id: "t2", name: "reply_to_user", input: { message: "Already refunded." } }],
          usage,
        };
      };

      const summary = await runBatch(f.plan({ trials: 2, concurrency: 2 }), {
        store: f.store,
        callModel,
        ...noSleep,
      });

      assert.equal(summary.counts.cells, 4);
      assert.equal(summary.counts.completed, 4);
      assert.equal(summary.counts.retried_attempts, 1);

      const matrix = f.store.getBatchRuns(summary.batch_id);
      assert.equal(matrix.length, 4);
      for (const run of matrix) {
        const record = f.store.getRunRecord(run.id)!;
        assert.equal(run.status, "ok");
        assert.equal(run.final_output, "Already refunded.");
        assert.deepEqual(record.tool_calls.map((c) => c.tool_name), ["check_refund_history", "reply_to_user"]);
        const raw = f.store.readRawTrace(run.trace_blob_ref!) as Record<string, unknown>;
        assert.equal(raw.batch_id, summary.batch_id);
        assert.equal(raw.attempt, run.attempt);
      }

      const superseded = f.store.getBatchRuns(summary.batch_id, { includeSuperseded: true }).filter((r) => r.superseded);
      assert.equal(superseded.length, 1);
      assert.equal(superseded[0]!.status, "infra_error");
      const raw = f.store.readRawTrace(superseded[0]!.trace_blob_ref!) as { error: TrialError };
      assert.equal(raw.error.http_status, 429);
    } finally {
      f.cleanup();
    }
  });
});
