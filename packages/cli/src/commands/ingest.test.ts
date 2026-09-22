/**
 * `invariant ingest` against the trace files the LangGraph adapter wrote.
 *
 * SYNTHETIC: adapters/langgraph/tests/fixtures/princeton-synthetic was produced by the
 * Python adapter driving the real LangGraph example graph with a scripted chat model (not
 * a model), reproducing the Princeton refund scenario (3 of 5 trials refund). What is
 * tested here is the file contract and the import, not any agent's behaviour.
 */
import test, { describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openTraceStore } from "@invariant/trace-store";
import { loadConfig } from "../lib/config.js";
import { loadValidTask } from "../lib/load-tasks.js";
import { REPO_ROOT } from "../lib/paths.js";
import { IngestError, ingestTraceFiles, runIngest } from "./ingest.js";
import { scoreStoredBatch } from "./score.js";

const FIXTURES = path.join(REPO_ROOT, "adapters", "langgraph", "tests", "fixtures", "princeton-synthetic");
const TASK = "refund-duplicate-check";

function fixtureFiles(): string[] {
  return fs
    .readdirSync(FIXTURES)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => path.join(FIXTURES, f));
}

describe("invariant ingest", () => {
  let tmp: string;

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "invariant-ingest-test-"));
  });
  after(() => {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  /** A copy of the fixture directory, with `edit` applied to the parsed file whose name ends in `which`. */
  function variantDir(name: string, which: string | null, edit: (trace: any) => void): string {
    const dir = path.join(tmp, name);
    fs.mkdirSync(dir, { recursive: true });
    for (const file of fixtureFiles()) {
      const trace = JSON.parse(fs.readFileSync(file, "utf8"));
      if (which !== null && file.endsWith(which)) edit(trace);
      fs.writeFileSync(path.join(dir, path.basename(file)), JSON.stringify(trace, null, 2));
    }
    return dir;
  }

  function expectRefused(dir: string, pattern: RegExp, tier: "smoke" | "full" = "smoke"): void {
    const storeRoot = path.join(tmp, `store-${path.basename(dir)}`);
    assert.throws(
      () => ingestTraceFiles({ task: TASK, tier, paths: [dir] }, { storeRoot }),
      (err: unknown) => err instanceof IngestError && err.problems.some((p) => pattern.test(p))
    );
    // Validation happens before the store is opened: nothing was written, not even the file.
    assert.equal(fs.existsSync(path.join(storeRoot, "trace.db")), false);
  }

  test("fingerprint provider and endpoint (optional in the file) reach the stored fingerprint; files without them stay valid", () => {
    const withProvider = variantDir("with-provider", "", (trace) => {
      if (trace.fingerprint) {
        trace.fingerprint.provider = "openai";
        trace.fingerprint.endpoint = "api.openai.com";
      }
    });
    const roots = { with: path.join(tmp, "store-with-provider"), without: path.join(tmp, "store-without-provider") };
    const a = ingestTraceFiles({ task: TASK, tier: "smoke", paths: [withProvider] }, { storeRoot: roots.with });
    const b = ingestTraceFiles({ task: TASK, tier: "smoke", paths: [FIXTURES] }, { storeRoot: roots.without });
    for (const [root, result, provider, endpoint] of [
      [roots.with, a, "openai", "api.openai.com"],
      [roots.without, b, null, null],
    ] as const) {
      const store = openTraceStore({ root });
      try {
        assert.ok(result.fingerprints.length >= 1);
        for (const hash of result.fingerprints) {
          const fp = store.getDeploymentFingerprint(hash)!;
          assert.equal(fp.fingerprint_version, 2);
          assert.equal(fp.provider, provider);
          assert.equal(fp.endpoint, endpoint);
        }
      } finally {
        store.close();
      }
    }
    assert.notDeepEqual(a.fingerprints, b.fingerprints, "provider and endpoint are hashed");
  });

  test("a valid adapter batch becomes one finished batch that the unchanged scorer scores", async () => {
    const storeRoot = path.join(tmp, "store-valid");
    const lines: string[] = [];
    const result = runIngest({ task: TASK, tier: "smoke", paths: [FIXTURES], json: false }, { storeRoot, out: (l) => lines.push(l), err: () => undefined });
    assert.equal(result.runs, 5);
    assert.deepEqual(result.statuses, { ok: 5 });
    assert.equal(result.synthetic, true);
    assert.equal(result.sandboxed_calls, 3);
    assert.match(lines.join("\n"), /SYNTHETIC/);
    // The 1 x 5 shape is not the smoke tier's 2 x 2, and ingest says so rather than hiding it.
    assert.equal(result.warnings.length, 1);

    const store = openTraceStore({ root: storeRoot });
    try {
      const batch = store.getBatch(result.batch_id)!;
      assert.ok(batch.finished_at);
      assert.equal(batch.tier, "smoke");
      assert.equal(batch.trials_per_variant, 5);
      assert.deepEqual(batch.variant_labels, ["v1"]);
      const runs = store.getBatchRuns(batch.id);
      assert.deepEqual(runs.map((r) => r.trial_number), [1, 2, 3, 4, 5]);
      assert.ok(runs.every((r) => r.status === "ok" && r.attempt === 1 && !r.superseded && r.trace_blob_ref));

      // Sandbox flags survive the import, call by call.
      const calls = runs.flatMap((r) => store.getToolCalls(r.id));
      for (const c of calls) assert.equal(c.is_sandboxed, c.tool_name === "process_refund", `${c.tool_name} #${c.sequence_index}`);
      const refunds = calls.filter((c) => c.tool_name === "process_refund");
      assert.equal(refunds.length, 3);
      assert.deepEqual(refunds[0]!.response, { status: "sandboxed", refund_id: "sandbox-0001" });

      // Fingerprint hash computed by ingest from the file's components; labelled synthetic.
      const deployment = store.getBatchDeployment(batch.id);
      assert.equal(deployment.fingerprints.length, 1);
      assert.equal(deployment.runs_without_fingerprint, 0);
      assert.equal(deployment.fingerprints[0]!.synthetic, true);
      const fp = store.getDeploymentFingerprint(deployment.fingerprints[0]!.hash)!;
      assert.equal(JSON.parse(fp.tool_schema_json).length, 4);

      // The raw trace keeps the whole file plus where it came from.
      const raw = store.readRawTrace(runs[0]!.trace_blob_ref!) as { ingested: { from: string }; format: string; messages: unknown[] };
      assert.equal(raw.format, "invariant.trial-trace/v1");
      assert.ok(raw.ingested.from.endsWith("refund-duplicate-check.v1.trial-001.json"));
      assert.ok(raw.messages.length > 0);

      // And the scoring engine, untouched, sees the Princeton failure in adapter-written data.
      const stored = await scoreStoredBatch(store, batch, loadValidTask(TASK), loadConfig());
      assert.equal(stored.score.state_mutation.score, 0.6);
      assert.equal(stored.score.state_mutation.verdict, "fail");
    } finally {
      store.close();
    }
  });

  test("a file that is not JSON is refused", () => {
    const dir = variantDir("not-json", null, () => undefined);
    fs.writeFileSync(path.join(dir, "broken.json"), "{ nope");
    expectRefused(dir, /broken\.json: not valid JSON/);
  });

  test("a file missing a required field is refused with the field named", () => {
    expectRefused(variantDir("no-status", "trial-003.json", (t) => delete t.status), /trial-003\.json: status: Required/);
  });

  test("a file with a tool call missing is_sandboxed is refused", () => {
    expectRefused(
      variantDir("no-flag", "trial-001.json", (t) => delete t.tool_calls[1].is_sandboxed),
      /tool_calls\.1\.is_sandboxed: Required/
    );
  });

  test("a dangerous call that was not sandboxed is refused, never scored", () => {
    expectRefused(
      variantDir("unsandboxed", "trial-001.json", (t) => {
        const refund = t.tool_calls.find((c: { tool_name: string }) => c.tool_name === "process_refund");
        refund.is_sandboxed = false;
      }),
      /process_refund is declared dangerous .* was NOT sandboxed/
    );
  });

  test("a sandbox flag on a tool the task does not declare dangerous is refused", () => {
    expectRefused(variantDir("oversandboxed", "trial-002.json", (t) => (t.tool_calls[0].is_sandboxed = true)), /marked sandboxed but the task does not declare it dangerous/);
  });

  test("a phrasing that is not the fixture's is refused", () => {
    expectRefused(variantDir("text", "trial-002.json", (t) => (t.variant.text += " (edited)")), /text differs from tasks\/refund-duplicate-check\.variants\.json/);
  });

  test("an incomplete matrix is refused", () => {
    const dir = variantDir("gap", null, () => undefined);
    fs.rmSync(path.join(dir, "refund-duplicate-check.v1.trial-004.json"));
    expectRefused(dir, /incomplete, no file for: v1 trial 4/);
  });

  test("files from different batches are refused", () => {
    expectRefused(variantDir("mixed", "trial-005.json", (t) => (t.batch.key = "another-batch")), /batch block differs/);
  });

  test("out-of-order sequence indices are refused", () => {
    expectRefused(variantDir("seq", "trial-001.json", (t) => (t.tool_calls[1].sequence_index = 7)), /sequence_index 7; calls must be in order/);
  });

  test("a tier other than the files' is refused", () => {
    expectRefused(variantDir("tier", null, () => undefined), /tier is "smoke", expected "full"/, "full");
  });
});
