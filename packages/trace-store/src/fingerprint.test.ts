import test, { describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import {
  canonicalJson,
  changedComponents,
  compareDeployments,
  computeDeploymentFingerprint,
  computeDeploymentFingerprintV1,
  normalizeEndpoint,
  isScriptedStandIn,
  openTraceStore,
  SCHEMA_SQL,
  StoreNotFoundError,
  StoreOutdatedError,
  type FingerprintInput,
} from "./index.js";

const TOOLS = [
  {
    name: "lookup_order",
    description: "Look up an order.",
    input_schema: { type: "object", properties: { order_id: { type: "string" } }, required: ["order_id"] },
  },
  {
    name: "process_refund",
    description: "Refund an order.",
    input_schema: {
      type: "object",
      properties: { order_id: { type: "string" }, amount: { type: "number" }, request_id: { type: "string" } },
      required: ["order_id", "amount"],
    },
  },
];

const BASE: FingerprintInput = {
  model_name: "claude-sonnet-4-5",
  model_version: "claude-sonnet-4-5-20250929",
  system_prompt: "You are an assistant.",
  tool_schema: TOOLS,
};

/** Rebuild every object with its keys in reverse insertion order, at every depth. */
function reverseKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as object).reverse()) out[k] = reverseKeys((value as Record<string, unknown>)[k]);
    return out;
  }
  return value;
}

describe("deployment fingerprint hashing", () => {
  test("is deterministic and independent of object key order at every depth", () => {
    const a = computeDeploymentFingerprint(BASE);
    const reordered = reverseKeys(TOOLS);
    // Sanity: the reordering really changed the serialisation.
    assert.notEqual(JSON.stringify(reordered), JSON.stringify(TOOLS));
    const b = computeDeploymentFingerprint({ ...BASE, tool_schema: reordered });
    assert.equal(a.hash, b.hash);
    assert.equal(a.tool_schema_hash, b.tool_schema_hash);
    assert.equal(a.tool_schema_json, b.tool_schema_json);
    assert.equal(computeDeploymentFingerprint(BASE).hash, a.hash);
    assert.match(a.hash, /^[0-9a-f]{64}$/);
  });

  test("a change in any single component changes the hash, and is attributed to that component", () => {
    const base = computeDeploymentFingerprint(BASE);
    const variants: Array<[string, FingerprintInput, string]> = [
      ["model_name", { ...BASE, model_name: "claude-opus-4-1" }, "model_name"],
      ["model_version", { ...BASE, model_version: "claude-sonnet-4-5-20260101" }, "model_version"],
      ["system_prompt", { ...BASE, system_prompt: "You are an assistant. Check refund history first." }, "system_prompt"],
      ["system_prompt -> null", { ...BASE, system_prompt: null }, "system_prompt"],
      [
        "tool description",
        { ...BASE, tool_schema: [{ ...TOOLS[0]!, description: "Look up an order by id." }, TOOLS[1]!] },
        "tool_schema",
      ],
      [
        "tool input schema",
        {
          ...BASE,
          tool_schema: [
            TOOLS[0]!,
            { ...TOOLS[1]!, input_schema: { ...TOOLS[1]!.input_schema, required: ["order_id", "amount", "request_id"] } },
          ],
        },
        "tool_schema",
      ],
      ["tool removed", { ...BASE, tool_schema: [TOOLS[0]!] }, "tool_schema"],
      ["tools reordered", { ...BASE, tool_schema: [TOOLS[1]!, TOOLS[0]!] }, "tool_schema"],
    ];
    const seen = new Set([base.hash]);
    for (const [label, input, component] of variants) {
      const fp = computeDeploymentFingerprint(input);
      assert.notEqual(fp.hash, base.hash, `${label} should change the hash`);
      assert.deepEqual(changedComponents(base, fp), [component], label);
      seen.add(fp.hash);
    }
    assert.equal(seen.size, variants.length + 1, "every variant hashes differently");
  });

  test("the hash covers the component boundary, not a concatenation", () => {
    // Moving text between model_name and model_version must not collide.
    const a = computeDeploymentFingerprint({ ...BASE, model_name: "ab", model_version: "c" });
    const b = computeDeploymentFingerprint({ ...BASE, model_name: "a", model_version: "bc" });
    assert.notEqual(a.hash, b.hash);
  });

  test("canonicalJson sorts keys but keeps array order", () => {
    assert.equal(canonicalJson({ b: 1, a: [2, 1] }), '{"a":[2,1],"b":1}');
    assert.equal(canonicalJson({ a: undefined, b: null }), '{"b":null}');
  });

  test("the scripted stand-in is recognisable as synthetic", () => {
    assert.equal(isScriptedStandIn("scripted-stand-in (NOT a model)"), true);
    assert.equal(isScriptedStandIn("claude-sonnet-4-5-20250929"), false);
    assert.equal(isScriptedStandIn(null), false);
  });
});

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "invariant-fp-test-"));
}

