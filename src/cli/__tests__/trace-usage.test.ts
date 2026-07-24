// Usage-event emission for `lux trace` on the non-federated paths: single-repo success plus the
// symbol-not-found and ambiguous refusals. (The federated success path is covered by
// trace-with.test.ts.) Same shape as the search/anchors usage tests: spawn the CLI, read the event.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
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
  commandOutcome?: string;
  retrievalOutcome?: string;
  attributes?: Record<string, unknown>;
  error?: { code?: string };
}

/** Every usage event on the events table, newest first, for the trace surface. */
function readTraceUsage(dbPath: string): UsagePayload[] {
  const db = new LuxDatabase(dbPath);
  try {
    return db
      .getRecentEvents(50)
      .map((e) =>
        e.event_type === 'lux_usage_event' && e.payload
          ? (JSON.parse(e.payload) as UsagePayload)
          : null
      )
      .filter((p): p is UsagePayload => Boolean(p) && p!.surface === 'trace');
  } finally {
    db.close();
  }
}

describe('lux trace usage events', () => {
  let repoDir: string;
  let dbDir: string;
  let dbPath: string;

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), 'lux-trace-usage-repo-'));
    dbDir = mkdtempSync(join(tmpdir(), 'lux-trace-usage-db-'));
    dbPath = join(dbDir, 'lux.db');

    const db = new LuxDatabase(dbPath);
    const now = Math.floor(Date.now() / 1000);
    db.upsertStructuralNode({
      id: 'A',
      node_type: 'symbol',
      symbol_name: 'App\\Http\\Controllers\\InvoiceController::store',
      qualified_name: 'App\\Http\\Controllers\\InvoiceController::store',
      origin: 'local',
      updated_at: now,
    });
    db.upsertStructuralNode({
      id: 'B',
      node_type: 'symbol',
      symbol_name: 'Illuminate\\Database\\Eloquent\\Model::save',
      qualified_name: 'Illuminate\\Database\\Eloquent\\Model::save',
      origin: 'vendor-pack',
      updated_at: now,
    });
    db.upsertStructuralEdge({
      id: 'A->B:calls',
      source_node_id: 'A',
      target_node_id: 'B',
      edge_type: 'calls',
      confidence: 0.9,
      confidence_class: 'proven',
      freshness_status: 'fresh',
      dirty_dependency_count: 0,
      updated_at: now,
    });
    // Two symbols sharing the leaf name `save` — a bare `trace save` is ambiguous (no exact match).
    db.upsertStructuralNode({
      id: 'sym:App\\Foo::save',
      node_type: 'symbol',
      symbol_name: 'save',
      qualified_name: 'App\\Foo::save',
      origin: 'local',
      updated_at: now,
    });
    db.upsertStructuralNode({
      id: 'sym:App\\Bar::save',
      node_type: 'symbol',
      symbol_name: 'save',
      qualified_name: 'App\\Bar::save',
      origin: 'local',
      updated_at: now,
    });
    db.close();
  });

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(dbDir, { recursive: true, force: true });
  });

  it('emits a non-federated trace success event (answered)', () => {
    const res = runCli(repoDir, dbPath, ['trace', 'A']);
    expect(res.status).toBe(0);

    const events = readTraceUsage(dbPath);
    expect(events).toHaveLength(1);
    expect(events[0].commandOutcome).toBe('success');
    expect(events[0].retrievalOutcome).toBe('answered');
    expect(events[0].attributes?.federated).toBe(false);
    expect(events[0].attributes?.nodeCount).toBe(2);
  });

  it('emits an error/unresolved event when the symbol is not found (exit 1)', () => {
    const res = runCli(repoDir, dbPath, ['trace', 'DoesNotExist::nope']);
    expect(res.status).toBe(1);

    const events = readTraceUsage(dbPath);
    expect(events).toHaveLength(1);
    expect(events[0].commandOutcome).toBe('error');
    expect(events[0].retrievalOutcome).toBe('unresolved');
    expect(events[0].error?.code).toBe('symbol-not-found');
  });

  it('emits an error/ambiguous event when the symbol resolves to multiple candidates (exit 1)', () => {
    const res = runCli(repoDir, dbPath, ['trace', 'save']);
    expect(res.status).toBe(1);

    const events = readTraceUsage(dbPath);
    expect(events).toHaveLength(1);
    expect(events[0].commandOutcome).toBe('error');
    expect(events[0].retrievalOutcome).toBe('ambiguous');
    expect(events[0].error?.code).toBe('ambiguous-symbol');
    expect(events[0].attributes?.candidateCount).toBe(2);
  });
});
