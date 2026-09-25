import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { selectTier } from "./tier.js";
import { loadAllTasks, loadValidTask } from "./load-tasks.js";
import type { TaskSpec } from "../schema/task-spec.js";
import type { VariantFixture } from "../schema/variant-fixture.js";

function spec(execution: Partial<TaskSpec["execution"]>): TaskSpec {
  return {
    execution: {
      max_wall_clock_seconds: 60,
      trials_smoke: 2,
      trials_full: 10,
      variants_smoke: 2,
      variants_full: 8,
      ...execution,
    },
  } as TaskSpec;
}

function fixture(n: number): VariantFixture {
  return {
    task: "t",
    fixture_version: 1,
    generated_at: "2026-09-19T00:00:00Z",
    approved_by: "test",
    // Deliberately not in label order, to show selection follows fixture order, not ids.
    variants: Array.from({ length: n }, (_, i) => ({ id: `v${n - i}`, text: `phrasing ${n - i}` })),
  };
}

describe("selectTier", () => {
  test("uses the tier's trial and variant counts from the spec", () => {
    const smoke = selectTier(spec({}), fixture(10), "smoke");
    assert.equal(smoke.trials, 2);
    assert.equal(smoke.variants.length, 2);
    const full = selectTier(spec({}), fixture(10), "full");
    assert.equal(full.trials, 10);
    assert.equal(full.variants.length, 8);
    assert.equal(full.shortfall, 0);
  });

  test("takes the first N variants in fixture order, deterministically", () => {
    const f = fixture(6);
    const a = selectTier(spec({ variants_full: 4 }), f, "full");
    const b = selectTier(spec({ variants_full: 4 }), f, "full");
    assert.deepEqual(a.variants.map((v) => v.id), ["v6", "v5", "v4", "v3"]);
    assert.deepEqual(a.variants, b.variants);
    // Smoke is a prefix of full, so the cheap tier always measures phrasings the full tier also covers.
    const smoke = selectTier(spec({ variants_full: 4 }), f, "smoke");
    assert.deepEqual(smoke.variants, a.variants.slice(0, smoke.variants.length));
  });

  test("runs every variant of a short fixture and reports the shortfall instead of padding", () => {
    const s = selectTier(spec({ variants_full: 8 }), fixture(5), "full");
    assert.equal(s.variants.length, 5);
    assert.equal(new Set(s.variants.map((v) => v.id)).size, 5);
    assert.equal(s.variants_requested, 8);
    assert.equal(s.shortfall, 3);
  });

  test("the committed example tasks resolve to the counts their specs declare", () => {
    const tasks = loadAllTasks().map((t) => loadValidTask(t.name));
    assert.ok(tasks.length >= 3);
    for (const task of tasks) {
      for (const tier of ["smoke", "full"] as const) {
        const s = selectTier(task.spec, task.fixture!, tier);
        const e = task.spec.execution;
        assert.equal(s.trials, tier === "smoke" ? e.trials_smoke : e.trials_full, `${task.name} ${tier}`);
        assert.equal(
          s.variants.length,
          Math.min(tier === "smoke" ? e.variants_smoke : e.variants_full, task.fixture!.variants.length)
        );
        assert.deepEqual(s.variants, task.fixture!.variants.slice(0, s.variants.length));
      }
    }
  });
});
