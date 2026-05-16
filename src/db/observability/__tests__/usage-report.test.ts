import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LuxDatabase } from '../../index.js';
import { buildUsageReport } from '../usage-report.js';
import { emitUsageEvent } from '../usage-event.js';

describe('usage observability report', () => {
  it('distinguishes retrieval refusal, fallback, and final command success', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lux-usage-report-'));
    const db = new LuxDatabase(join(dir, 'lux.db'));

    try {
      const invocationId = 'invocation-one';
      emitUsageEvent(db, {
        source: 'cli',
        surface: 'feature-path',
        action: 'ask',
        invocationId,
        commandOutcome: 'error',
        retrievalOutcome: 'unresolved',
        trustState: 'fresh',
        queryText: 'what handles GET /missing?',
      });
      emitUsageEvent(db, {
        source: 'cli',
        surface: 'expert-panel',
        action: 'ask',
        invocationId,
        commandOutcome: 'success',
        retrievalOutcome: 'fallback',
        queryText: 'what handles GET /missing?',
        retrieval: { fallbackSurface: 'expert-panel' },
      });

      const report = buildUsageReport(db.getRecentEvents(100));

      expect(report.totals).toEqual({ invocations: 1, events: 2 });
      expect(report.commandOutcomes).toMatchObject({ error: 1, success: 1 });
      expect(report.retrievalOutcomes).toMatchObject({ unresolved: 1, fallback: 1 });
      expect(report.trustStates).toMatchObject({ fresh: 1 });
      expect(report.fallbacks).toEqual([{ from: 'expert-panel', to: 'expert-panel', count: 1 }]);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('clusters repeated unresolved hashes as benchmark candidates without raw query text', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lux-usage-candidates-'));
    const db = new LuxDatabase(join(dir, 'lux.db'));

    try {
      for (const invocationId of ['one', 'two']) {
        emitUsageEvent(db, {
          source: 'cli',
          surface: 'operational',
          action: 'ask',
          invocationId,
          commandOutcome: 'error',
          retrievalOutcome: 'unresolved',
          queryText: 'what dispatches MissingJob?',
        });
      }

      const report = buildUsageReport(db.getRecentEvents(100));

      expect(report.benchmarkCandidates).toHaveLength(1);
      expect(report.benchmarkCandidates[0]).toMatchObject({
        surface: 'operational',
        reason: 'repeated_unresolved',
        count: 2,
      });
      expect(report.benchmarkCandidates[0].intentHash).toMatch(/^sha256:/);

      const events = db.getRecentEvents(10);
      expect(events.every((event) => !event.payload?.includes('what dispatches MissingJob'))).toBe(
        true
      );
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
