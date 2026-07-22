// Fix #8 (Decision 6 acceptance): runDeltaCli's single committed exit idiom. On a refusal that
// surfaces from inside computeDelta (here: a non-git corpus → not-a-git-repo), the CLI must still
// (a) emit the `delta` usage event, (b) run db.close() via `finally`, and (c) NEVER call
// process.exit() mid-flow — it sets process.exitCode and returns.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Command } from 'commander';
import { LuxDatabase } from '../../../db/index.js';
import { runDeltaCli } from '../run.js';

let root: string;
let dbPath: string;
let prevExitCode: typeof process.exitCode;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'lux-delta-runcli-'));
  // A valid, current-schema index in a directory that is NOT a git repo.
  dbPath = join(root, 'plain', '.lux', 'lux.db');
  const seed = new LuxDatabase(dbPath); // autoMigrate → current schema
  seed.setIndexMetadata('last_indexed_commit', 'deadbeef');
  seed.close();
  prevExitCode = process.exitCode;
  process.exitCode = 0;
});

afterEach(() => {
  process.exitCode = prevExitCode;
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

describe('runDeltaCli exit idiom (Decision 6)', () => {
  it('on a computeDelta refusal: emits the usage event, closes the db, sets exitCode without process.exit()', () => {
    const corpus = join(root, 'plain'); // exists, but not a git repo → not-a-git-repo refusal
    const program = { opts: () => ({ corpus, db: dbPath }) } as unknown as Command;

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((): never => {
      throw new Error('process.exit() must not be called mid-flow');
    });
    const closeSpy = vi.spyOn(LuxDatabase.prototype, 'close');
    vi.spyOn(console, 'error').mockImplementation(() => {}); // silence the refusal print

    // --check turns not-a-git-repo into a hard refusal from inside computeDelta (analysis mode
    // would degrade it to an empty report). This is the refusal branch that still instruments +
    // closes (run.ts:208-225) — the Decision-6 acceptance path.
    runDeltaCli(program, {
      depth: 6,
      maxNodes: 2000,
      maxFanout: 64,
      minConfidence: 'framework-inferred',
      check: true,
      json: true,
    });

    expect(exitSpy).not.toHaveBeenCalled(); // no mid-flow exit
    expect(process.exitCode).toBe(1); // exit code set, not thrown
    expect(closeSpy).toHaveBeenCalled(); // finally { db.close() } ran

    // the delta usage event persisted before close → re-open and find it.
    const verify = new LuxDatabase(dbPath);
    const events = verify.getRecentEvents(20);
    verify.close();
    const usage = events.find(
      (e) => e.event_type === 'lux_usage_event' && (e.summary ?? '').startsWith('delta.')
    );
    expect(usage).toBeDefined();
    expect(usage?.summary).toContain('error'); // refusal → commandOutcome error
  });
});
