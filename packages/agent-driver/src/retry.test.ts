import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { backoffDelayMs, isRetryableInfraFailure, RETRY_AFTER_CAP_MS, type RetryPolicy } from "./retry.js";
import { parseRetryAfter } from "./anthropic.js";

const policy: RetryPolicy = { max_attempts: 3, retry_on: [429, 503, "timeout"] };
const provider = (http_status?: number) => ({
  status: "infra_error" as const,
  error: { kind: "provider" as const, message: "x", ...(http_status === undefined ? {} : { http_status }) },
});

describe("isRetryableInfraFailure", () => {
  test("retries provider failures whose status is on retry_on", () => {
    assert.equal(isRetryableInfraFailure(provider(429), policy), true);
    assert.equal(isRetryableInfraFailure(provider(503), policy), true);
  });

  test("treats a provider failure with no HTTP response as the 'timeout' class", () => {
    assert.equal(isRetryableInfraFailure(provider(undefined), policy), true);
    assert.equal(isRetryableInfraFailure(provider(undefined), { ...policy, retry_on: [429] }), false);
  });

  test("does not retry provider statuses the config does not list", () => {
    assert.equal(isRetryableInfraFailure(provider(529), policy), false);
    assert.equal(isRetryableInfraFailure(provider(500), policy), false);
  });

  test("never retries a behavioural outcome or a harness error", () => {
    assert.equal(isRetryableInfraFailure({ status: "ok", error: undefined }, policy), false);
    assert.equal(isRetryableInfraFailure({ status: "timeout", error: undefined }, policy), false);
    assert.equal(
      isRetryableInfraFailure({ status: "infra_error", error: { kind: "harness", message: "proxy exited" } }, policy),
      false
    );
    // Even when the rejected status happens to be on retry_on, a rejection is not infra.
    assert.equal(
      isRetryableInfraFailure(
        { status: "infra_error", error: { kind: "provider_rejected", message: "401", http_status: 429 } },
        policy
      ),
      false
    );
  });
});

describe("backoffDelayMs", () => {
  test("grows exponentially with jitter between half and all of the step", () => {
    assert.equal(backoffDelayMs(2, undefined, () => 0), 500);
    assert.equal(backoffDelayMs(2, undefined, () => 1), 1000);
    assert.equal(backoffDelayMs(3, undefined, () => 0), 1000);
    assert.equal(backoffDelayMs(3, undefined, () => 1), 2000);
    assert.equal(backoffDelayMs(20, undefined, () => 1), 30_000);
  });

  test("waits at least what retry-after asked for, up to a cap", () => {
    assert.equal(backoffDelayMs(2, 7_000, () => 0), 7_000);
    assert.equal(backoffDelayMs(2, 10 * 60_000, () => 0), RETRY_AFTER_CAP_MS);
  });
});

describe("parseRetryAfter", () => {
  test("accepts delta-seconds and HTTP dates, ignores junk", () => {
    assert.equal(parseRetryAfter("3"), 3000);
    assert.equal(parseRetryAfter("0.5"), 500);
    assert.equal(parseRetryAfter("Wed, 21 Oct 2026 07:28:10 GMT", Date.parse("Wed, 21 Oct 2026 07:28:00 GMT")), 10_000);
    assert.equal(parseRetryAfter("soon"), undefined);
    assert.equal(parseRetryAfter(null), undefined);
  });
});
