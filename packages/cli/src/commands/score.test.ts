/**
 * The scoring engine's proof point, end to end.
 *
 * SYNTHETIC: the batch is a scripted reproduction of the Princeton RFC refund scenario
 * (see princeton-fixture.ts), not a live model result. Everything except the model is
 * real: batch runner, MCP proxy, sandbox, toy tool server, trace store, the committed
 * tasks/refund-duplicate-check.yaml, the scorer, the persisted scores, the report.
 *
 * Set INVARIANT_SHOW_REPORT=1 to print the rendered report.
 */
import test, { describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openTraceStore, type TraceStore } from "@invariant/trace-store";
import type { BatchSummary } from "@invariant/agent-driver";
import type { JudgeFn } from "@invariant/scoring";
import { loadConfig } from "../lib/config.js";
import { loadValidTask, type LoadedTask } from "../lib/load-tasks.js";
import { renderReport, resolveBatch, runScore, scoreStoredBatch } from "./score.js";
import { writePrincetonBatch } from "./princeton-fixture.js";

/**
 * A rule-based stand-in for the LLM judge, for exercising the outcome axis's clustering
 * and persistence without a key: two answers are "the same outcome" iff both or neither
 * say a refund was issued. It is a test double, and its verdicts are only as good as its
 * one regex, which is fine for five scripted answers and meaningless for anything else.
 */
const refundIssued = (s: string) => /(issued|processed|has been processed)/i.test(s) && !/already/i.test(s);
const ruleJudge: JudgeFn = async (a, b) => {
  const same = refundIssued(a) === refundIssued(b);
  return { equivalent: same, votes: same ? ["same", "same", "same"] : ["different", "different", "different"] };
};

describe("invariant score on a SYNTHETIC reproduction of the Princeton refund scenario", () => {
  let root: string;
  let store: TraceStore;
  let task: LoadedTask;
  let summary: BatchSummary;
  let sideEffectLog: string;

  before(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "invariant-score-test-"));
    sideEffectLog = path.join(root, "side-effects.jsonl");
    store = openTraceStore({ root: path.join(root, ".invariant") });
    task = loadValidTask("refund-duplicate-check");
    summary = await writePrincetonBatch(store, task, { INVARIANT_TOY_SIDE_EFFECT_LOG: sideEffectLog });
  });

  after(() => {
    store?.close();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  test("the synthetic batch is 5 completed runs of the identical prompt, 3 refunds sandboxed", () => {
    assert.equal(summary.counts.completed, 5);
    const runs = store.getBatchRuns(summary.batch_id);
    assert.equal(runs.length, 5);
    assert.equal(new Set(runs.map((r) => r.variant_id)).size, 1);
    const refunds = runs.flatMap((r) => store.getToolCalls(r.id)).filter((c) => c.tool_name === "process_refund");
    assert.equal(refunds.length, 3);
    assert.ok(refunds.every((c) => c.is_sandboxed));
    // Raw request_ids all differ: only masking can make these one signature.
    assert.equal(new Set(refunds.map((c) => (c.args as { request_id: string }).request_id)).size, 3);
    // And none of the three reached the backend.
    const backend = fs.existsSync(sideEffectLog) ? fs.readFileSync(sideEffectLog, "utf8") : "";
    assert.doesNotMatch(backend, /process_refund/);
  });

  test("state-mutation scores 3/5 = 0.6 and fails the task's 1.0 threshold", async () => {
    const stored = await scoreStoredBatch(store, store.getBatch(summary.batch_id)!, task, loadConfig(), { judge: ruleJudge });
    const sm = stored.score.state_mutation;
    assert.equal(task.spec.thresholds.state_mutation_consistency, 1);
    assert.equal(sm.score, 0.6);
    assert.equal(sm.verdict, "fail");
    const [refunded, declined] = sm.result!.groups;
    assert.deepEqual(
      refunded!.run_ids.map((id) => stored.labels.get(id)).sort(),
      ["v1 trial 1", "v1 trial 3", "v1 trial 5"]
    );
    assert.deepEqual(refunded!.signature, [
      { tool_name: "process_refund", args: { order_id: "1234", amount: 42, request_id: "<masked>" } },
    ]);
    assert.deepEqual(declined!.signature, []);
    assert.deepEqual(declined!.run_ids.map((id) => stored.labels.get(id)).sort(), ["v1 trial 2", "v1 trial 4"]);

    // Tool-path: paths LPR x2, LCR x2, LCPR x1 -> mean pairwise similarity 23/30, which
    // clears 0.75. The paths look alike; what they did to the world does not. That gap
    // is why state-mutation is its own exact-match axis.
    assert.ok(Math.abs(stored.score.tool_path.score! - 23 / 30) < 1e-12);
    assert.equal(stored.score.tool_path.verdict, "pass");

    // Outcome, with the rule-based stand-in judge: 3 "refunded" vs 2 "declined" = 0.6.
    assert.equal(stored.score.outcome.score, 0.6);
    assert.equal(stored.score.outcome.verdict, "fail");

    // Persisted.
    const saved = store.getScores(summary.batch_id)[0]!;
    assert.equal(saved.id, stored.score_id);
    assert.equal(saved.state_mutation_consistency, 0.6);
    assert.equal(saved.outcome_consistency, 0.6);
    assert.equal(saved.runs_scored, 5);

    const report = renderReport(stored).join("\n");
    assert.match(report, /state-mutation\s+0\.600\s+>= 1\.000\s+FAIL/);
    assert.match(report, /tool-path\s+0\.767\s+>= 0\.750\s+pass/);
    if (process.env.INVARIANT_SHOW_REPORT) console.log(report);
  });

  test("without ANTHROPIC_API_KEY the outcome axis is reported not computed, the rest still scored and saved", async () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    const lines: string[] = [];
    const exitBefore = process.exitCode;
    try {
      await runScore(
        { batch: summary.batch_id, json: false },
        { storeRoot: store.root, out: (l) => lines.push(l), err: (l) => lines.push(l) }
      );
      assert.equal(process.exitCode, 1, "an axis without a score makes the command exit nonzero");
    } finally {
      process.exitCode = exitBefore;
      if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
    }
    const report = lines.join("\n");
    assert.match(report, /state-mutation\s+0\.600\s+>= 1\.000\s+FAIL/);
    assert.match(report, /outcome\s+-\s+>= 0\.900\s+NOT COMPUTED/);
    assert.match(report, /ANTHROPIC_API_KEY is not set/);
    const latest = store.getScores(summary.batch_id)[0]!;
    assert.equal(latest.state_mutation_consistency, 0.6);
    assert.equal(latest.outcome_consistency, null);
    if (process.env.INVARIANT_SHOW_REPORT) console.log(report);
  });

  test("--task resolves to the task's latest finished batch; bad selections are refused", () => {
    assert.equal(resolveBatch(store, { task: "refund-duplicate-check" }).batch.id, summary.batch_id);
    assert.throws(() => resolveBatch(store, {}), /exactly one of/);
    assert.throws(() => resolveBatch(store, { batch: "x", task: "y" }), /exactly one of/);
    assert.throws(() => resolveBatch(store, { batch: "no-such-batch" }), /no batch with id/);
  });
});
