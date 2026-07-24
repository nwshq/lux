// Usage-event emission for the overlay CLI surfaces that live in overlay.ts:
//   overlay-status / overlay-check / overlay-ownership / overlay-boundaries.
// The `overlay ... ask` surfaces (operational / feature-path / spec-evidence) are instrumented in
// their own command files and are covered elsewhere. These cases run against a freshly-created,
// empty index so both a success and an error/refusal emission are exercised per surface without a
// full rebuild. Same read-back shape as the search/anchors usage tests.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync, execSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LuxDatabase } from '../../db/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..', '..');
const CLI_ENTRY = join(PROJECT_ROOT, 'src', 'cli', 'index.ts');
const TSX_LOADER = join(PROJECT_ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs');

function runCli(corpus: string, dbPath: string, args: string[]) {
  return spawnSync(
    process.execPath,
    ['--import', TSX_LOADER, CLI_ENTRY, '--corpus', corpus, '--db', dbPath, ...args],
    { cwd: corpus, encoding: 'utf-8', env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' } }
  );
}

interface UsagePayload {
  surface: string;
  action: string;
  commandOutcome?: string;
  retrievalOutcome?: string;
  trustState?: string;
  exitCode?: number;
  attributes?: Record<string, unknown>;
  error?: { code?: string };
}

function readUsage(dbPath: string, surface: string): UsagePayload | undefined {
  const db = new LuxDatabase(dbPath);
  try {
    return (
      db
        .getRecentEvents(50)
        .map((e) =>
          e.event_type === 'lux_usage_event' && e.payload
            ? (JSON.parse(e.payload) as UsagePayload)
            : null
        )
        .find((p): p is UsagePayload => Boolean(p) && p!.surface === surface) ?? undefined
    );
  } finally {
    db.close();
  }
}

describe('lux overlay usage events', () => {
  let repoDir: string;
  let dbDir: string;
  let dbPath: string;

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), 'lux-overlay-usage-repo-'));
    dbDir = mkdtempSync(join(tmpdir(), 'lux-overlay-usage-db-'));
    dbPath = join(dbDir, 'lux.db');

    // A committed git tree keeps the status freshness assessment on its normal path.
    execSync('git init -q && git config user.email t@t.co && git config user.name T', {
      cwd: repoDir,
    });
    execSync('git commit -q --allow-empty -m init', { cwd: repoDir });

    // Materialize the events table (migrations run in the constructor); no overlay is recorded.
    new LuxDatabase(dbPath).close();
  });

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(dbDir, { recursive: true, force: true });
  });

  it('overlay status emits a success event with an absent trust state and n/a retrieval', () => {
    const res = runCli(repoDir, dbPath, ['overlay', 'status', '--json']);
    expect(res.status).toBe(0);

    const usage = readUsage(dbPath, 'overlay-status');
    expect(usage).toBeDefined();
    expect(usage!.commandOutcome).toBe('success');
    expect(usage!.retrievalOutcome).toBe('not_applicable');
    expect(usage!.trustState).toBe('absent');
    expect(usage!.attributes?.hasOverlay).toBe(false);
  });

  it('overlay check emits an error event (no-overlay) and exits 1', () => {
    const res = runCli(repoDir, dbPath, ['overlay', 'check']);
    expect(res.status).toBe(1);

    const usage = readUsage(dbPath, 'overlay-check');
    expect(usage).toBeDefined();
    expect(usage!.commandOutcome).toBe('error');
    expect(usage!.trustState).toBe('absent');
    expect(usage!.error?.code).toBe('no-overlay');
  });

  it('overlay ownership emits a success event (unresolved when there are no handler edges)', () => {
    const res = runCli(repoDir, dbPath, ['overlay', 'ownership']);
    expect(res.status).toBe(0);

    const usage = readUsage(dbPath, 'overlay-ownership');
    expect(usage).toBeDefined();
    expect(usage!.commandOutcome).toBe('success');
    expect(usage!.retrievalOutcome).toBe('unresolved');
    expect(usage!.attributes?.mode).toBe('single-index');
  });

  it('overlay boundaries show emits a success event (unresolved on an empty overlay)', () => {
    const res = runCli(repoDir, dbPath, ['overlay', 'boundaries', 'show']);
    expect(res.status).toBe(0);

    const usage = readUsage(dbPath, 'overlay-boundaries');
    expect(usage).toBeDefined();
    expect(usage!.commandOutcome).toBe('success');
    expect(usage!.retrievalOutcome).toBe('unresolved');
  });

  it('overlay boundaries show --top 0 emits a refusal event (invalid-top) and exits 1', () => {
    const res = runCli(repoDir, dbPath, ['overlay', 'boundaries', 'show', '--top', '0']);
    expect(res.status).toBe(1);

    const usage = readUsage(dbPath, 'overlay-boundaries');
    expect(usage).toBeDefined();
    expect(usage!.commandOutcome).toBe('error');
    expect(usage!.retrievalOutcome).toBe('refused');
    expect(usage!.error?.code).toBe('invalid-top');
  });
});
