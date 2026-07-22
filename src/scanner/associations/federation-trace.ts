// Union trace across the primary + attached siblings (Decisions 2, 3, 5). Reuses traceFrom's
// budgets/edge-set/confidence contract (DEFAULT_TRACE_OPTIONS, CONFIDENCE_RANK) but generalizes the
// frontier to (repo, nodeId) pairs under the three-class keying (spec 12). Opt-in only (--with):
// the plain traceFrom path stays byte-identical to current main; nothing here runs without a sibling.

import { LuxDatabase } from '../../db/index.js';
import type { ConfidenceClass, EdgeType, StructuralEdge, StructuralNode } from '../../db/types.js';
import {
  CONFIDENCE_RANK,
  DEFAULT_TRACE_OPTIONS,
  type TerminusReason,
  type TraceOptions,
} from './trace.js';
import { federationKey, idBridges, type FederationRepo } from './federation.js';
import type { FederationBlock } from '../siblings.js';

export interface FederatedRepoHandle {
  repo: FederationRepo;
  db: LuxDatabase;
}

export interface FederatedTraceNode {
  id: string;
  label: string;
  languageId?: string;
  filePath?: string;
  depth: number;
  external: boolean;
  /** the discovering repo ('main' | sibling name). */
  repo: string;
  /** for a portable id resolving in >1 index — every repo it appears in. */
  repos?: string[];
  /** reached by crossing a repo boundary on a portable id. */
  bridged?: boolean;
  terminus?: TerminusReason;
}

export interface FederatedTraceEdge {
  sourceId: string;
  targetId: string;
  edgeType: EdgeType;
  confidence: number;
  confidenceClass: ConfidenceClass;
  /** provenance: every repo this (source,target,type) edge was found in (main first). */
  repos: string[];
  revisit: boolean;
}

export interface FederatedTraceResult {
  startId: string;
  options: Required<TraceOptions>;
  nodes: FederatedTraceNode[];
  edges: FederatedTraceEdge[];
  /** per-sibling freshness/skew — SC-9 (built by the caller from resolveSiblings). */
  federation: FederationBlock;
  stats: {
    nodeCount: number;
    edgeCount: number;
    bridgedCount: number;
    reposReached: string[];
    truncated: boolean;
  };
}

interface FrontierItem {
  nodeId: string;
  home: FederatedRepoHandle;
  depth: number;
  key: string;
}

/** Round-robin the frontier by home repo so a shallow bridged node is expanded before a deep
 *  same-repo hub competes for the global budget (Decision 3 — interleaved, depth-ordered). */
function interleaveByRepo(items: FrontierItem[]): FrontierItem[] {
  const byRepo = new Map<string, FrontierItem[]>();
  const order: string[] = [];
  for (const it of items) {
    if (!byRepo.has(it.home.repo.name)) {
      byRepo.set(it.home.repo.name, []);
      order.push(it.home.repo.name);
    }
    byRepo.get(it.home.repo.name)!.push(it);
  }
  const out: FrontierItem[] = [];
  let remaining = items.length;
  while (remaining > 0) {
    for (const name of order) {
      const q = byRepo.get(name)!;
      if (q.length) {
        out.push(q.shift()!);
        remaining--;
      }
    }
  }
  return out;
}

const edgeKey = (e: {
  source_node_id: string;
  target_node_id: string;
  edge_type: string;
}): string => `${e.source_node_id}\0${e.target_node_id}\0${e.edge_type}`;

/**
 * Trace forward from `startId` across the primary + attached siblings (Decision 2/3). Deltas from
 * traceFrom: the frontier holds (repo, nodeId); expansion queries out-edges in the node's home repo
 * AND (when idBridges permits) in every other attached repo where the id resolves; visited keying,
 * portable-id merging, and bridge eligibility follow the three-class law; budgets are one global
 * pool. `startId` must be a resolved node in the primary (use resolveStartNode(primary, symbol)).
 */
