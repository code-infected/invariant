import test, { describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { openTraceStore } from "./index.js";

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "invariant-store-test-"));
}

function seed(store: ReturnType<typeof openTraceStore>) {
  const taskId = store.upsertTask({ name: "t", prompt_template: "p", success_rubric: "r", thresholds: {} });
  const variantId = store.upsertVariant({ task_id: taskId, label: "v1", phrasing_text: "x", fixture_version: 1 });
  return { taskId, variantId };
}

describe("trace store batches", () => {
  test("upgrades a trace.db created before batches existed, keeping its runs readable", () => {
    const root = tmpRoot();
    try {
      // The runs table exactly as the single-trial milestone created it.
      const db = new Database(path.join(root, "trace.db"));
      db.exec(`
        create table tasks (id text primary key, name text unique not null, prompt_template text not null,
          success_rubric text not null, forbidden_mutations text not null default '[]',
          dangerous_tools text not null default '[]', volatile_fields text not null default '[]',
          thresholds text not null, owner text, created_at text not null);
        create table variants (id text primary key, task_id text not null references tasks(id), label text not null,
          phrasing_text text not null, fixture_version integer not null, approved_by text, generated_at text,
          unique (task_id, fixture_version, label));
        create table runs (id text primary key, task_id text not null references tasks(id),
          variant_id text not null references variants(id), trial_number integer not null,
          deployment_fingerprint text,
          status text not null check (status in ('running','ok','timeout','infra_error')),
          final_output text, latency_ms integer, token_cost real, trace_blob_ref text, created_at text not null);
        insert into tasks values ('t1','old','p','r','[]','[]','[]','{}',null,'2026-09-19T00:00:00Z');
        insert into variants values ('v1','t1','v1','x',1,null,null);
        insert into runs values ('r1','t1','v1',1,null,'ok','done',10,5,null,'2026-09-19T00:00:00Z');
      `);
      db.close();

      const store = openTraceStore({ root });
      try {
        const old = store.getRun("r1")!;
        assert.equal(old.status, "ok");
        assert.equal(old.batch_id, null);
        assert.equal(old.attempt, 1);
        assert.equal(old.superseded, false);
        // And the upgraded schema accepts batch runs.
        const batchId = store.createBatch({
          task_id: "t1",
          tier: "smoke",
          trials_per_variant: 1,
          variants_requested: 1,
          variant_labels: ["v1"],
        });
        const runId = store.recordRun({ task_id: "t1", variant_id: "v1", trial_number: 1, batch_id: batchId, attempt: 2 });
        assert.equal(store.getRun(runId)!.attempt, 2);
      } finally {
        store.close();
      }
      // Opening again is a no-op, not a duplicate-column error.
      openTraceStore({ root }).close();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("the batch matrix excludes superseded attempts, and only infra errors can be superseded", () => {
    const root = tmpRoot();
    const store = openTraceStore({ root });
    try {
      const { taskId, variantId } = seed(store);
      const batchId = store.createBatch({
        task_id: taskId,
        tier: "full",
        trials_per_variant: 1,
        variants_requested: 2,
        variant_labels: ["v1"],
      });
      const first = store.recordRun({ task_id: taskId, variant_id: variantId, trial_number: 1, batch_id: batchId });
      store.completeRun({ run_id: first, status: "infra_error" });
      store.markSuperseded(first);
      const second = store.recordRun({ task_id: taskId, variant_id: variantId, trial_number: 1, batch_id: batchId, attempt: 2 });
      store.completeRun({ run_id: second, status: "ok", final_output: "done" });

      assert.deepEqual(store.getBatchRuns(batchId).map((r) => r.id), [second]);
      assert.deepEqual(
        store.getBatchRuns(batchId, { includeSuperseded: true }).map((r) => [r.attempt, r.superseded]),
        [
          [1, true],
          [2, false],
        ]
      );
      assert.throws(() => store.markSuperseded(second), /not an infra_error/);

      store.finishBatch(batchId);
      const batch = store.getBatch(batchId)!;
      assert.equal(batch.tier, "full");
      assert.deepEqual(batch.variant_labels, ["v1"]);
      assert.equal(batch.variants_requested, 2);
      assert.ok(batch.finished_at);
    } finally {
      store.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
