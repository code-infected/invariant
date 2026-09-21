import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { runWithConcurrency } from "./pool.js";

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("runWithConcurrency", () => {
  test("never has more than `limit` workers in flight, and uses all of them", async () => {
    for (const limit of [1, 3, 8]) {
      let inFlight = 0;
      let peak = 0;
      const items = Array.from({ length: 25 }, (_, i) => i);
      await runWithConcurrency(items, limit, async (i) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await tick(2 + (i % 4) * 3);
        inFlight--;
      });
      assert.equal(peak, limit, `limit ${limit}`);
    }
  });

  test("returns results in input order regardless of completion order", async () => {
    const out = await runWithConcurrency([30, 5, 20, 1], 4, async (ms, i) => {
      await tick(ms);
      return i;
    });
    assert.deepEqual(out, [0, 1, 2, 3]);
  });

  test("handles fewer items than the limit, and no items", async () => {
    assert.deepEqual(await runWithConcurrency([1, 2], 8, async (x) => x * 2), [2, 4]);
    assert.deepEqual(await runWithConcurrency([], 8, async (x) => x), []);
  });

  test("rejects a non-positive limit and propagates a worker's throw", async () => {
    await assert.rejects(runWithConcurrency([1], 0, async (x) => x), /positive integer/);
    await assert.rejects(
      runWithConcurrency([1, 2, 3], 2, async (x) => {
        if (x === 2) throw new Error("boom");
        return x;
      }),
      /boom/
    );
  });
});
