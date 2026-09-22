/**
 * Mixed-deployment batches are flagged by score and gate. The batches here are written
 * straight into the store (no proxy, no agent): what is under test is how the reports read
 * the fingerprints, not how runs get them (see agent-driver's run-trial tests for that).
 */
import test, { describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { computeDeploymentFingerprint, openTraceStore, type TraceStore } from "@invariant/trace-store";
import { loadValidTask } from "../lib/load-tasks.js";
import { INVARIANT_DIR } from "../lib/paths.js";
import { runGate, type EvaluatedTaskReport } from "./gate.js";
import { runScore } from "./score.js";
import { syncTask } from "./run.js";
import { assertDemoStorePath } from "./demo-seed.js";
import { clearConfiguredCredentials } from "../lib/models.js";
import { loadConfig } from "../lib/config.js";

const tools = [{ name: "lookup_order", description: "d", input_schema: { type: "object" } }];
const fpA = computeDeploymentFingerprint({ model_name: "m", model_version: "m-2026-01", system_prompt: "p", tool_schema: tools });
const fpB = computeDeploymentFingerprint({ model_name: "m", model_version: "m-2026-02", system_prompt: "p", tool_schema: tools });

function writeBatch(store: TraceStore, fingerprints: Array<string | null>): string {
  const task = loadValidTask("refund-duplicate-check");
  const v1 = task.fixture!.variants.find((v) => v.id === "v1")!;
  const { taskId, variantIds } = syncTask(store, task, [v1]);
  const batchId = store.createBatch({ task_id: taskId, tier: "smoke", trials_per_variant: fingerprints.length, variants_requested: 1, variant_labels: ["v1"] });
  store.recordDeploymentFingerprint(fpA);
  store.recordDeploymentFingerprint(fpB);
  fingerprints.forEach((fp, i) => {
    const run = store.recordRun({ task_id: taskId, variant_id: variantIds.get("v1")!, trial_number: i + 1, batch_id: batchId });
    store.recordToolCall({ run_id: run, sequence_index: 0, tool_name: "lookup_order", args: { order_id: "1234" }, response: {}, is_sandboxed: false, called_at: new Date().toISOString() });
    if (fp) store.setRunFingerprint(run, fp);
    store.completeRun({ run_id: run, status: "ok", final_output: "declined" });
  });
  store.finishBatch(batchId);
  return batchId;
}

describe("mixed deployment fingerprints in score and gate", () => {
  let root: string;
  let restoreCredentials: () => void = () => undefined;
  let mixed: string;
  let uniform: string;

  before(() => {
    restoreCredentials = clearConfiguredCredentials(loadConfig());
    root = fs.mkdtempSync(path.join(os.tmpdir(), "invariant-fp-warning-"));
    const store = openTraceStore({ root });
    try {
      uniform = writeBatch(store, [fpA.hash, fpA.hash, null]);
      mixed = writeBatch(store, [fpA.hash, fpA.hash, fpB.hash]);
    } finally {
      store.close();
    }
  });
  after(() => {
    restoreCredentials();
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("gate warns about a batch spanning two fingerprints, and names the component that changed", async () => {
    const report = await runGate({ batch: mixed, json: false }, { storeRoot: root, out: () => undefined });
    const t = report.tasks[0] as EvaluatedTaskReport;
    assert.equal(t.batch.deployment.mixed, true);
    assert.deepEqual(t.batch.deployment.changed, ["model_version"]);
    assert.deepEqual(t.batch.deployment.fingerprints.map((f) => [f.hash, f.runs]), [[fpA.hash, 2], [fpB.hash, 1]]);
    assert.equal(report.warnings.length, 1);
    assert.match(report.warnings[0]!, /spans 2 deployment fingerprints.*model_version/);
    // A warning, not a verdict: this batch is uniform in behaviour and passes its axes.
    assert.equal(t.verdict, "pass");
    assert.equal(t.notes.some((n) => /deployment fingerprints/.test(n)), false, "reported once, not also as a note");
  });

  test("a uniform batch (plus a run with no fingerprint) is not flagged", async () => {
    const report = await runGate({ batch: uniform, json: false }, { storeRoot: root, out: () => undefined });
    const t = report.tasks[0] as EvaluatedTaskReport;
    assert.equal(t.batch.deployment.mixed, false);
    assert.equal(t.batch.deployment.runs_without_fingerprint, 1);
    assert.deepEqual(report.warnings, []);
  });

  test("score prints the warning and each fingerprint", async () => {
    const out: string[] = [];
    const err: string[] = [];
    await runScore({ batch: mixed, json: false }, { storeRoot: root, out: (l) => out.push(l), err: (l) => err.push(l) });
    assert.ok(err.some((l) => /^warning: batch .* spans 2 deployment fingerprints/.test(l)));
    const text = out.join("\n");
    assert.ok(text.includes(fpA.hash.slice(0, 12)) && text.includes(fpB.hash.slice(0, 12)));
  });

  test("demo-seed refuses the default store", () => {
    assert.throws(() => assertDemoStorePath(INVARIANT_DIR), /refusing to write SYNTHETIC demo data into the default/);
    const occupied = fs.mkdtempSync(path.join(os.tmpdir(), "invariant-demo-occupied-"));
    try {
      fs.writeFileSync(path.join(occupied, "trace.db"), "");
      assert.throws(() => assertDemoStorePath(occupied), /already holds a trace.db/);
    } finally {
      fs.rmSync(occupied, { recursive: true, force: true });
    }
  });
});
