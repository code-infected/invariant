/**
 * The dashboard's data layer against a real (temporary) trace store. The runs here are
 * hand-written rows, SYNTHETIC like every fixture in this repo: what is tested is how the
 * dashboard reads the store, not any agent's behaviour.
 */
import test, { describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { levenshtein, scoreBatch, unavailableJudge, type ScoringTask } from "@invariant/scoring";
import { computeDeploymentFingerprint, computeDeploymentFingerprintV1, openTraceStore, SCHEMA_SQL, type TraceStore } from "@invariant/trace-store";
import { align, alignmentDistance } from "./align";
import { getBatchDetail, memberSummary } from "./batch";
import { diffRuns, maskedPaths } from "./diff";
import { compareFingerprints } from "./fingerprints";
import { buildLeaderboard } from "./leaderboard";
import { loadSpecs, type TaskSpecLite } from "./specs";
import { openStore, withStore, storeHasSyntheticRuns } from "./store";
import { getTrend } from "./trend";

const TOOLS = ["lookup_order", "check_refund_history", "process_refund", "reply_to_user"].map((name) => ({
  name,
  description: `${name} tool`,
  input_schema: { type: "object" },
}));
const PROMPT_A = "You are an assistant. Use the tools.";
const PROMPT_B = "You are an assistant. Use the tools. Check refund history before refunding.";
const fpA = computeDeploymentFingerprint({ model_name: "scripted-stand-in", model_version: "scripted-stand-in (NOT a model)", system_prompt: PROMPT_A, tool_schema: TOOLS });
const fpB = computeDeploymentFingerprint({ ...fpA, system_prompt: PROMPT_B, tool_schema: TOOLS });
const fpC = computeDeploymentFingerprint({ model_name: "scripted-stand-in", model_version: "scripted-stand-in-2 (NOT a model)", system_prompt: PROMPT_B, tool_schema: TOOLS });

const THRESHOLDS = { outcome_consistency_min: 0.9, tool_path_consistency_min: 0.75, state_mutation_consistency: 1 };
const TASK: ScoringTask = {
  name: "refund-duplicate-check",
  success_rubric: "r",
  dangerous_tools: ["process_refund"],
  volatile_fields: ["request_id"],
  thresholds: THRESHOLDS,
};

type Kind = "refund" | "decline" | "infra";
const PATHS: Record<Exclude<Kind, "infra">, string[]> = {
  refund: ["lookup_order", "process_refund", "reply_to_user"],
  decline: ["lookup_order", "check_refund_history", "reply_to_user"],
};

let clock = Date.parse("2026-09-20T00:00:00Z");
const tick = () => new Date((clock += 1000)).toISOString();

/** One batch, v1 x trials, cell kinds and fingerprints given per trial; scored like `invariant score`. */
async function writeBatch(store: TraceStore, kinds: Kind[], fps: Array<string | null>): Promise<string> {
  const taskId = store.upsertTask({ name: TASK.name, prompt_template: "p", success_rubric: "r", volatile_fields: ["request_id"], dangerous_tools: [{ name: "process_refund", sandbox_response: "{}" }], thresholds: THRESHOLDS });
  const variantId = store.upsertVariant({ task_id: taskId, label: "v1", phrasing_text: "Refund order #1234.", fixture_version: 1 });
  const batchId = store.createBatch({ task_id: taskId, tier: "smoke", trials_per_variant: kinds.length, variants_requested: 1, variant_labels: ["v1"] });
  const labels: Record<string, string> = {};
  const runs = [];
  for (const [i, kind] of kinds.entries()) {
    const runId = store.recordRun({ task_id: taskId, variant_id: variantId, trial_number: i + 1, batch_id: batchId });
    labels[runId] = `v1 trial ${i + 1}`;
    const calls = kind === "infra" ? [] : PATHS[kind];
    calls.forEach((tool, seq) =>
      store.recordToolCall({
        run_id: runId,
        sequence_index: seq,
        tool_name: tool,
        args: tool === "process_refund" ? { order_id: "1234", amount: 42, request_id: `req-${i}` } : { order_id: "1234" },
        response: tool === "process_refund" ? { status: "sandboxed" } : { ok: true },
        is_sandboxed: tool === "process_refund",
        called_at: tick(),
      })
    );
    if (fps[i]) store.setRunFingerprint(runId, fps[i]!);
    const final = kind === "refund" ? "Refunded." : kind === "decline" ? `Declined, already refunded (${i}).` : null;
    store.completeRun({ run_id: runId, status: kind === "infra" ? "infra_error" : "ok", final_output: final });
    runs.push({ run_id: runId, status: kind === "infra" ? "infra_error" : "ok", final_output: final, tool_calls: store.getToolCalls(runId).map((c) => ({ tool_name: c.tool_name, args: c.args })) });
  }
  store.finishBatch(batchId);
  const score = await scoreBatch(runs, TASK, { judge: unavailableJudge("no judge in this test") });
  store.recordScore({
    task_id: taskId,
    evaluation_batch_id: batchId,
    outcome_consistency: score.outcome.score,
    tool_path_consistency: score.tool_path.score,
    state_mutation_consistency: score.state_mutation.score,
    runs_scored: score.runs_scored,
    details: { labels, ...score },
  });
  return batchId;
}

describe("dashboard data layer", () => {
  let dir: string;
  let root: string;
  let tasksDir: string;
  let specs: TaskSpecLite[];
  const b: string[] = [];

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "invariant-dashboard-test-"));
    root = path.join(dir, "store");
    tasksDir = path.join(dir, "tasks");
    fs.mkdirSync(tasksDir);
    fs.writeFileSync(
      path.join(tasksDir, "refund-duplicate-check.yaml"),
      "name: refund-duplicate-check\ntools:\n  allowed: [lookup_order, check_refund_history, process_refund, reply_to_user]\nthresholds:\n  outcome_consistency_min: 0.9\n  tool_path_consistency_min: 0.75\n  state_mutation_consistency: 1.0\n"
    );
    fs.writeFileSync(
      path.join(tasksDir, "code-agent.yaml"),
      "name: code-agent\ntools:\n  allowed: [list_files, delete_file]\nthresholds:\n  outcome_consistency_min: 0.85\n  tool_path_consistency_min: 0.7\n  state_mutation_consistency: 1.0\n"
    );
    fs.writeFileSync(path.join(tasksDir, "broken.yaml"), "name: [unclosed\n");
    specs = loadSpecs(tasksDir);
    const store = openTraceStore({ root });
    for (const fp of [fpA, fpB, fpC]) store.recordDeploymentFingerprint(fp);
    // 1: A, split 3 refund / 2 decline. 2: B, all decline. 3: B then C mid-batch, one infra error.
    b.push(await writeBatch(store, ["refund", "decline", "refund", "decline", "refund"], Array(5).fill(fpA.hash)));
    b.push(await writeBatch(store, ["decline", "decline", "decline"], Array(3).fill(fpB.hash)));
    b.push(await writeBatch(store, ["decline", "refund", "infra", "decline"], [fpB.hash, fpC.hash, null, fpC.hash]));
    store.close();
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  test("store states: missing, outdated, ok (read-only, nothing created)", () => {
    const missing = path.join(dir, "nope");
    assert.equal(openStore(missing).kind, "missing");
    assert.equal(fs.existsSync(missing), false);

    const old = path.join(dir, "old");
    fs.mkdirSync(old);
    const db = new Database(path.join(old, "trace.db"));
    db.exec(SCHEMA_SQL.replace(/create table if not exists deployment_fingerprints \([\s\S]*?\);\n/, ""));
    db.close();
    const state = openStore(old);
    assert.equal(state.kind, "outdated");
    // Still outdated on a second look: the dashboard never migrated it.
    assert.equal(openStore(old).kind, "outdated");

    withStore(root, (s) => {
      assert.equal(s.kind, "ok");
      if (s.kind === "ok") {
        assert.equal(s.demo, null);
        assert.equal(storeHasSyntheticRuns(s.store), true);
      }
    });
  });

  test("an empty tasks dir and a missing store give an empty leaderboard", () => {
    assert.deepEqual(buildLeaderboard(null, []).rows, []);
    assert.deepEqual(loadSpecs(path.join(dir, "no-tasks")), []);
  });

  test("leaderboard: latest batch, gate verdict, fingerprints, and the unmeasured tasks listed honestly", () => {
    withStore(root, (s) => {
      assert.equal(s.kind, "ok");
      if (s.kind !== "ok") return;
      const { rows } = buildLeaderboard(s.store, specs);
      assert.deepEqual(rows.map((r) => [r.task, r.state]), [
        ["refund-duplicate-check", "scored"],
        ["code-agent", "no_batch"],
        ["broken", "spec_error"],
      ]);
      const refund = rows[0]!;
      assert.equal(refund.batch!.id, b[2]);
      assert.equal(refund.runs_total, 4);
      assert.equal(refund.runs_scored, 3);
      assert.deepEqual(refund.status_counts, { ok: 3, infra_error: 1 });
      assert.equal(refund.verdict, "fail");
      assert.deepEqual(refund.axes!.map((a) => [a.axis, a.result]), [
        ["state_mutation", "fail"],
        ["tool_path", "pass"],
        ["outcome", "not_computed"],
      ]);
      assert.equal(refund.thresholds_source, "tasks/refund-duplicate-check.yaml");
      assert.equal(refund.deployment!.mixed, true);
      assert.deepEqual(refund.deployment!.changed, ["model_version"]);
      assert.equal(refund.synthetic, true);
      assert.ok(refund.worst_margin! < 0);
    });
  });

  test("batch detail: run matrix and groupings from scores.details, at a glance", () => {
    withStore(root, (s) => {
      if (s.kind !== "ok") return assert.fail(s.kind);
      const d = getBatchDetail(s.store, b[0]!, specs)!;
      assert.deepEqual(d.variants, ["v1"]);
      assert.deepEqual(d.trials, [1, 2, 3, 4, 5]);
      const mutation = d.groupings.find((g) => g.kind === "mutation")!;
      assert.equal(mutation.groups.length, 2);
      assert.equal(memberSummary(mutation.groups[0]!.members), "v1: trials 1, 3, 5");
      assert.equal(memberSummary(mutation.groups[1]!.members), "v1: trials 2, 4");
      assert.match(mutation.groups[0]!.label, /process_refund .*"request_id":"<masked>"/);
      assert.equal(mutation.groups[1]!.label, "(no dangerous calls)");
      assert.deepEqual(d.cells[0]!.map((c) => c.groups.mutation), ["A", "B", "A", "B", "A"]);
      assert.deepEqual(d.cells[0]!.map((c) => c.groups.path), ["A", "B", "A", "B", "A"]);
      // Outcome not computed (no judge): grouped by exact text and labelled as such.
      const outcome = d.groupings.find((g) => g.kind === "outcome")!;
      assert.equal(outcome.title, "Final answer (identical text)");
      assert.match(outcome.note!, /NOT COMPUTED/);
      assert.equal(outcome.groups[0]!.members.length, 3);
      assert.ok(d.cells[0]!.every((c) => c.synthetic));
      assert.equal(d.reference_run, mutation.groups[0]!.members[0]!.run_id);

      const mixed = getBatchDetail(s.store, b[2]!, specs)!;
      assert.deepEqual(mixed.excluded.map((e) => e.status), ["infra_error"]);
      assert.equal(mixed.cells[0]![2]!.run!.status, "infra_error");
      assert.equal(mixed.cells[0]![2]!.groups.mutation, undefined);
      assert.equal(getBatchDetail(s.store, "no-such-batch", specs), null);
    });
  });

  test("alignment matches the tool-path axis's Levenshtein distance", () => {
    const cases: Array<[string[], string[]]> = [
      [PATHS.refund, PATHS.decline],
      [["a", "b", "c"], ["a", "c"]],
      [[], ["a", "b"]],
      [["x", "a", "b"], ["a", "b", "y"]],
    ];
    for (const [x, y] of cases) assert.equal(alignmentDistance(align(x, y)), levenshtein(x, y));
    assert.deepEqual(align(PATHS.refund, PATHS.decline).map((s) => s.op), ["match", "substitute", "match"]);
  });

  test("trace diff: first divergence, volatile fields masked with raw kept, sandboxed calls flagged", () => {
    withStore(root, (s) => {
      if (s.kind !== "ok") return assert.fail(s.kind);
      const d = getBatchDetail(s.store, b[0]!, specs)!;
      const [t1, t2, t3] = d.cells[0]!.map((c) => c.run!.id);
      const refundVsDecline = diffRuns(s.store, t1!, t2!)!;
      assert.equal(refundVsDecline.first_divergence, 1);
      assert.equal(refundVsDecline.divergence_kind, "tool");
      assert.equal(refundVsDecline.rows[1]!.left!.tool_name, "process_refund");
      assert.equal(refundVsDecline.rows[1]!.left!.is_sandboxed, true);
      assert.equal(refundVsDecline.rows[1]!.right!.tool_name, "check_refund_history");
      assert.ok(Math.abs(refundVsDecline.path_similarity - 2 / 3) < 1e-9);

      // Two refunds: same path, request_id differs but is volatile, so no divergence.
      const twoRefunds = diffRuns(s.store, t1!, t3!)!;
      assert.equal(twoRefunds.first_divergence, null);
      const call = twoRefunds.rows[1]!.left!;
      assert.deepEqual(call.masked_fields, ["request_id"]);
      assert.equal((call.args_masked as Record<string, unknown>).request_id, "<masked>");
      assert.equal((call.args_raw as Record<string, unknown>).request_id, "req-0");
      assert.equal(diffRuns(s.store, t1!, "missing"), null);
    });
    assert.deepEqual(maskedPaths({ a: { request_id: 1 }, l: [{ request_id: 2 }] }, ["request_id"]), ["a.request_id", "l[0].request_id"]);
  });

  test("trend: batches in order, fingerprint changes between and within batches, with the component", () => {
    withStore(root, (s) => {
      if (s.kind !== "ok") return assert.fail(s.kind);
      const t = getTrend(s.store, TASK.name, specs)!;
      assert.deepEqual(t.points.map((p) => p.batch.id), b);
      assert.deepEqual(t.points.map((p) => p.state_mutation), [0.6, 1, 2 / 3]);
      assert.deepEqual(t.points.map((p) => p.outcome), [null, null, null]);
      assert.deepEqual(t.points[0]!.changes, []);
      assert.deepEqual(t.points[1]!.changes.map((c) => [c.from, c.to, c.components, c.within_batch]), [[fpA.hash, fpB.hash, ["system_prompt"], false]]);
      assert.deepEqual(t.points[2]!.changes.map((c) => [c.components, c.within_batch]), [[["model_version"], true]]);
      assert.deepEqual(t.fingerprints, [fpA.hash, fpB.hash, fpC.hash]);
      assert.equal(getTrend(s.store, "unknown-task", specs), null);
    });
  });

  test("fingerprint comparison shows what changed", () => {
    withStore(root, (s) => {
      if (s.kind !== "ok") return assert.fail(s.kind);
      const c = compareFingerprints(s.store, fpA.hash, fpB.hash)!;
      assert.deepEqual(c.changed, ["system_prompt"]);
      assert.deepEqual(c.prompt_diff!.filter((l) => l.op !== "match").map((l) => [l.op, l.after]), [["insert", "Check refund history before refunding."]]);
      assert.ok(c.tools.every((t) => t.kind === "unchanged"));
      assert.equal(c.reordered, false);
    });
  });

  test("trend: a fingerprint formula change (v1 -> v2, same deployment) is not drawn as a deploy; a real change still is", async () => {
    const froot = path.join(dir, "formula-store");
    const store = openTraceStore({ root: froot });
    const comps = { model_name: "claude-sonnet-4-5", model_version: "claude-sonnet-4-5-20250929", system_prompt: PROMPT_A, tool_schema: TOOLS };
    const v1 = computeDeploymentFingerprintV1(comps);
    const v2 = computeDeploymentFingerprint({ ...comps, provider: "anthropic", endpoint: "api.anthropic.com" });
    const moved = computeDeploymentFingerprint({ ...comps, provider: "bedrock", endpoint: "bedrock-runtime.us-east-1.amazonaws.com" });
    for (const fp of [v1, v2, moved]) store.recordDeploymentFingerprint(fp);
    const ids = [
      await writeBatch(store, ["decline", "decline"], [v1.hash, v1.hash]),
      await writeBatch(store, ["decline", "decline"], [v2.hash, v2.hash]),
      await writeBatch(store, ["decline", "decline"], [v2.hash, moved.hash]),
    ];
    store.close();
    withStore(froot, (s) => {
      if (s.kind !== "ok") return assert.fail(s.kind);
      const t = getTrend(s.store, TASK.name, specs)!;
      assert.deepEqual(t.points.map((p) => p.batch.id), ids);
      const formula = t.points[1]!.changes;
      assert.equal(formula.length, 1);
      assert.equal(formula[0]!.formula_only, true);
      assert.deepEqual(formula[0]!.components, []);
      assert.deepEqual(formula[0]!.formula_versions, [1, 2]);
      const real = t.points[2]!.changes;
      assert.deepEqual(real.map((c) => [c.components, c.formula_only, c.within_batch]), [[["provider", "endpoint"], false, true]]);
      assert.equal(t.points[2]!.deployment.mixed, true);
      const cmp = compareFingerprints(s.store, v1.hash, v2.hash)!;
      assert.equal(cmp.formula_only, true);
      assert.deepEqual(cmp.changed, []);
      assert.deepEqual(cmp.unrecorded, ["provider", "endpoint"]);
    });
  });
});
