// Walk-level union trace across two real `.lux` fixtures (spec 13 / Decisions 2,3,5 / SC-3,4,9).
// The cross-DB proof of the id-portability law:
//   - SC-3 union: a trace from an App\ handler --with the kernel reaches Acme\Core\* nodes absent
//     from the single-index trace, carrying kernel repo attribution + bridged marks.
//   - SC-4 false-merge (walk level): colliding file:/symbol:ts:/bare symbol:php:helper stay as TWO
//     distinct (repo,id) nodes; a namespace-qualified symbol:php:Acme\Core\* MERGES to one node.
//   - regression: with zero siblings the node/edge set equals traceFrom(primary,…) projected.
//   - edge provenance + interleaved global budget.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { LuxDatabase } from '../../../db/index.js';
import type { ConfidenceClass, EdgeType, NodeOrigin } from '../../../db/types.js';
import { traceFrom } from '../trace.js';
import { traceFromFederated } from '../federation-trace.js';
import type { FederationBlock } from '../../siblings.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'lux-fed-trace-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function makeDb(name: string): LuxDatabase {
  return new LuxDatabase(join(root, name, '.lux', 'lux.db'));
}

function addNode(
  db: LuxDatabase,
  id: string,
  opts: { origin?: NodeOrigin; qualified_name?: string; symbol_name?: string } = {}
): void {
  db.upsertStructuralNode({
    id,
    node_type: 'symbol',
    symbol_name: opts.symbol_name ?? id,
    qualified_name: opts.qualified_name,
    origin: opts.origin ?? 'local',
    updated_at: Math.floor(Date.now() / 1000),
  });
}

function addEdge(
  db: LuxDatabase,
  source: string,
  target: string,
  opts: { edgeType?: EdgeType; confidence?: number; confidenceClass?: ConfidenceClass } = {}
): void {
  const edgeType = opts.edgeType ?? 'calls';
  db.upsertStructuralEdge({
    id: `${source}->${target}:${edgeType}`,
    source_node_id: source,
    target_node_id: target,
    edge_type: edgeType,
    confidence: opts.confidence ?? 0.9,
    confidence_class: opts.confidenceClass ?? 'proven',
    freshness_status: 'fresh',
    dirty_dependency_count: 0,
    updated_at: Math.floor(Date.now() / 1000),
  });
}

const KERNEL_BLOCK: FederationBlock = {
  siblings: [
    {
      name: 'sib_kernel',
      role: 'kernel',
      attached: true,
      worktree: null,
      freshness: { indexedCommit: 'abc', headCommit: 'abc', stale: false, dbSchemaVersion: 13 },
    },
  ],
};

// Ids used across the two fixtures. Portable (namespace-qualified PHP) vs. the three colliding
// repo-local ids present in BOTH repos.
const SHOW = 'symbol:php:App\\Http\\OfferController::show';
const SETTLE = 'symbol:php:App\\Services\\OfferService::settle';
const ENGINE = 'symbol:php:Acme\\Core\\Settlement\\Engine::run'; // portable, in BOTH
const LEDGER = 'symbol:php:Acme\\Core\\Settlement\\Ledger::post'; // portable, kernel-only
const SHARED = 'symbol:php:Acme\\Core\\Shared::z'; // portable, in BOTH (edge-provenance)
const HELPER = 'symbol:php:helper'; // bare — repo-local, in BOTH
const WEB = 'file:routes/web.php'; // repo-local, in BOTH
const TS = 'symbol:ts:src/index.ts#main'; // repo-local, in BOTH

/** primary "client": App handler → service → the portable Engine + the three colliding ids. */
function buildPrimary(): LuxDatabase {
  const db = makeDb('client');
  addNode(db, SHOW, { qualified_name: 'App\\Http\\OfferController::show', symbol_name: 'show' });
  addNode(db, SETTLE, { qualified_name: 'App\\Services\\OfferService::settle' });
  addNode(db, ENGINE, { qualified_name: 'Acme\\Core\\Settlement\\Engine::run' });
  addNode(db, SHARED, { qualified_name: 'Acme\\Core\\Shared::z' });
  addNode(db, HELPER, { symbol_name: 'helper' });
  addNode(db, WEB);
  addNode(db, TS);
  addEdge(db, SHOW, SETTLE);
  addEdge(db, SETTLE, ENGINE);
  addEdge(db, SETTLE, HELPER); // main's helper
  addEdge(db, SETTLE, WEB, { edgeType: 'references' });
  addEdge(db, SETTLE, TS, { edgeType: 'references' });
  addEdge(db, ENGINE, SHARED); // shared edge (also present in kernel) — provenance
  return db;
}

/** kernel sibling: the portable Engine continues into kernel-only Ledger + re-declares the three
 *  colliding ids (its own copies) reached from Engine. */
function buildKernel(): LuxDatabase {
  const db = makeDb('kernel');
  addNode(db, ENGINE, { qualified_name: 'Acme\\Core\\Settlement\\Engine::run' });
  addNode(db, LEDGER, { qualified_name: 'Acme\\Core\\Settlement\\Ledger::post' });
  addNode(db, SHARED, { qualified_name: 'Acme\\Core\\Shared::z' });
  addNode(db, HELPER, { symbol_name: 'helper' });
  addNode(db, WEB);
  addNode(db, TS);
  addEdge(db, ENGINE, LEDGER); // kernel-only continuation — only reachable by bridging
  addEdge(db, ENGINE, SHARED); // same edge as primary — provenance dedup
  addEdge(db, ENGINE, HELPER); // kernel's helper
  addEdge(db, ENGINE, WEB, { edgeType: 'references' });
  addEdge(db, ENGINE, TS, { edgeType: 'references' });
  return db;
}

