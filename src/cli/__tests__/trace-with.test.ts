// `lux trace --with` (spec 13C / T2.3 / Decisions 5,6 / SC-3,7,9). Opt-in federation: opens sibling
// `.lux` handles read-only, unions the trace across the portability law, closes handles in a finally.
// An unresolvable named sibling warns + the query still answers (Decision 6). --json carries the
// federation block (SC-9). The sibling `.lux` is never mutated (SC-7).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LuxDatabase } from '../../db/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..', '..');
const CLI_ENTRY = join(PROJECT_ROOT, 'src', 'cli', 'index.ts');
const TSX_LOADER = join(PROJECT_ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs');

function runCli(corpus: string, args: string[]) {
  return spawnSync(process.execPath, ['--import', TSX_LOADER, CLI_ENTRY, ...args], {
    cwd: corpus,
    encoding: 'utf-8',
    env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
  });
}

const SHOW = 'symbol:php:App\\Http\\Ctrl::show';
const ENGINE = 'symbol:php:acme\\Core\\Engine::run';
const LEDGER = 'symbol:php:acme\\Core\\Ledger::post';

function addNode(db: LuxDatabase, id: string, qualified_name?: string): void {
  db.upsertStructuralNode({
    id,
    node_type: 'symbol',
    symbol_name: id,
    qualified_name,
    origin: 'local',
    updated_at: 1,
  });
}
function addEdge(db: LuxDatabase, source: string, target: string): void {
  db.upsertStructuralEdge({
    id: `${source}->${target}`,
    source_node_id: source,
    target_node_id: target,
    edge_type: 'calls',
    confidence: 0.9,
    confidence_class: 'proven',
    freshness_status: 'fresh',
    dirty_dependency_count: 0,
    updated_at: 1,
  });
}

let root: string;
let corpus: string;
let siblingDbPath: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'lux-trace-with-'));
  corpus = join(root, 'client');
  mkdirSync(corpus, { recursive: true });

  // primary: an App handler that calls a portable acme\Core FQCN.
  const primary = new LuxDatabase(join(corpus, '.lux', 'lux.db'));
  addNode(primary, SHOW, 'App\\Http\\Ctrl::show');
  addNode(primary, ENGINE, 'acme\\Core\\Engine::run');
  addEdge(primary, SHOW, ENGINE);
  primary.close();

  // sibling "kernel": the portable Engine continues into a kernel-only Ledger.
  const kernelDir = join(root, 'core');
  siblingDbPath = join(kernelDir, '.lux', 'lux.db');
  const kernel = new LuxDatabase(siblingDbPath);
  addNode(kernel, ENGINE, 'acme\\Core\\Engine::run');
  addNode(kernel, LEDGER, 'acme\\Core\\Ledger::post');
  addEdge(kernel, ENGINE, LEDGER);
  kernel.close();

  writeFileSync(join(corpus, 'lux.yaml'), `siblings:\n  core:\n    db: ${siblingDbPath}\n`);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('lux trace --with', () => {
  it('unions into the kernel: reaches the bridged acme\\Core\\Ledger node (--json + federation)', () => {
    const res = runCli(corpus, ['--corpus', corpus, 'trace', SHOW, '--with', 'core', '--json']);
    expect(res.status).toBe(0);
    const result = JSON.parse(res.stdout) as {
      nodes: Array<{ id: string; repo: string; bridged?: boolean }>;
      stats: { reposReached: string[] };
      federation: { siblings: Array<{ name: string; attached: boolean }> };
    };
    const ledger = result.nodes.find((n) => n.id === LEDGER);
    expect(ledger).toBeDefined();
    expect(ledger!.repo).toBe('core');
    expect(ledger!.bridged).toBe(true);
    expect(result.stats.reposReached.sort()).toEqual(['core', 'main']);
    // SC-9: the federation block is present with the sibling attached.
    expect(result.federation.siblings[0]).toMatchObject({ name: 'core', attached: true });
  });

  it('renders a federated text trace with repo grouping + bridged marks', () => {
    const res = runCli(corpus, ['--corpus', corpus, 'trace', SHOW, '--with', 'core']);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('Federated trace');
    expect(res.stdout).toContain('[core]');
    expect(res.stdout).toContain('acme\\Core\\Ledger::post');
    expect(res.stdout).toContain('bridged');
  });

  it('warns on an unresolvable sibling and still answers (Decision 6)', () => {
    const res = runCli(corpus, ['--corpus', corpus, 'trace', SHOW, '--with', 'ghost', '--json']);
    expect(res.status).toBe(0); // analysis mode degrades — never nonzero
    expect(res.stderr).toContain('ghost');
    const result = JSON.parse(res.stdout) as {
      nodes: Array<{ id: string }>;
      federation: {
        siblings: Array<{ name: string; attached: boolean; refusal?: { reason: string } }>;
      };
    };
    // The primary trace still answers.
    expect(result.nodes.some((n) => n.id === SHOW)).toBe(true);
    // The unresolvable sibling is visible as attached:false — never silently dropped.
    const ghost = result.federation.siblings.find((s) => s.name === 'ghost');
    expect(ghost).toMatchObject({ attached: false });
    expect(ghost!.refusal?.reason).toBe('unregistered');
  });

  it('does not mutate the sibling .lux (SC-7 read-only: mtime + size unchanged, no -journal)', () => {
    const before = statSync(siblingDbPath);
    const res = runCli(corpus, ['--corpus', corpus, 'trace', SHOW, '--with', 'core', '--json']);
    expect(res.status).toBe(0);
    const after = statSync(siblingDbPath);
    expect(after.size).toBe(before.size);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  it('federated trace remains read-only and reports telemetry omission', () => {
    const dbPath = join(corpus, '.lux', 'lux.db');
    const beforeDb = new LuxDatabase(dbPath);
    const before = beforeDb.getRecentEvents(10).length;
    beforeDb.close();

    const res = runCli(corpus, ['--corpus', corpus, 'trace', SHOW, '--with', 'core', '--json']);
    expect(res.status).toBe(0);
    expect(JSON.parse(res.stdout).telemetry).toEqual({
      recorded: false,
      reason: 'read-only-index',
    });

    const db = new LuxDatabase(dbPath);
    expect(db.getRecentEvents(10)).toHaveLength(before);
    db.close();
  });
});
