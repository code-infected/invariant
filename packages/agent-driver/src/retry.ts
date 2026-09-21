import type { TrialResult } from "./run-trial.js";

/**
 * Which failures get retried, as configured in invariant.config.yaml under
 * providers.retry. The config is parsed and validated by @invariant/cli; this package
 * takes the resolved values so it never reads YAML itself.
 */
export interface RetryPolicy {
  /** Total attempts per (variant, trial) cell, including the first. 1 disables retries. */
  max_attempts: number;
  /**
   * HTTP statuses to retry, plus the token "timeout" for provider failures that never got
   * an HTTP response at all (connection dropped, request timed out in transit).
   */
  retry_on: Array<number | "timeout">;
}

/**
 * Whether a finished attempt is an infra flake that should be retried.
 *
 * Only a provider-classified failure (ProviderInfraError) whose status is on the retry
 * list qualifies. Everything else is final on the first attempt:
 *
 *   - ok / timeout: the agent produced a behavioural answer (hitting the task's own wall
 *     clock or turn limit is behaviour too, see ARCHITECTURE.md section 7). Retrying one
 *     of these would be re-rolling the exact variance the harness exists to measure.
 *   - provider_rejected (400, 401, 404) and harness errors (a proxy crash, a bug): not
 *     transient, and retrying them just spends the same failure three times.
 *   - provider failures whose status is not on retry_on: the config is the contract.
 */
export function isRetryableInfraFailure(result: Pick<TrialResult, "status" | "error">, policy: RetryPolicy): boolean {
  if (result.status !== "infra_error" || result.error?.kind !== "provider") return false;
  const status = result.error.http_status;
  if (status === undefined) return policy.retry_on.includes("timeout");
  return policy.retry_on.includes(status);
}

export const BACKOFF_BASE_MS = 1_000;
export const BACKOFF_CAP_MS = 30_000;
/** A retry-after longer than this is not waited out; the attempt waits the cap instead. */
export const RETRY_AFTER_CAP_MS = 60_000;

/**
 * Delay before attempt `nextAttempt` (2, 3, ...). Exponential with "equal jitter" so a
 * fan-out that got rate-limited all at once does not retry all at once, and never less
 * than what the provider asked for via retry-after.
 */
export function backoffDelayMs(nextAttempt: number, retryAfterMs?: number, random: () => number = Math.random): number {
  const exp = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, nextAttempt - 2));
  const jittered = exp / 2 + random() * (exp / 2);
  const floor = retryAfterMs === undefined ? 0 : Math.min(retryAfterMs, RETRY_AFTER_CAP_MS);
  return Math.round(Math.max(jittered, floor));
}
