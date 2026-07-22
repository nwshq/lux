// SC-3 / SC-5 byte-identical single-repo regression. The goldens under
// fixtures/federation-regression/ were captured from the current-main (688c5e8 / b1620c1) build
// BEFORE the federation branch existed. A `trace`/`search` with NO `--with` must reproduce them
// byte-for-byte — the additive `--with` branch returns before the shipped code path, so the plain
// path (incl. freshness #67's `staleSupport` block on `trace --json`) is untouched.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LuxDatabase } from '../../db/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..', '..');
const CLI_ENTRY = join(PROJECT_ROOT, 'src', 'cli', 'index.ts');
const TSX_LOADER = join(PROJECT_ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs');
const GOLDEN_DIR = join(__dirname, 'fixtures', 'federation-regression');

function runCli(corpus: string, args: string[]): string {
  const res = spawnSync(process.execPath, ['--import', TSX_LOADER, CLI_ENTRY, ...args], {
    cwd: corpus,
    encoding: 'utf-8',
    env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
  });
  if (res.status !== 0) throw new Error(`CLI exited ${res.status}: ${res.stderr}`);
  return res.stdout;
}

/** Deterministic single-repo fixture — identical to the golden-capture builder. Node/edge insertion
 *  order is load-bearing (it fixes the trace child ordering), so keep it exactly in sync. */
function buildFixture(corpus: string): void {
  const db = new LuxDatabase(join(corpus, '.lux', 'lux.db'));
  const now = 1700000000;
  const node = (
    id: string,
    opts: { origin?: 'local' | 'vendor-pack'; qualified_name?: string; symbol_name?: string } = {}
  ) =>
    db.upsertStructuralNode({
      id,
      node_type: 'symbol',
      symbol_name: opts.symbol_name ?? id,
      qualified_name: opts.qualified_name,
      origin: opts.origin ?? 'local',
      language_id: 'php',
      updated_at: now,
    });
  const edge = (source: string, target: string) =>
    db.upsertStructuralEdge({
      id: `${source}->${target}:calls`,
      source_node_id: source,
      target_node_id: target,
      edge_type: 'calls',
      confidence: 0.95,
      confidence_class: 'proven',
      freshness_status: 'fresh',
      dirty_dependency_count: 0,
      updated_at: now,
    });

  node('sym:show', { qualified_name: 'App\\Http\\OfferController::show', symbol_name: 'show' });
  node('sym:find', { qualified_name: 'App\\Services\\OfferService::find', symbol_name: 'find' });
  node('sym:model', {
    qualified_name: 'Illuminate\\Database\\Eloquent\\Model::save',
    symbol_name: 'save',
    origin: 'vendor-pack',
  });
  node('sym:dispatch', {
    qualified_name: 'Illuminate\\Bus\\Dispatcher::dispatch',
    symbol_name: 'dispatch',
    origin: 'vendor-pack',
  });
  edge('sym:show', 'sym:find');
  edge('sym:find', 'sym:model');
  edge('sym:find', 'sym:dispatch');

  db.insertKnowledgeEntry({
    type: 'documentation',
    title: 'Offer Service Guide',
    file_path: '/corpus/docs/offer-service.md',
    content: 'The offer service resolves offers and dispatches settlement jobs.',
  });
  db.insertKnowledgeEntry({
    type: 'documentation',
    title: 'Settlement Runbook',
    file_path: '/corpus/docs/settlement.md',
    content: 'Settlement dispatches a job to the queue worker for each offer.',
  });
  db.close();
}

let corpus: string;
beforeEach(() => {
  corpus = mkdtempSync(join(tmpdir(), 'lux-fed-regression-'));
  mkdirSync(join(corpus, '.lux'), { recursive: true });
  buildFixture(corpus);
});
afterEach(() => rmSync(corpus, { recursive: true, force: true }));

const golden = (name: string) => readFileSync(join(GOLDEN_DIR, name), 'utf-8');

describe('byte-identical single-repo regression (no --with)', () => {
  it('trace text output is byte-identical to the b1620c1 baseline', () => {
    const out = runCli(corpus, ['--corpus', corpus, 'trace', 'App\\Http\\OfferController::show']);
    expect(out).toBe(golden('trace.txt'));
  });

  it('trace --json output is byte-identical to the b1620c1 baseline (incl. staleSupport)', () => {
    const out = runCli(corpus, [
      '--corpus',
      corpus,
      'trace',
      'App\\Http\\OfferController::show',
      '--json',
    ]);
    expect(out).toBe(golden('trace.json'));
  });

  it('search text output is byte-identical to the b1620c1 baseline', () => {
    const out = runCli(corpus, ['--corpus', corpus, 'search', 'settlement']);
    expect(out).toBe(golden('search.txt'));
  });
});
