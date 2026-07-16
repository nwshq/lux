// Bounded-concurrency mapping helper for the enrichment pipeline.
//
// The enrichment loop must never read all files into closures at once (52k in
// the pack build spikes memory) nor flush unbounded work at the LSP server.
// `mapWithConcurrency` runs at most `limit` tasks in flight while preserving
// input order in the results, so callers can parallelize a per-file loop
// without hand-rolling a worker pool. The `didOpen` cap itself lives in the
// LspClient's open-document semaphore (see client.ts `withDocument`); this
// helper only bounds how many file tasks are constructed and awaited at once.

/**
 * Run `fn` over `items` with at most `limit` tasks in flight; preserves input
 * order in the results array. `limit` is clamped to `items.length` (and a
 * non-positive limit runs a single worker) so an empty input is a no-op.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workerCount = Math.min(Math.max(1, limit), items.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}
