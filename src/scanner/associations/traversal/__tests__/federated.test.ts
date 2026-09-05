import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LuxDatabase } from '../../../../db/index.js';
import type { EdgeType, FreshnessStatus } from '../../../../db/types.js';
import type { FederationBlock } from '../../../siblings.js';
import { traverseFromFederated } from '../../federation-trace.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'lux-directional-federation-'));
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function database(name: string): LuxDatabase {
  return new LuxDatabase(join(root, name, '.lux', 'lux.db'));
}

function node(db: LuxDatabase, id: string): void {
  db.upsertStructuralNode({
    id,
    node_type: 'symbol',
    symbol_name: id,
    qualified_name: id.startsWith('symbol:php:') ? id.slice('symbol:php:'.length) : undefined,
    origin: 'local',
    updated_at: 1,
  });
}

function edge(
  db: LuxDatabase,
  source: string,
  target: string,
  options: {
    type?: EdgeType;
    freshness?: FreshnessStatus;
    provenance?: string;
  } = {}
): void {
  const type = options.type ?? 'calls';
  db.upsertStructuralEdge({
    id: `${source}->${target}:${type}`,
    source_node_id: source,
    target_node_id: target,
    edge_type: type,
    confidence: 0.9,
    confidence_class: 'proven',
    freshness_status: options.freshness ?? 'fresh',
    dirty_dependency_count: 0,
    provenance_summary: options.provenance,
    updated_at: 1,
  });
}

const BLOCK: FederationBlock = {
  siblings: [
    {
      name: 'peer',
      role: 'peer',
      attached: true,
      worktree: null,
      freshness: {
        indexedCommit: 'abc',
        headCommit: 'abc',
        stale: false,
        dbSchemaVersion: 13,
      },
    },
  ],
};

const PORTABLE = 'symbol:php:App\\Contracts\\Billable::bill';
const MAIN_CALLER = 'symbol:php:App\\Billing\\LocalBillable::bill';
const PEER_CALLER = 'symbol:php:Peer\\Billing\\RemoteBillable::bill';
const LOCAL = 'symbol:ts:src/shared.ts#run';
const MAIN_LOCAL_CALLER = 'symbol:ts:src/main-caller.ts#call';
const PEER_LOCAL_CALLER = 'symbol:ts:src/peer-caller.ts#call';

function buildPortableFixture(): { primary: LuxDatabase; peer: LuxDatabase } {
  const primary = database('main');
  const peer = database('peer');
  for (const id of [PORTABLE, MAIN_CALLER, LOCAL, MAIN_LOCAL_CALLER]) node(primary, id);
  for (const id of [PORTABLE, PEER_CALLER, LOCAL, PEER_LOCAL_CALLER]) node(peer, id);
  edge(primary, MAIN_CALLER, PORTABLE, {
    type: 'implements_contract',
    freshness: 'stale',
    provenance: 'primary declaration',
  });
  edge(peer, PEER_CALLER, PORTABLE, {
    type: 'implements_contract',
    provenance: 'peer declaration',
  });
  edge(primary, MAIN_LOCAL_CALLER, LOCAL);
  edge(peer, PEER_LOCAL_CALLER, LOCAL);
  return { primary, peer };
}

describe('traverseFromFederated', () => {
  it('finds incoming portable relationships across repos with canonical endpoints and provenance', () => {
    const { primary, peer } = buildPortableFixture();
    const result = traverseFromFederated(
      primary,
      [{ name: 'peer', role: 'peer', db: peer }],
      PORTABLE,
      BLOCK,
      { direction: 'incoming', edgeTypes: ['implements_contract'] }
    );

    expect(result.options.direction).toBe('incoming');
    expect(result.nodes).toHaveLength(3);
    expect(result.edges).toHaveLength(2);
    expect(result.edges.map((item) => item.repo)).toEqual(['main', 'peer']);
    expect(result.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source_node_id: MAIN_CALLER,
          target_node_id: PORTABLE,
          traversed: 'reverse',
          repo: 'main',
          provenance: [
            expect.objectContaining({
              repo: 'main',
              freshnessStatus: 'stale',
              provenanceSummary: 'primary declaration',
            }),
          ],
        }),
        expect.objectContaining({
          source_node_id: PEER_CALLER,
          target_node_id: PORTABLE,
          traversed: 'reverse',
          repo: 'peer',
        }),
      ])
    );
    expect(result.stats.freshness).toEqual({
      fresh: 1,
      stale: 1,
      dirtyDependent: 0,
      unknown: 0,
    });
    primary.close();
    peer.close();
  });

  it('never crosses a repo boundary for a path-bearing TypeScript identity', () => {
    const { primary, peer } = buildPortableFixture();
    const result = traverseFromFederated(
      primary,
      [{ name: 'peer', role: 'peer', db: peer }],
      LOCAL,
      BLOCK,
      { direction: 'incoming' }
    );

    expect(result.edges).toHaveLength(1);
    expect(result.edges[0]).toMatchObject({
      source_node_id: MAIN_LOCAL_CALLER,
      target_node_id: LOCAL,
      traversed: 'reverse',
      repo: 'main',
    });
    expect(result.edges.some((item) => item.source_node_id === PEER_LOCAL_CALLER)).toBe(false);
    primary.close();
    peer.close();
  });

  it('shares one node budget across both directions and all repos', () => {
    const { primary, peer } = buildPortableFixture();
    const outgoing = 'symbol:php:App\\Contracts\\Downstream::run';
    node(primary, outgoing);
    edge(primary, PORTABLE, outgoing, { type: 'implements_contract' });

    const result = traverseFromFederated(
      primary,
      [{ name: 'peer', role: 'peer', db: peer }],
      PORTABLE,
      BLOCK,
      {
        direction: 'both',
        edgeTypes: ['implements_contract'],
        maxNodes: 3,
      }
    );

    expect(result.stats.nodeCount).toBe(3);
    expect(result.stats.truncated).toBe(true);
    expect(new Set(result.edges.map((item) => item.traversed))).toEqual(
      new Set(['forward', 'reverse'])
    );
    primary.close();
    peer.close();
  });

  it('continues reverse traversal through a stored dispatch relationship', () => {
    const primary = database('dispatch-main');
    const job = 'symbol:php:App\\Jobs\\SendInvoice::handle';
    const dispatcher = 'symbol:php:App\\Actions\\QueueInvoice::run';
    const route = 'symbol:php:App\\Routes\\Invoice::post';
    for (const id of [job, dispatcher, route]) node(primary, id);
    edge(primary, dispatcher, job, { type: 'dispatches_job' });
    edge(primary, route, dispatcher, { type: 'calls' });

    const result = traverseFromFederated(
      primary,
      [],
      job,
      { siblings: [] },
      {
        direction: 'incoming',
        edgeTypes: ['dispatches_job', 'calls'],
      }
    );

    expect(result.edges.map((item) => item.edge_type)).toEqual(['dispatches_job', 'calls']);
    expect(result.edges.every((item) => item.traversed === 'reverse')).toBe(true);
    expect(result.nodes.some((item) => item.id === route)).toBe(true);
    expect(result.stats.dispatchBoundaries).toBe(0);
    primary.close();
  });
});
