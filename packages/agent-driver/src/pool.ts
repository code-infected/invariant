/**
 * Run `worker` over `items` with at most `limit` in flight at once, returning results in
 * input order.
 *
 * This is the local stand-in for the worker pool in ARCHITECTURE.md (a Python/FastAPI
 * service scaled by queue depth). In-process is enough here because the expensive parts
 * of a trial are already out of process: each trial spawns its own proxy and tool server,
 * and the model call is network I/O. What the pool has to guarantee is the bound, so a
 * full tier does not open 80 proxies and 80 concurrent API streams at once.
 *
 * A worker that throws rejects the whole run after in-flight items settle; callers that
 * want per-item failure handling (batch.ts does) catch inside the worker.
 */
export async function runWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`concurrency limit must be a positive integer, got ${limit}`);
  }
  const results = new Array<R>(items.length);
  let next = 0;
  let failure: { error: unknown } | null = null;

  async function lane(): Promise<void> {
    while (failure === null && next < items.length) {
      const index = next++;
      try {
        results[index] = await worker(items[index]!, index);
      } catch (error) {
        failure ??= { error };
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  if (failure !== null) throw (failure as { error: unknown }).error;
  return results;
}
