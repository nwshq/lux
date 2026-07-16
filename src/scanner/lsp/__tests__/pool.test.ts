// Lever B — the bounded-concurrency mapping helper, plus a parity guard that the
// pooled enrichment loop (general.ts step 6) produces the SAME result map as the
// original serial loop.

import { describe, it, expect } from 'vitest';
import { mapWithConcurrency } from '../pool.js';

function delay<T>(ms: number, value: T): Promise<T> {
  return new Promise((r) => setTimeout(() => r(value), ms));
}

describe('mapWithConcurrency', () => {
  it('preserves input order in the results regardless of completion order', async () => {
    const items = [30, 5, 20, 1, 15];
    // Longer inputs finish later, but results must stay in input order.
    const out = await mapWithConcurrency(items, 3, (ms) => delay(ms, ms));
    expect(out).toEqual(items);
  });

  it('never runs more than `limit` tasks in flight', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const items = Array.from({ length: 20 }, (_, i) => i);
    await mapWithConcurrency(items, 4, async (i) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await delay(2, i);
      inFlight--;
      return i;
    });
    expect(maxInFlight).toBeLessThanOrEqual(4);
    expect(maxInFlight).toBeGreaterThan(1); // actually parallelized
  });

  it('is a no-op for empty input', async () => {
    const calls: number[] = [];
    const out = await mapWithConcurrency([], 4, (i: number) => {
      calls.push(i);
      return Promise.resolve(i);
    });
    expect(out).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('runs a single worker when limit is non-positive', async () => {
    const out = await mapWithConcurrency([1, 2, 3], 0, (i) => Promise.resolve(i * 2));
    expect(out).toEqual([2, 4, 6]);
  });

  it('matches a serial enrichment loop (pooled vs serial parity)', async () => {
    const files = ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts'];
    // Fake enricher: deterministic result per file; some files "fail" (null).
    const enrich = (f: string) =>
      delay(Math.floor(Math.random() * 5), f === 'c.ts' ? null : { file: f, n: f.length });

    // Serial reference (the original step-6 shape).
    const serial = new Map<string, unknown>();
    for (const f of files) {
      const r = await enrich(f);
      if (r) serial.set(f, r);
    }

    // Pooled (the Lever-B shape).
    const pooled = new Map<string, unknown>();
    await mapWithConcurrency(files, 3, async (f) => {
      const r = await enrich(f);
      if (r) pooled.set(f, r);
    });

    expect([...pooled.keys()].sort()).toEqual([...serial.keys()].sort());
    for (const [k, v] of serial) expect(pooled.get(k)).toEqual(v);
    expect(pooled.has('c.ts')).toBe(false); // failed file skipped in both
  });
});
