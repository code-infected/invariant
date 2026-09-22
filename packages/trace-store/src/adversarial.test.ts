/**
 * Adversarial-mode storage: batch kinds stay separate, injected tool calls round-trip,
 * and a store written before adversarial mode existed is migrated in place (and refused,
 * not silently misread, by a read-only open).
 */
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { openTraceStore, StoreOutdatedError } from "./index.js";

const tmpRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), "invariant-adv-store-test-"));

function seed(store: ReturnType<typeof openTraceStore>) {
  const taskId = store.upsertTask({ name: "t", prompt_template: "p", success_rubric: "r", thresholds: {} });
  const variantId = store.upsertVariant({ task_id: taskId, label: "v1", phrasing_text: "x", fixture_version: 1 });
  return { taskId, variantId };
}

describe("adversarial batches and injected tool calls", () => {
  test("adversarial batches never show up where consistency batches are read", () => {
    const root = tmpRoot();
    const store = openTraceStore({ root });
    try {
      const { taskId } = seed(store);
      const base = { task_id: taskId, tier: "smoke" as const, trials_per_variant: 1, variants_requested: 1, variant_labels: ["v1"] };
      const consistency = store.createBatch(base);
      store.finishBatch(consistency);
      const advA = store.createBatch({ ...base, kind: "adversarial", payload_id: "p-a", adversarial_payload: { id: "p-a", text: "x" } });
      store.finishBatch(advA);
      const advB = store.createBatch({ ...base, kind: "adversarial", payload_id: "p-b", adversarial_payload: { id: "p-b" } });
      store.finishBatch(advB);

      assert.equal(store.getLatestBatch(taskId)!.id, consistency);
      assert.equal(store.getLatestBatch(taskId, { finishedOnly: true })!.id, consistency);
      assert.deepEqual(store.listBatches(taskId).map((b) => b.id), [consistency]);
      assert.deepEqual(store.listBatches(taskId, { kind: "adversarial" }).map((b) => b.id), [advA, advB]);
      assert.equal(store.getLatestBatch(taskId, { kind: "adversarial" })!.id, advB);
      assert.equal(store.getLatestBatch(taskId, { kind: "adversarial", payloadId: "p-a" })!.id, advA);
      assert.equal(store.getLatestBatch(taskId, { kind: "adversarial", payloadId: "nope" }), null);

      const a = store.getBatch(advA)!;
      assert.equal(a.kind, "adversarial");
      assert.equal(a.payload_id, "p-a");
      assert.deepEqual(a.adversarial_payload, { id: "p-a", text: "x" });
      const c = store.getBatch(consistency)!;
      assert.equal(c.kind, "consistency");
      assert.equal(c.payload_id, null);
      assert.equal(c.adversarial_payload, null);
    } finally {
      store.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("an injected tool call is flagged with its payload id; others are not", () => {
    const root = tmpRoot();
    const store = openTraceStore({ root });
    try {
      const { taskId, variantId } = seed(store);
      const runId = store.recordRun({ task_id: taskId, variant_id: variantId, trial_number: 1 });
      const at = "2026-09-22T00:00:00.000Z";
      store.recordToolCall({ run_id: runId, sequence_index: 0, tool_name: "a", args: {}, response: {}, is_sandboxed: false, called_at: at });
      store.recordToolCall({
        run_id: runId,
        sequence_index: 1,
        tool_name: "b",
        args: {},
        response: { note: "planted" },
        is_sandboxed: false,
        called_at: at,
        injection_payload_id: "p-a",
      });
      const calls = store.getToolCalls(runId);
      assert.deepEqual(calls.map((c) => [c.is_injected, c.injection_payload_id]), [
        [false, null],
        [true, "p-a"],
      ]);
    } finally {
      store.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("a store from before adversarial mode is migrated on a writing open and refused by a read-only one", () => {
    const root = tmpRoot();
    try {
      const first = openTraceStore({ root });
      const { taskId, variantId } = seed(first);
      const batch = first.createBatch({ task_id: taskId, tier: "smoke", trials_per_variant: 1, variants_requested: 1, variant_labels: ["v1"] });
      const runId = first.recordRun({ task_id: taskId, variant_id: variantId, trial_number: 1, batch_id: batch });
      first.recordToolCall({ run_id: runId, sequence_index: 0, tool_name: "a", args: {}, response: {}, is_sandboxed: false, called_at: "x" });
      first.close();

      // Rebuild batches and tool_calls without the adversarial columns, as an older version wrote them.
      const db = new Database(path.join(root, "trace.db"));
      db.exec(`
        drop index if exists batches_kind_idx;
        alter table batches drop column adversarial_payload;
        alter table batches drop column payload_id;
        create table batches_old as select id, task_id, tier, trials_per_variant, variants_requested, variant_labels, created_at, finished_at from batches;
        alter table tool_calls drop column injection_payload_id;
        alter table tool_calls drop column is_injected;
      `);
      db.pragma("foreign_keys = OFF");
      db.exec(`drop table batches; alter table batches_old rename to batches;`);
      db.close();

      assert.throws(() => openTraceStore({ root, readonly: true }), (err: unknown) => {
        assert.ok(err instanceof StoreOutdatedError);
        assert.deepEqual(
          [...(err as StoreOutdatedError).missing].sort(),
          ["batches.adversarial_payload", "batches.kind", "batches.payload_id", "tool_calls.injection_payload_id", "tool_calls.is_injected"]
        );
        return true;
      });

      const migrated = openTraceStore({ root });
      try {
        assert.equal(migrated.getBatch(batch)!.kind, "consistency");
        assert.equal(migrated.getLatestBatch(taskId)!.id, batch);
        assert.deepEqual(migrated.getToolCalls(runId).map((c) => c.is_injected), [false]);
      } finally {
        migrated.close();
      }
      openTraceStore({ root, readonly: true }).close();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