/** The schema exactly as the gate milestone left it: everything but deployment_fingerprints. */
function preFingerprintSchema(): string {
  const stripped = SCHEMA_SQL.replace(/create table if not exists deployment_fingerprints \([\s\S]*?\);\n/, "");
  assert.notEqual(stripped, SCHEMA_SQL, "test setup: fingerprint table found and removed");
  return stripped;
}

describe("deployment fingerprints in the store", () => {
  test("an existing trace.db gains the table in place; its old runs keep a null fingerprint", () => {
    const root = tmpRoot();
    try {
      const db = new Database(path.join(root, "trace.db"));
      db.exec(preFingerprintSchema());
      db.exec(`
        insert into tasks values ('t1','old','p','r','[]','[]','[]','{}',null,'2026-09-19T00:00:00Z');
        insert into variants values ('v1','t1','v1','x',1,null,null);
        insert into batches (id, task_id, tier, trials_per_variant, variants_requested, variant_labels, created_at, finished_at)
          values ('b1','t1','smoke',1,1,'["v1"]','2026-09-19T00:00:00Z','2026-09-19T00:01:00Z');
        insert into runs (id, task_id, variant_id, batch_id, trial_number, status, created_at)
          values ('r1','t1','v1','b1',1,'ok','2026-09-19T00:00:00Z');
      `);
      assert.equal(db.prepare("select name from sqlite_master where name = 'deployment_fingerprints'").get(), undefined);
      db.close();

      // A read-only open refuses the outdated store instead of migrating it.
      assert.throws(() => openTraceStore({ root, readonly: true }), (err: unknown) => {
        assert.ok(err instanceof StoreOutdatedError);
        assert.deepEqual(err.missing, ["deployment_fingerprints"]);
        return true;
      });

      const store = openTraceStore({ root });
      try {
        assert.equal(store.getRun("r1")!.deployment_fingerprint, null);
        assert.deepEqual(store.getBatchFingerprints("b1"), [{ hash: null, runs: 1 }]);
        assert.deepEqual(store.listDeploymentFingerprints(), []);

        const fp = computeDeploymentFingerprint(BASE);
        store.recordDeploymentFingerprint(fp);
        const r2 = store.recordRun({ task_id: "t1", variant_id: "v1", trial_number: 2, batch_id: "b1" });
        store.setRunFingerprint(r2, fp.hash);
        const row = store.getDeploymentFingerprint(fp.hash)!;
        assert.equal(row.model_version, BASE.model_version);
        assert.equal(row.system_prompt, BASE.system_prompt);
        assert.deepEqual(JSON.parse(row.tool_schema_json), TOOLS.map((t) => JSON.parse(canonicalJson(t))));
        assert.ok(row.first_seen_at);
        // The pre-existing run is not backfilled.
        assert.equal(store.getRun("r1")!.deployment_fingerprint, null);
      } finally {
        store.close();
      }
      // Re-opening is a no-op, and the migrated store now opens read-only.
      openTraceStore({ root }).close();
      const ro = openTraceStore({ root, readonly: true });
      try {
        assert.equal(ro.listDeploymentFingerprints().length, 1);
        assert.throws(() => ro.recordDeploymentFingerprint(computeDeploymentFingerprint({ ...BASE, model_name: "x" })), /readonly/i);
      } finally {
        ro.close();
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("recording is content-addressed, and a batch with two fingerprints shows both", () => {
    const root = tmpRoot();
    const store = openTraceStore({ root });
    try {
      const taskId = store.upsertTask({ name: "t", prompt_template: "p", success_rubric: "r", thresholds: {} });
      const variantId = store.upsertVariant({ task_id: taskId, label: "v1", phrasing_text: "x", fixture_version: 1 });
      const batchId = store.createBatch({ task_id: taskId, tier: "smoke", trials_per_variant: 4, variants_requested: 1, variant_labels: ["v1"] });
      const a = computeDeploymentFingerprint(BASE);
      const b = computeDeploymentFingerprint({ ...BASE, model_version: "claude-sonnet-4-5-20260101" });
      assert.equal(store.recordDeploymentFingerprint(a), a.hash);
      const firstSeen = store.getDeploymentFingerprint(a.hash)!.first_seen_at;
      store.recordDeploymentFingerprint(a); // no duplicate, first_seen_at kept
      store.recordDeploymentFingerprint(b);
      assert.equal(store.listDeploymentFingerprints().length, 2);
      assert.equal(store.getDeploymentFingerprint(a.hash)!.first_seen_at, firstSeen);

      const hashes = [a.hash, a.hash, b.hash, null];
      hashes.forEach((h, i) => {
        const run = store.recordRun({ task_id: taskId, variant_id: variantId, trial_number: i + 1, batch_id: batchId });
        if (h) store.setRunFingerprint(run, h);
      });
      assert.deepEqual(store.getBatchFingerprints(batchId), [
        { hash: a.hash, runs: 2 },
        { hash: b.hash, runs: 1 },
        { hash: null, runs: 1 },
      ]);
      assert.throws(() => store.setRunFingerprint("nope", a.hash), /no run/);
      assert.throws(() => store.setRunFingerprint(store.getBatchRuns(batchId)[0]!.id, "f".repeat(64)), /not recorded/);
    } finally {
      store.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("a read-only open of a missing store says so and creates nothing", () => {
    const root = path.join(tmpRoot(), "absent");
    assert.throws(() => openTraceStore({ root, readonly: true }), StoreNotFoundError);
    assert.equal(fs.existsSync(root), false);
  });
});

describe("fingerprint formula versions (v1 -> v2: provider and endpoint)", () => {
  /** BASE hashed by the v1 code as it shipped (commit b3d4a9c); pinned so v1 hashes can never drift. */
  const V1_BASE_HASH = "ff8d30ae842849146dc9f45840bdbeb8681b8a1c8cf507ecc95980ea562372e6";

  test("the v1 formula is kept exactly; v2 is a different hash for the same components", () => {
    const v1 = computeDeploymentFingerprintV1(BASE);
    assert.equal(v1.hash, V1_BASE_HASH);
    assert.equal(v1.fingerprint_version, 1);
    const v2 = computeDeploymentFingerprint({ ...BASE, provider: "anthropic", endpoint: "api.anthropic.com" });
    assert.equal(v2.fingerprint_version, 2);
    assert.notEqual(v2.hash, v1.hash);
  });

  test("provider and endpoint are components: a change in either changes the hash and is named", () => {
    const base = computeDeploymentFingerprint({ ...BASE, provider: "groq", endpoint: "api.groq.com" });
    const other = computeDeploymentFingerprint({ ...BASE, provider: "together", endpoint: "api.groq.com" });
    const moved = computeDeploymentFingerprint({ ...BASE, provider: "groq", endpoint: "localhost:8000" });
    assert.deepEqual(changedComponents(base, other), ["provider"]);
    assert.deepEqual(changedComponents(base, moved), ["endpoint"]);
    assert.notEqual(base.hash, other.hash);
    assert.notEqual(base.hash, moved.hash);
  });

  test("the endpoint is stored as host[:port] only, never a path or credentials", () => {
    assert.equal(normalizeEndpoint("https://user:secret@api.example.com:8443/v1?key=abc"), "api.example.com:8443");
    assert.equal(normalizeEndpoint("localhost:11434"), "localhost:11434");
    assert.equal(normalizeEndpoint(""), null);
    const fp = computeDeploymentFingerprint({ ...BASE, provider: "openai", endpoint: "https://k:s@api.openai.com/v1" });
    assert.equal(fp.endpoint, "api.openai.com");
  });

  test("v1 vs v2 of the same deployment is a formula change, not a deployment change", () => {
    const v1 = computeDeploymentFingerprintV1(BASE);
    const v2 = computeDeploymentFingerprint({ ...BASE, provider: "anthropic", endpoint: "api.anthropic.com" });
    const same = compareDeployments(v1, v2);
    assert.deepEqual(same.changed, []);
    assert.deepEqual(same.unrecorded, ["provider", "endpoint"]);
    assert.equal(same.formula_changed, true);
    assert.equal(same.formula_only, true);
    // A real change across the formula boundary is still a change, and named.
    const real = compareDeployments(v1, computeDeploymentFingerprint({ ...BASE, model_version: "claude-sonnet-4-5-20260101", provider: "anthropic" }));
    assert.deepEqual(real.changed, ["model_version"]);
    assert.equal(real.formula_only, false);
  });

  test("migration: a v1 store keeps its hashes, gains the columns, and a v1+v2 batch is not 'mixed'", () => {
    const root = tmpRoot();
    try {
      // The deployment_fingerprints table exactly as v1 shipped it, with one v1 row.
      const db = new Database(path.join(root, "trace.db"));
      db.exec(preFingerprintSchema());
      db.exec(`create table deployment_fingerprints (
        hash text primary key, model_name text not null, model_version text not null, system_prompt_hash text,
        tool_schema_hash text not null, system_prompt text, tool_schema_json text not null, first_seen_at text not null);`);
      const v1 = computeDeploymentFingerprintV1(BASE);
      db.prepare(
        `insert into deployment_fingerprints values (@hash, @model_name, @model_version, @system_prompt_hash, @tool_schema_hash, @system_prompt, @tool_schema_json, '2026-09-19T00:00:00Z')`
      ).run(v1);
      db.exec(`
        insert into tasks values ('t1','old','p','r','[]','[]','[]','{}',null,'2026-09-19T00:00:00Z');
        insert into variants values ('v1','t1','v1','x',1,null,null);
        insert into batches (id, task_id, tier, trials_per_variant, variants_requested, variant_labels, created_at, finished_at)
          values ('b1','t1','smoke',2,1,'["v1"]','2026-09-19T00:00:00Z','2026-09-19T00:01:00Z');
        insert into runs (id, task_id, variant_id, batch_id, trial_number, status, created_at, deployment_fingerprint)
          values ('r1','t1','v1','b1',1,'ok','2026-09-19T00:00:00Z','${v1.hash}');
      `);
      db.close();

      assert.throws(() => openTraceStore({ root, readonly: true }), (err: unknown) => {
        assert.ok(err instanceof StoreOutdatedError);
        assert.deepEqual(err.missing, ["deployment_fingerprints.fingerprint_version", "deployment_fingerprints.provider", "deployment_fingerprints.endpoint"]);
        return true;
      });

      const store = openTraceStore({ root });
      try {
        const old = store.getDeploymentFingerprint(v1.hash)!;
        assert.equal(old.fingerprint_version, 1, "an existing row is a v1 fingerprint");
        assert.equal(old.provider, null);
        assert.equal(old.endpoint, null);
        assert.equal(store.getRun("r1")!.deployment_fingerprint, V1_BASE_HASH, "the stored hash is left as it is");

        // Same deployment, next run, recorded under v2.
        const v2 = computeDeploymentFingerprint({ ...BASE, provider: "anthropic", endpoint: "api.anthropic.com" });
        store.recordDeploymentFingerprint(v2);
        const r2 = store.recordRun({ task_id: "t1", variant_id: "v1", trial_number: 2, batch_id: "b1" });
        store.setRunFingerprint(r2, v2.hash);
        const row = store.getDeploymentFingerprint(v2.hash)!;
        assert.equal(row.fingerprint_version, 2);
        assert.equal(row.provider, "anthropic");
        assert.equal(row.endpoint, "api.anthropic.com");

        const d = store.getBatchDeployment("b1");
        assert.equal(d.fingerprints.length, 2);
        assert.equal(d.mixed, false, "a formula change is not a mid-batch deployment change");
        assert.equal(d.formula_only, true);
        assert.deepEqual(d.formula_versions, [1, 2]);
        assert.deepEqual(d.changed, []);

        // A v2 fingerprint that really differs makes the batch mixed again.
        const v2b = computeDeploymentFingerprint({ ...BASE, provider: "openai", endpoint: "api.openai.com", model_name: "gpt-4.1", model_version: "gpt-4.1-2025-04-14" });
        store.recordDeploymentFingerprint(v2b);
        const r3 = store.recordRun({ task_id: "t1", variant_id: "v1", trial_number: 3, batch_id: "b1" });
        store.setRunFingerprint(r3, v2b.hash);
        const d2 = store.getBatchDeployment("b1");
        assert.equal(d2.mixed, true);
        // Against the batch's first (v1) fingerprint, provider/endpoint were never recorded,
        // so only the model components can be named as changed.
        assert.deepEqual(d2.changed, ["model_name", "model_version"]);
      } finally {
        store.close();
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