export function traceFromFederated(
  primary: LuxDatabase,
  siblings: Array<{ name: string; role: 'kernel' | 'peer'; db: LuxDatabase }>,
  startId: string,
  federation: FederationBlock,
  options: TraceOptions = {}
): FederatedTraceResult {
  const opts: Required<TraceOptions> = { ...DEFAULT_TRACE_OPTIONS, ...options };
  const minRank = CONFIDENCE_RANK[opts.minConfidenceClass];
  const edgeTypeSet = new Set<EdgeType>(opts.edgeTypes);

  const repos: FederatedRepoHandle[] = [
    { repo: { name: 'main', role: 'primary' }, db: primary },
    ...siblings.map((s): FederatedRepoHandle => ({
      repo: { name: s.name, role: s.role === 'kernel' ? 'kernel' : 'peer' },
      db: s.db,
    })),
  ];

  const nodeCaches = new Map<string, Map<string, StructuralNode | null>>(
    repos.map((r) => [r.repo.name, new Map<string, StructuralNode | null>()])
  );
  const loadNode = (r: FederatedRepoHandle, id: string): StructuralNode | null => {
    const cache = nodeCaches.get(r.repo.name)!;
    if (!cache.has(id)) cache.set(id, r.db.getStructuralNode(id));
    return cache.get(id)!;
  };
  const labelFor = (n: StructuralNode | null, id: string): string =>
    n?.qualified_name ?? n?.symbol_name ?? id;

  const nodesByKey = new Map<string, FederatedTraceNode>();
  const edgesByKey = new Map<string, FederatedTraceEdge>();
  const expanded = new Set<string>();
  let truncated = false;
  let bridgedCount = 0;

  const admit = (
    nodeId: string,
    home: FederatedRepoHandle,
    depth: number,
    bridged: boolean
  ): FederatedTraceNode => {
    const key = federationKey(home.repo, nodeId);
    const existing = nodesByKey.get(key);
    if (existing) {
      if (!existing.repos) existing.repos = [existing.repo];
      if (!existing.repos.includes(home.repo.name)) existing.repos.push(home.repo.name);
      return existing;
    }
    const raw = loadNode(home, nodeId);
    const node: FederatedTraceNode = {
      id: nodeId,
      label: labelFor(raw, nodeId),
      languageId: raw?.language_id ?? undefined,
      filePath: raw?.file_path ?? undefined,
      depth,
      external: raw ? LuxDatabase.isExternalNode(raw) : false,
      repo: home.repo.name,
    };
    if (bridged) {
      node.bridged = true;
      bridgedCount++;
    }
    nodesByKey.set(key, node);
    return node;
  };

  // Seed in the primary.
  const seedHome = repos[0];
  admit(startId, seedHome, 0, false);
  let frontier: FrontierItem[] = [
    { nodeId: startId, home: seedHome, depth: 0, key: federationKey(seedHome.repo, startId) },
  ];

  for (let depth = 1; depth <= opts.maxDepth && frontier.length > 0; depth++) {
    const level = interleaveByRepo(frontier);
    const next: FrontierItem[] = [];

    for (const item of level) {
      if (truncated) break;
      if (expanded.has(item.key)) continue;
      expanded.add(item.key);

      // Repos to fetch out-edges from: home + every bridge-eligible repo where the id resolves.
      const expandRepos = repos.filter(
        (r) => idBridges(item.nodeId, item.home.repo, r.repo) && loadNode(r, item.nodeId) !== null
      );
      const node = nodesByKey.get(item.key)!;
      if (expandRepos.length > 1) node.repos = expandRepos.map((r) => r.repo.name);

      // Gather + dedup out-edges across repos; main-first order homes each edge to its first repo.
      const byEdge = new Map<
        string,
        { edge: StructuralEdge; foundIn: FederatedRepoHandle; repos: string[] }
      >();
      for (const r of expandRepos) {
        for (const e of r.db.getOutgoingStructuralEdges(item.nodeId)) {
          if (!edgeTypeSet.has(e.edge_type)) continue;
          if (CONFIDENCE_RANK[e.confidence_class] < minRank) continue;
          const ek = edgeKey(e);
          const g = byEdge.get(ek);
          if (g) {
            if (!g.repos.includes(r.repo.name)) g.repos.push(r.repo.name);
          } else {
            byEdge.set(ek, { edge: e, foundIn: r, repos: [r.repo.name] });
          }
        }
      }

      const gathered = [...byEdge.values()].sort((a, b) => b.edge.confidence - a.edge.confidence);
      const capped = gathered.length > opts.maxFanout;
      const walked = capped ? gathered.slice(0, opts.maxFanout) : gathered;
      if (capped && !node.terminus) node.terminus = 'fanout-cap';

      for (const g of walked) {
        const ek = edgeKey(g.edge);
        const targetKey = federationKey(g.foundIn.repo, g.edge.target_node_id);
        const targetExisting = nodesByKey.get(targetKey);
        const bridged = g.foundIn.repo.name !== item.home.repo.name;

        if (!edgesByKey.has(ek)) {
          edgesByKey.set(ek, {
            sourceId: g.edge.source_node_id,
            targetId: g.edge.target_node_id,
            edgeType: g.edge.edge_type,
            confidence: g.edge.confidence,
            confidenceClass: g.edge.confidence_class,
            repos: g.repos,
            revisit: Boolean(targetExisting),
          });
        }
        if (targetExisting) continue; // cycle / shared node — recorded, never re-expanded
        if (nodesByKey.size >= opts.maxNodes) {
          truncated = true;
          continue;
        }
        admit(g.edge.target_node_id, g.foundIn, depth, bridged);
        next.push({ nodeId: g.edge.target_node_id, home: g.foundIn, depth, key: targetKey });
      }
    }
    frontier = next;
  }

  const nodes = [...nodesByKey.values()];
  const edges = [...edgesByKey.values()];
  return {
    startId,
    options: opts,
    nodes,
    edges,
    federation,
    stats: {
      nodeCount: nodes.length,
      edgeCount: edges.length,
      bridgedCount,
      reposReached: [...new Set(nodes.map((n) => n.repo))],
      truncated,
    },
  };
}