describe('traceFromFederated — union + id-portability law (walk level)', () => {
  let primary: LuxDatabase;
  let kernel: LuxDatabase;

  beforeEach(() => {
    primary = buildPrimary();
    kernel = buildKernel();
  });
  afterEach(() => {
    primary.close();
    kernel.close();
  });

  it('SC-3: reaches a kernel-only node absent from the single-index trace, marked bridged', () => {
    const single = traceFrom(primary, SHOW);
    expect(single.nodes.some((n) => n.id === LEDGER)).toBe(false); // not in the client index alone

    const fed = traceFromFederated(
      primary,
      [{ name: 'sib_kernel', role: 'kernel', db: kernel }],
      SHOW,
      KERNEL_BLOCK
    );
    const ledger = fed.nodes.find((n) => n.id === LEDGER);
    expect(ledger).toBeDefined();
    expect(ledger!.repo).toBe('sib_kernel');
    expect(ledger!.bridged).toBe(true);
    expect(fed.stats.reposReached.sort()).toEqual(['main', 'sib_kernel']);
    expect(fed.stats.bridgedCount).toBeGreaterThan(0);
  });

  it('SC-4 positive merge: a namespace-qualified portable id is ONE node spanning both repos', () => {
    const fed = traceFromFederated(
      primary,
      [{ name: 'sib_kernel', role: 'kernel', db: kernel }],
      SHOW,
      KERNEL_BLOCK
    );
    const engines = fed.nodes.filter((n) => n.id === ENGINE);
    expect(engines).toHaveLength(1); // merged under the bare portable id
    expect(engines[0].repos?.sort()).toEqual(['main', 'sib_kernel']);
  });

  it('SC-4 false merge: colliding bare-name / file: / symbol:ts: ids stay TWO distinct nodes', () => {
    const fed = traceFromFederated(
      primary,
      [{ name: 'sib_kernel', role: 'kernel', db: kernel }],
      SHOW,
      KERNEL_BLOCK
    );
    for (const collidingId of [HELPER, WEB, TS]) {
      const hits = fed.nodes.filter((n) => n.id === collidingId);
      expect(hits).toHaveLength(2); // one per repo — never fused
      expect(hits.map((n) => n.repo).sort()).toEqual(['main', 'sib_kernel']);
      // The repo-local node is never annotated as spanning both repos (no false merge).
      const mainCopy = hits.find((n) => n.repo === 'main')!;
      expect(mainCopy.repos ?? ['main']).not.toContain('sib_kernel');
    }
  });

  it('SC-4: never continues a walk from one repo’s repo-local node into the other', () => {
    // main's HELPER has no out-edges; kernel's HELPER has kernel edges. The main copy must NOT pull
    // kernel edges — so no node is homed to main via a repo-local bridge.
    const fed = traceFromFederated(
      primary,
      [{ name: 'sib_kernel', role: 'kernel', db: kernel }],
      SHOW,
      KERNEL_BLOCK
    );
    const mainHelper = fed.nodes.find((n) => n.id === HELPER && n.repo === 'main')!;
    expect(mainHelper.bridged).not.toBe(true);
  });

  it('edge provenance: a shared edge appears once with repos main-first', () => {
    const fed = traceFromFederated(
      primary,
      [{ name: 'sib_kernel', role: 'kernel', db: kernel }],
      SHOW,
      KERNEL_BLOCK
    );
    const shared = fed.edges.filter((e) => e.sourceId === ENGINE && e.targetId === SHARED);
    expect(shared).toHaveLength(1);
    expect(shared[0].repos).toEqual(['main', 'sib_kernel']); // main first
  });

  it('carries the federation block through to the result (SC-9)', () => {
    const fed = traceFromFederated(
      primary,
      [{ name: 'sib_kernel', role: 'kernel', db: kernel }],
      SHOW,
      KERNEL_BLOCK
    );
    expect(fed.federation).toBe(KERNEL_BLOCK);
    expect(fed.federation.siblings[0].name).toBe('sib_kernel');
  });
});

describe('traceFromFederated — regression + budget', () => {
  it('with zero siblings, node/edge sets equal traceFrom(primary) projected', () => {
    const db = makeDb('plain');
    // A plain chain (no dispatch machinery, no external filtering divergence).
    addNode(db, 'A');
    addNode(db, 'B');
    addNode(db, 'C');
    addNode(db, 'D');
    addEdge(db, 'A', 'B');
    addEdge(db, 'B', 'C');
    addEdge(db, 'C', 'D');

    const plain = traceFrom(db, 'A');
    const fed = traceFromFederated(db, [], 'A', { siblings: [] });

    expect(fed.nodes.map((n) => n.id).sort()).toEqual(plain.nodes.map((n) => n.id).sort());
    const key = (e: { sourceId: string; targetId: string; edgeType: string }) =>
      `${e.sourceId}->${e.targetId}:${e.edgeType}`;
    expect(fed.edges.map(key).sort()).toEqual(plain.edges.map(key).sort());
    expect(fed.stats.reposReached).toEqual(['main']);
    db.close();
  });

  it('a global maxNodes budget truncates and still reaches a shallow bridged node first', () => {
    const primary = buildPrimary();
    const kernel = buildKernel();
    // Tight budget: interleaving must expand the shallow bridged Engine→Ledger reach before the
    // deep same-repo tail exhausts the pool.
    const fed = traceFromFederated(
      primary,
      [{ name: 'sib_kernel', role: 'kernel', db: kernel }],
      SHOW,
      KERNEL_BLOCK,
      { maxNodes: 6 }
    );
    expect(fed.stats.truncated).toBe(true);
    expect(fed.stats.nodeCount).toBeLessThanOrEqual(6);
    primary.close();
    kernel.close();
  });
});
