import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { cosineSimilarity, JudgeUnavailableError, scoreOutcome, type JudgeFn } from "./outcome.js";
import { run } from "./test-helpers.js";

/**
 * A rule-based stand-in for the judge, for testing clustering only: it declares two
 * answers equivalent iff they carry the same bracketed tag, e.g. "[deny] ...". Every call
 * is recorded so the tests can check which pairs reached the judge.
 */
function taggedJudge(): { judge: JudgeFn; calls: Array<[string, string]> } {
  const calls: Array<[string, string]> = [];
  const tag = (s: string) => /^\[(\w+)\]/.exec(s)?.[1];
  return {
    calls,
    judge: async (a, b) => {
      calls.push([a, b]);
      const same = tag(a) !== undefined && tag(a) === tag(b);
      return { equivalent: same, votes: same ? ["same", "same", "same"] : ["different", "different", "different"] };
    },
  };
}

describe("outcome consistency", () => {
  test("identical answers need no judge and score 1", async () => {
    const result = await scoreOutcome([run("r1", [], "No."), run("r2", [], "  No.\n"), run("r3", [], "No.")], "rubric");
    assert.equal(result.score, 1);
    assert.equal(result.nodes.length, 1);
    assert.equal(result.judged_pairs, 0);
  });

  test("3 deny / 2 approve clusters to 3/5 = 0.6", async () => {
    const { judge, calls } = taggedJudge();
    const runs = [
      run("r1", [], "[deny] Order 1234 was already refunded on 12 Sept."),
      run("r2", [], "[approve] Done, I refunded $42."),
      run("r3", [], "[deny] That order already has a refund, so I did not issue another."),
      run("r4", [], "[approve] Refund of $42.00 processed."),
      run("r5", [], "[deny] Already refunded, nothing to do."),
    ];
    const result = await scoreOutcome(runs, "rubric", { judge });
    assert.equal(result.score, 0.6);
    assert.deepEqual(result.clusters.map((c) => c.run_ids.sort()), [["r1", "r3", "r5"], ["r2", "r4"]]);
    // 5 distinct answers = 10 pairs. Transitivity skips pairs already in one cluster, but
    // every cross-cluster pair must be judged: 6 cross pairs + at most 3 within-deny + 1
    // within-approve, fewer than 10 whenever a skip happened.
    assert.ok(calls.length < 10, `expected skipped pairs, judged ${calls.length}`);
    assert.equal(result.decisions.filter((d) => d.via === "judge" && d.equivalent === false).length, 6);
    assert.equal(result.decisions.length, 10);
  });

  test("equivalence chains through connected components", async () => {
    // Judge says A~B and B~C but not A~C: one cluster of 3.
    const judge: JudgeFn = async (a, b) => {
      const pair = [a, b].sort().join("|");
      const eq = pair === "A|B" || pair === "B|C";
      return { equivalent: eq, votes: [] };
    };
    const result = await scoreOutcome([run("1", [], "A"), run("2", [], "B"), run("3", [], "C"), run("4", [], "D")], "r", { judge });
    assert.equal(result.score, 0.75);
  });

  test("the rubric is passed through to the judge", async () => {
    let seen = "";
    await scoreOutcome([run("1", [], "x"), run("2", [], "y")], "the task rubric", {
      judge: async (_a, _b, rubric) => {
        seen = rubric;
        return { equivalent: true, votes: [] };
      },
    });
    assert.equal(seen, "the task rubric");
  });

  test("timeouts form their own outcome, never equivalent to an answer, and never judged", async () => {
    const { judge, calls } = taggedJudge();
    const result = await scoreOutcome(
      [run("1", [], "[deny] no"), run("2", [], null, "timeout"), run("3", [], "partial text", "timeout"), run("4", [], "[deny] no")],
      "r",
      { judge }
    );
    assert.equal(result.score, 0.5);
    assert.equal(calls.length, 0);
    assert.ok(result.decisions.some((d) => d.via === "status" && d.equivalent === false));
  });

  test("with no judge, differing answers are an error, not a guess", async () => {
    await assert.rejects(scoreOutcome([run("1", [], "a"), run("2", [], "b")], "r"), JudgeUnavailableError);
  });

  test("embedding pre-filter: above high is auto-equivalent, below low auto-different, only the band is judged", async () => {
    // Hand-built vectors, not a model: this checks the band logic only.
    const vectors: Record<string, number[]> = {
      a1: [1, 0, 0],
      a2: [0.99, 0.141, 0], // cos(a1,a2) ~ 0.99  -> equivalent
      b: [0, 1, 0], // cos(a1,b) = 0, cos(a2,b) ~ 0.14 -> different
      m: [0.6, 0, 0.8], // cos(a1,m) = 0.6, cos(a2,m) ~ 0.59 -> band; cos(b,m) = 0 -> different
    };
    const judgeCalls: Array<[string, string]> = [];
    const result = await scoreOutcome(
      [run("1", [], "a1"), run("2", [], "a2"), run("3", [], "b"), run("4", [], "m")],
      "r",
      {
        embed: async (texts) => texts.map((t) => vectors[t]!),
        judge: async (x, y) => {
          judgeCalls.push([x, y]);
          return { equivalent: true, votes: [] };
        },
      }
    );
    assert.equal(result.prefilter, "embedding");
    assert.equal(result.decisions.filter((d) => d.via === "embedding_high").length, 1);
    assert.equal(result.decisions.filter((d) => d.via === "embedding_low").length, 3);
    // a1-m is judged (equivalent), after which a2-m is already in the same cluster.
    assert.equal(judgeCalls.length, 1);
    assert.equal(result.decisions.filter((d) => d.via === "same_cluster").length, 1);
    assert.equal(result.score, 0.75);
  });

  test("cosine similarity", () => {
    assert.equal(cosineSimilarity([1, 0], [1, 0]), 1);
    assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
    assert.ok(Math.abs(cosineSimilarity([1, 1], [1, 0]) - Math.SQRT1_2) < 1e-12);
    assert.throws(() => cosineSimilarity([1], [1, 2]));
  });
});
