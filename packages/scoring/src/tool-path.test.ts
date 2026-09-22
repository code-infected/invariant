import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { levenshtein, pathSimilarity, scoreToolPath } from "./tool-path.js";
import { run } from "./test-helpers.js";

const close = (actual: number | null, expected: number) => {
  assert.ok(actual !== null && Math.abs(actual - expected) < 1e-12, `expected ${expected}, got ${actual}`);
};

describe("levenshtein over token sequences", () => {
  test("known distances", () => {
    assert.equal(levenshtein([], []), 0);
    assert.equal(levenshtein(["a", "b"], []), 2);
    assert.equal(levenshtein([], ["a"]), 1);
    assert.equal(levenshtein(["a", "b", "c"], ["a", "b", "c"]), 0);
    assert.equal(levenshtein(["a", "b", "c"], ["a", "x", "c"]), 1); // substitute
    assert.equal(levenshtein(["a", "c"], ["a", "b", "c"]), 1); // insert
    assert.equal(levenshtein(["a", "b", "c"], ["c", "b", "a"]), 2);
    // The classic string example, tokenised per character: kitten -> sitting is 3.
    assert.equal(levenshtein([..."kitten"], [..."sitting"]), 3);
  });

  test("tokens are whole tool names, not characters", () => {
    assert.equal(levenshtein(["lookup_order"], ["lookup_orders"]), 1);
  });
});

describe("tool-path consistency", () => {
  test("pair similarity is 1 - distance / longer length", () => {
    close(pathSimilarity(["L", "P", "R"], ["L", "C", "R"]), 2 / 3);
    assert.equal(pathSimilarity(["L", "P", "R"], ["L", "C", "P", "R"]), 0.75);
    assert.equal(pathSimilarity(["L"], ["C", "R"]), 0);
    assert.equal(pathSimilarity([], []), 1);
    assert.equal(pathSimilarity(["L"], []), 0);
  });

  test("identical paths score 1 regardless of arguments", () => {
    const result = scoreToolPath([
      run("r1", [["lookup_order", { order_id: "1234" }], ["reply_to_user", { message: "Already refunded." }]]),
      run("r2", [["lookup_order", { order_id: "1234" }], ["reply_to_user", { message: "This order was refunded on 12 Sept." }]]),
    ]);
    assert.equal(result.score, 1);
    assert.equal(result.distinct_paths.length, 1);
  });

  test("mean over all pairs: [LPR, LPR, LCR, LCR, LCPR] = 23/30", () => {
    const L = "lookup_order", C = "check_refund_history", P = "process_refund", R = "reply_to_user";
    const result = scoreToolPath([
      run("a1", [L, P, R]),
      run("b1", [L, C, R]),
      run("a2", [L, P, R]),
      run("b2", [L, C, R]),
      run("d", [L, C, P, R]),
    ]);
    // 10 pairs: a-a 1, b-b 1, four a-b at 2/3, two a-d at 3/4, two b-d at 3/4.
    // (2 + 8/3 + 3) / 10 = 23/30
    close(result.score, 23 / 30);
    assert.equal(result.pairs, 10);
    close(result.min_pair!.similarity, 2 / 3);
    assert.deepEqual(result.distinct_paths.map((p) => p.run_ids.length), [2, 2, 1]);
  });

  test("three-way disagreement: [A], [B], [A,B]", () => {
    // A vs B: 0. A vs AB: 1/2. B vs AB: 1/2. Mean 1/3.
    close(scoreToolPath([run("1", ["A"]), run("2", ["B"]), run("3", ["A", "B"])]).score, 1 / 3);
  });

  test("fewer than 2 runs: no score", () => {
    assert.equal(scoreToolPath([run("1", ["A"])]).score, null);
  });
});
