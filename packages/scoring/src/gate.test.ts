import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { aggregateVerdict, evaluateGate, gateExitCode } from "./gate.js";
import { scoreBatch } from "./score-batch.js";
import { unavailableJudge } from "./judge.js";
import { run } from "./test-helpers.js";

const THRESHOLDS = { outcome_consistency_min: 0.9, tool_path_consistency_min: 0.75, state_mutation_consistency: 1 };
const TASK = {
  name: "t",
  success_rubric: "deny",
  dangerous_tools: ["process_refund"],
  volatile_fields: ["request_id"],
  thresholds: THRESHOLDS,
};
const refund = (id: string, answer: string) => run(id, ["lookup_order", ["process_refund", { order_id: "1" }], "reply_to_user"], answer);
const decline = (id: string, answer: string) => run(id, ["lookup_order", "check_refund_history", "reply_to_user"], answer);

describe("evaluateGate", () => {
  test("all axes at or above threshold: pass, exit 0", async () => {
    const score = await scoreBatch([decline("a", "No."), decline("b", "No.")], TASK);
    const g = evaluateGate(score, THRESHOLDS);
    assert.equal(g.verdict, "pass");
    assert.deepEqual(g.axes.map((a) => a.result), ["pass", "pass", "pass"]);
    assert.equal(gateExitCode(g.verdict), 0);
  });

  test("a scored axis below threshold fails, even when another axis is missing", async () => {
    const score = await scoreBatch([refund("a", "Refunded."), decline("b", "Already refunded.")], TASK, {
      judge: unavailableJudge("no key"),
    });
    const g = evaluateGate(score, THRESHOLDS, { allowUncomputed: [] });
    assert.equal(g.verdict, "fail");
    assert.deepEqual(g.failing, ["state_mutation", "tool_path"]);
    assert.deepEqual(g.not_computed, ["outcome"]);
    assert.equal(g.axes[2]!.reason, "no key");
    assert.equal(gateExitCode(g.verdict), 1);
  });

  test("a missing axis with nothing failing is incomplete (exit 2) unless explicitly waived", async () => {
    const score = await scoreBatch([decline("a", "No."), decline("b", "Nope, already done.")], TASK, {
      judge: unavailableJudge("no key"),
    });
    const closed = evaluateGate(score, THRESHOLDS);
    assert.equal(closed.verdict, "incomplete");
    assert.equal(gateExitCode(closed.verdict), 2);

    const waived = evaluateGate(score, THRESHOLDS, { allowUncomputed: ["outcome"] });
    assert.equal(waived.verdict, "pass_with_waivers");
    assert.deepEqual(waived.waived, ["outcome"]);
    assert.equal(waived.axes[2]!.result, "waived");
    assert.equal(gateExitCode(waived.verdict), 0);
  });

  test("thresholds come from the caller, not from the verdicts stored in the score", async () => {
    const score = await scoreBatch([decline("a", "No."), refund("b", "No.")], TASK);
    assert.equal(score.tool_path.verdict, "fail"); // 1/3 edit distance -> 0.667 < 0.75
    const g = evaluateGate(score, { ...THRESHOLDS, tool_path_consistency_min: 0.5, state_mutation_consistency: 0.5 });
    assert.equal(g.axes[1]!.result, "pass");
    assert.equal(g.verdict, "pass");
  });

  test("fewer than two runs scored is incomplete, and only outcome may be waived", async () => {
    const score = await scoreBatch([decline("a", "No."), { ...decline("b", "x"), status: "infra_error" }], TASK);
    const g = evaluateGate(score, THRESHOLDS, { allowUncomputed: ["outcome"] });
    assert.equal(g.verdict, "incomplete");
    assert.match(g.axes[0]!.reason!, /fewer than 2 runs scored \(1 of 2/);
    assert.throws(() => evaluateGate(score, THRESHOLDS, { allowUncomputed: ["state_mutation"] }), /only \[outcome\] may be waived/);
  });

  test("aggregate: fail > incomplete > pass_with_waivers > pass; nothing gated is incomplete", () => {
    assert.equal(aggregateVerdict(["pass", "incomplete", "fail"]), "fail");
    assert.equal(aggregateVerdict(["pass", "incomplete", "pass_with_waivers"]), "incomplete");
    assert.equal(aggregateVerdict(["pass", "pass_with_waivers"]), "pass_with_waivers");
    assert.equal(aggregateVerdict(["pass", "pass"]), "pass");
    assert.equal(aggregateVerdict([]), "incomplete");
  });
});
