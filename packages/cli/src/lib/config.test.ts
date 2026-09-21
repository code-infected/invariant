import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { loadConfig, parseConfig } from "./config.js";

describe("invariant.config.yaml", () => {
  test("the committed config parses and carries the retry policy and concurrency", () => {
    const config = loadConfig();
    assert.ok(config.providers.retry.max_attempts >= 1);
    assert.ok(config.providers.retry.retry_on.length > 0);
    assert.ok(config.execution.worker_concurrency >= 1);
    assert.ok(["smoke", "full"].includes(config.execution.default_tier));
  });

  test("keeps keys nothing reads yet instead of rejecting them", () => {
    const result = parseConfig(`
providers: { retry: { max_attempts: 2, retry_on: [429, "timeout"] } }
execution: { worker_concurrency: 4, default_tier: full }
judge: { votes: 3 }
`);
    assert.ok(result.ok);
    if (result.ok) {
      assert.deepEqual(result.config.providers.retry.retry_on, [429, "timeout"]);
      assert.equal((result.config as Record<string, unknown>).judge !== undefined, true);
    }
  });

  test("rejects values the fan-out cannot use", () => {
    const bad = parseConfig(`
providers: { retry: { max_attempts: 0, retry_on: [429, "sometimes"] } }
execution: { worker_concurrency: 0, default_tier: nightly }
`);
    assert.equal(bad.ok, false);
    if (!bad.ok) {
      const text = bad.errors.join("\n");
      for (const key of ["max_attempts", "retry_on", "worker_concurrency", "default_tier"]) {
        assert.match(text, new RegExp(key));
      }
    }
    assert.equal(parseConfig("execution: [").ok, false);
  });
});
