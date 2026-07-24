// Usage-event emission for `lux deps *` (graph/clusters/impact/coverage). Mirrors the search/anchors
// usage-emission tests (usage-command.test.ts, trace-with.test.ts): spawn the CLI end-to-end, then
// open a fresh handle and read the `lux_usage_event` back off the events table.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
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
  exitCode?: number;
  attributes?: Record<string, unknown>;
  error?: { code?: string };
}

/** Latest usage event for a given surface, parsed off the events table. */
function readUsage(dbPath: string, surface: string): UsagePayload | undefined {
  const db = new LuxDatabase(dbPath);
  try {
    const event = db
      .getRecentEvents(50)
      .map((e) =>
        e.event_type === 'lux_usage_event' && e.payload
          ? (JSON.parse(e.payload) as UsagePayload)
          : null
      )
      .find((p): p is UsagePayload => Boolean(p) && p!.surface === surface);
    return event ?? undefined;
  } finally {
    db.close();
  }
}

describe('lux deps usage events', () => {
  let repoDir: string;
  let dbDir: string;
  let dbPath: string;

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), 'lux-deps-usage-repo-'));
    dbDir = mkdtempSync(join(tmpdir(), 'lux-deps-usage-db-'));
    dbPath = join(dbDir, 'lux.db');

    const db = new LuxDatabase(dbPath);
    db.insertModuleDependency({
      source_module: 'Users',
      target_module: 'Orders',
      reference_count: 10,
      sample_files: null,
    });
    db.insertModuleDependency({
      source_module: 'Billing',
      target_module: 'Orders',
      reference_count: 8,
      sample_files: null,
    });
    db.close();
  });

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(dbDir, { recursive: true, force: true });
  });

  it('emits a deps-graph success event (answered) with the module count', () => {
    const res = runCli(repoDir, dbPath, ['deps', 'graph']);
    expect(res.status).toBe(0);

    const usage = readUsage(dbPath, 'deps-graph');
    expect(usage).toBeDefined();
    expect(usage!.commandOutcome).toBe('success');
    expect(usage!.retrievalOutcome).toBe('answered');
    expect(usage!.attributes?.resultCount).toBe(3); // Users, Billing, Orders
  });

  it('emits a deps-clusters success event', () => {
    const res = runCli(repoDir, dbPath, ['deps', 'clusters']);
    expect(res.status).toBe(0);

    const usage = readUsage(dbPath, 'deps-clusters');
    expect(usage).toBeDefined();
    expect(usage!.commandOutcome).toBe('success');
    expect(usage!.retrievalOutcome).toBe('answered');
  });

  it('emits a deps-impact answered event with module and blast-radius attributes', () => {
    // packages/{name} is a known boundary pattern, so this layout resolves the file to 'Orders'.
    mkdirSync(join(repoDir, 'packages', 'Orders'), { recursive: true });
    const res = runCli(repoDir, dbPath, ['deps', 'impact', 'packages/Orders/OrderService.php']);
    expect(res.status).toBe(0);

    const usage = readUsage(dbPath, 'deps-impact');
    expect(usage).toBeDefined();
    expect(usage!.commandOutcome).toBe('success');
    expect(usage!.retrievalOutcome).toBe('answered');
    expect(usage!.attributes?.module).toBe('Orders');
    expect(usage!.attributes?.dependentCount).toBe(2); // Users, Billing
    expect(usage!.attributes?.totalReferences).toBe(18); // 10 + 8
  });

  it('emits a deps-coverage success event with the cluster count', () => {
    const res = runCli(repoDir, dbPath, ['deps', 'coverage']);
    expect(res.status).toBe(0);

    const usage = readUsage(dbPath, 'deps-coverage');
    expect(usage).toBeDefined();
    expect(usage!.commandOutcome).toBe('success');
    expect(usage!.retrievalOutcome).toBe('answered');
    // The exact cluster count belongs to the clustering algorithm's own tests; the emission
    // contract is that a non-empty result reports answered with a positive count.
    expect(usage!.attributes?.clusterCount).toBeGreaterThan(0);
  });

  it('emits a deps-impact unresolved event when the file resolves to no module', () => {
    // No module-boundary patterns in this bare repo, so any file path is an honest resolution miss.
    const res = runCli(repoDir, dbPath, ['deps', 'impact', 'src/Nowhere/Thing.php']);
    expect(res.status).toBe(0); // deps never exits nonzero; the miss is a retrieval outcome

    const usage = readUsage(dbPath, 'deps-impact');
    expect(usage).toBeDefined();
    expect(usage!.commandOutcome).toBe('success');
    expect(usage!.retrievalOutcome).toBe('unresolved');
    expect(usage!.attributes?.resolved).toBe(false);
  });
});
