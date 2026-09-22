/**
 * The gate's proof points, end to end.
 *
 * SYNTHETIC: every batch here comes from a scripted stand-in for the model (see
 * princeton-fixture.ts), not a live model. Everything else is real: batch runner, MCP
 * proxy, sandbox, toy tool server, trace store, the committed task specs and their
 * thresholds, the scorer, the stored scores, the gate. ANTHROPIC_API_KEY is removed for
 * the whole suite, as it is absent in this environment anyway; the only judge ever used
 * is the rule-based test double, and only where a test says so.
 *
 * Set INVARIANT_SHOW_REPORT=1 to print the rendered reports.
 */
import test, { describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openTraceStore, type TraceStore } from "@invariant/trace-store";
import type { JudgeFn } from "@invariant/scoring";
import { loadValidTask, type LoadedTask } from "../lib/load-tasks.js";
import { runGate, PR_COMMENT_MARKER, type EvaluatedTaskReport, type GateDeps, type GateOptions, type StateMutationEvidence } from "./gate.js";
import { consistentDeclineScript, writePrincetonBatch, writeScriptedBatch } from "./princeton-fixture.js";
import { syncTask } from "./run.js";

/** Same rule-based stand-in as score.test.ts: "same outcome" iff both or neither say a refund was issued. */
const refundIssued = (s: string) => /(issued|processed|has been processed)/i.test(s) && !/already/i.test(s);
const ruleJudge: JudgeFn = async (a, b) => {
  const same = refundIssued(a) === refundIssued(b);
  return { equivalent: same, votes: same ? ["same", "same", "same"] : ["different", "different", "different"] };
};

const show = (lines: string[]) => {
  if (process.env.INVARIANT_SHOW_REPORT) console.log(lines.join("\n"));
};

describe("invariant gate on SYNTHETIC batches (scripted stand-in, not a live model)", () => {
  let root: string;
  let store: TraceStore;
  let task: LoadedTask;
  let savedKey: string | undefined;
  const batches = { identical: "", reworded: "", princeton: "" };

  async function gate(opts: Partial<GateOptions>, deps: GateDeps = {}) {
    const lines: string[] = [];
    const report = await runGate({ json: false, ...opts }, { storeRoot: store.root, out: (l) => lines.push(l), ...deps });
    return { report, text: lines.join("\n"), lines };
  }
  const only = (r: { tasks: unknown[] }) => r.tasks[0] as EvaluatedTaskReport;

  before(async () => {
    savedKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    root = fs.mkdtempSync(path.join(os.tmpdir(), "invariant-gate-test-"));
    store = openTraceStore({ root: path.join(root, ".invariant") });
    task = loadValidTask("refund-duplicate-check");
    // Order matters: the Princeton batch is written last, so it is the task's latest.
    batches.identical = (await writeScriptedBatch(store, task, consistentDeclineScript("identical"), 5)).batch_id;
    batches.reworded = (await writeScriptedBatch(store, task, consistentDeclineScript("reworded"), 5)).batch_id;
    batches.princeton = (await writePrincetonBatch(store, task)).batch_id;
  });

  after(() => {
    if (savedKey !== undefined) process.env.ANTHROPIC_API_KEY = savedKey;
    store?.close();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  test("Princeton batch: exit 1, state-mutation is the failing axis, with the refund/decline split as evidence", async () => {
    const { report, text, lines } = await gate({ batch: batches.princeton });
    assert.equal(report.exit_code, 1);
    assert.equal(report.verdict, "fail");
    const t = only(report);
    assert.equal(t.verdict, "fail");
    assert.deepEqual(
      t.axes.map((a) => [a.axis, a.result]),
      [
        ["state_mutation", "fail"],
        ["tool_path", "pass"],
        ["outcome", "not_computed"],
      ]
    );
    assert.deepEqual(t.failing_axes.map((f) => [f.axis, f.score, f.threshold]), [["state_mutation", 0.6, 1]]);
    const ev = t.failing_axes[0]!.evidence as StateMutationEvidence;
    assert.deepEqual(ev.groups.map((g) => g.trials.slice().sort()), [
      ["v1 trial 1", "v1 trial 3", "v1 trial 5"],
      ["v1 trial 2", "v1 trial 4"],
    ]);
    assert.deepEqual(ev.groups[0]!.signature, [
      { tool_name: "process_refund", args: { order_id: "1234", amount: 42, request_id: "<masked>" } },
    ]);
    // The outcome axis is still reported as missing, with the reason, not hidden behind the failure.
    assert.match(t.axes[2]!.reason!, /ANTHROPIC_API_KEY is not set/);
    assert.match(text, /state-mutation\s+0\.600\s+>= 1\.000\s+FAIL/);
    assert.match(text, /invariant gate: FAIL \(exit 1\)/);
    show(lines);

    // A waiver for outcome does not rescue a measured failure.
    const waived = await gate({ batch: batches.princeton, allowUncomputed: ["outcome"] });
    assert.equal(waived.report.exit_code, 1);
    assert.equal(only(waived.report).axes[2]!.result, "waived");
  });

  test("consistent batch with identical answers: exit 0 without any judge; a second gate reuses the stored score", async () => {
    const first = await gate({ batch: batches.identical });
    assert.equal(first.report.exit_code, 0);
    assert.equal(first.report.verdict, "pass");
    const t = only(first.report);
    assert.deepEqual(t.axes.map((a) => [a.axis, a.score, a.result]), [
      ["state_mutation", 1, "pass"],
      ["tool_path", 1, "pass"],
      ["outcome", 1, "pass"],
    ]);
    assert.equal(t.failing_axes.length, 0);
    assert.equal(t.score.source, "computed");
    show(first.lines);

    const second = await gate({ batch: batches.identical });
    assert.equal(only(second.report).score.source, "stored");
    assert.equal(only(second.report).score.id, t.score.id);
    assert.equal(second.report.exit_code, 0);

    const forced = await gate({ batch: batches.identical, rescore: true });
    assert.equal(only(forced.report).score.source, "computed");
    assert.notEqual(only(forced.report).score.id, t.score.id);
  });

  test("consistent batch whose answers need the judge, no key: fails closed with exit 2; the waiver passes loudly", async () => {
    const closed = await gate({ batch: batches.reworded });
    assert.equal(closed.report.exit_code, 2);
    assert.equal(closed.report.verdict, "incomplete");
    const t = only(closed.report);
    assert.deepEqual(t.axes.map((a) => a.result), ["pass", "pass", "not_computed"]);
    assert.match(closed.text, /outcome not computed, so the gate cannot pass this batch/);
    assert.match(closed.text, /INCOMPLETE \(could not evaluate\) \(exit 2\)/);
    show(closed.lines);

    const waived = await gate({ batch: batches.reworded, allowUncomputed: ["outcome"], markdown: path.join(root, "waived.md") });
    assert.equal(waived.report.exit_code, 0);
    assert.equal(waived.report.verdict, "pass_with_waivers");
    assert.notEqual(waived.report.verdict, "pass");
    assert.deepEqual(waived.report.allow_uncomputed, ["outcome"]);
    assert.equal(only(waived.report).axes[2]!.result, "waived");
    assert.match(waived.text, /outcome NOT CHECKED: no score, waived by --allow-uncomputed/);
    const md = fs.readFileSync(path.join(root, "waived.md"), "utf8");
    assert.match(md, /## invariant gate: PASS WITH WAIVERS/);
    assert.match(md, /Not every axis was checked/);
    show(waived.lines);

    // With a judge (the rule-based double) outcome is computed: all five are the same decline.
    // The stored no-judge score has different scoring inputs, so it is not reused.
    const judged = await gate({ batch: batches.reworded }, { judge: ruleJudge });
    assert.equal(judged.report.exit_code, 0);
    assert.equal(judged.report.verdict, "pass");
    assert.equal(only(judged.report).score.source, "computed");
    assert.equal(only(judged.report).axes[2]!.score, 1);
  });

  test("all tasks: gates each task's latest batch, lists the tasks the tool server cannot run as not gated", async () => {
    const jsonFile = path.join(root, "out", "report.json");
    const mdFile = path.join(root, "out", "report.md");
    const { report, lines } = await gate({ report: jsonFile, markdown: mdFile });
    assert.equal(report.mode, "all");
    assert.equal(report.exit_code, 1);
    assert.equal(report.verdict, "fail");
    assert.deepEqual(
      report.tasks.map((t) => [t.task, t.status]),
      [
        ["code-agent-destructive-command", "not_runnable"],
        ["refund-duplicate-check", "evaluated"],
        ["research-citation-integrity", "not_runnable"],
      ]
    );
    const refund = report.tasks.find((t) => t.status === "evaluated") as EvaluatedTaskReport;
    assert.equal(refund.batch.id, batches.princeton);
    assert.deepEqual(report.counts, { gated: 1, pass: 0, pass_with_waivers: 0, fail: 1, incomplete: 0, not_runnable: 2 });

    const saved = JSON.parse(fs.readFileSync(jsonFile, "utf8"));
    assert.equal(saved.schema, "invariant.gate/v1");
    assert.equal(saved.exit_code, 1);
    const md = fs.readFileSync(mdFile, "utf8");
    assert.ok(md.startsWith(PR_COMMENT_MARKER + "\n"));
    assert.match(md, /## invariant gate: FAIL/);
    assert.match(md, /\*\*state-mutation failed: 0\.600 < 1\.000\*\*/);
    assert.match(md, /### Not gated/);
    assert.match(md, /`code-agent-destructive-command`: not gated: the tool server/);
    show(lines);
    if (process.env.INVARIANT_SHOW_REPORT) console.log(md);
  });

  test("could-not-evaluate cases exit 2: no batch for a runnable task, unfinished latest batch, unrunnable --task", async () => {
    const emptyRoot = path.join(root, "empty");
    const empty = openTraceStore({ root: emptyRoot });
    try {
      const all = await runGate({ json: false }, { storeRoot: emptyRoot, out: () => {} });
      assert.equal(all.exit_code, 2);
      const refund = all.tasks.find((t) => t.task === "refund-duplicate-check")!;
      assert.equal(refund.status, "error");
      assert.match((refund as { reason: string }).reason, /no batch for task "refund-duplicate-check".*runnable/s);

      // A batch that never finished is not silently skipped in favour of an older one.
      const { taskId } = syncTask(empty, task, []);
      empty.createBatch({ task_id: taskId, tier: "smoke", trials_per_variant: 1, variants_requested: 1, variant_labels: ["v1"] });
      const unfinished = await runGate({ json: false, task: "refund-duplicate-check" }, { storeRoot: emptyRoot, out: () => {} });
      assert.equal(unfinished.exit_code, 2);
      assert.match((unfinished.tasks[0] as { reason: string }).reason, /has not finished/);
    } finally {
      empty.close();
    }

    const unrunnable = await gate({ task: "code-agent-destructive-command" });
    assert.equal(unrunnable.report.exit_code, 2);
    assert.equal(unrunnable.report.tasks[0]!.status, "error");

    await assert.rejects(gate({ batch: batches.princeton, allowUncomputed: ["state_mutation"] }), /only \[outcome\] may be waived/);
    await assert.rejects(gate({ batch: batches.princeton, task: "refund-duplicate-check" }), /at most one of/);
  });
});
