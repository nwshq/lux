import { Command } from 'commander';
import { LuxDatabase } from '../db/index.js';
import { resolveCorpusPath, resolveDbPath } from '../utils/runtime-paths.js';
import {
  resolveStartNode,
  traceFrom,
  type TraceNode,
  type TraceResult,
} from '../scanner/associations/trace.js';
import type { ConfidenceClass, EdgeType } from '../db/types.js';
import { summarizeStaleSupport, staleSupportWarning } from '../scanner/freshness.js';

export function addTraceCommand(program: Command): void {
  program
    .command('trace <symbol>')
    .description('Trace calls from a symbol across the app→vendor boundary')
    .option('--depth <n>', 'Max hops to follow', (v) => parseInt(v, 10), 8)
    .option('--max-nodes <n>', 'Total node budget', (v) => parseInt(v, 10), 2000)
    .option('--edge-types <list>', 'Comma-separated edge types', 'calls,references')
    .option(
      '--min-confidence <class>',
      'proven|artifact-backed|framework-inferred|heuristic',
      'framework-inferred'
    )
    .option('--no-external', 'Do not follow edges into vendor nodes')
    .option('--json', 'Output as JSON')
    .action(
      (
        symbol: string,
        options: {
          depth: number;
          maxNodes: number;
          edgeTypes: string;
          minConfidence: string;
          external: boolean;
          json?: boolean;
        }
      ) => {
        const opts = program.opts();
        const corpusPath = resolveCorpusPath({ corpus: opts.corpus as string | undefined });
        const db = new LuxDatabase(
          resolveDbPath({ corpus: corpusPath, db: opts.db as string | undefined })
        );

        try {
          const resolved = resolveStartNode(db, symbol);
          if ('notFound' in resolved) {
            console.error(`No structural symbol found for: ${symbol}`);
            console.error('Run "lux index rebuild" first, or pass a fully-qualified name.');
            process.exitCode = 1;
            return;
          }
          if ('ambiguous' in resolved) {
            console.error(
              `Ambiguous symbol "${symbol}" — ${resolved.ambiguous.length} candidates:`
            );
            for (const c of resolved.ambiguous) {
              console.error(`  ${c.qualified_name ?? c.symbol_name}  (${c.id})`);
            }
            console.error('Re-run with a fully-qualified name or the exact node id.');
            process.exitCode = 1;
            return;
          }

          const result = traceFrom(db, resolved.nodeId, {
            maxDepth: options.depth,
            maxNodes: options.maxNodes,
            edgeTypes: options.edgeTypes.split(',').map((s) => s.trim()) as EdgeType[],
            minConfidenceClass: options.minConfidence as ConfidenceClass,
            includeExternal: options.external,
          });

          // Stale-aware annotation (Decision 4 / SC-4): read-only — report how many of the traced
          // path edges the maintained marks already flag `stale`. Never changes the resolution.
          const staleSupport = summarizeStaleSupport(
            db.getEdgeFreshnessByIds(result.edges.map((e) => e.id))
          );

          if (options.json) {
            console.log(JSON.stringify({ ...result, staleSupport }, null, 2));
            return;
          }
          const staleWarning = staleSupportWarning(staleSupport);
          if (staleWarning) console.warn('Warning: ' + staleWarning);
          printTrace(result);
        } finally {
          db.close();
        }
      }
    );
}

/** Pretty-print the trace DAG as an indented tree rooted at the start node. */
function printTrace(result: TraceResult): void {
  const byId = new Map(result.nodes.map((n) => [n.id, n]));
  const childrenOf = new Map<string, { edge: (typeof result.edges)[number]; targetId: string }[]>();
  for (const e of result.edges) {
    if (!childrenOf.has(e.sourceId)) childrenOf.set(e.sourceId, []);
    childrenOf.get(e.sourceId)!.push({ edge: e, targetId: e.targetId });
  }

  const start = byId.get(result.startId);
  if (!start) return;

  console.log(`\nTrace from ${start.label}`);
  console.log(
    `  depth≤${result.options.maxDepth}  edges:${result.options.edgeTypes.join('/')}  ` +
      `min-confidence:${result.options.minConfidenceClass}\n`
  );

  const seen = new Set<string>();
  const line = (node: TraceNode, prefix: string, edge?: (typeof result.edges)[number]) => {
    const tag = node.external ? ' [vendor]' : '';
    const conf = edge ? `  {${abbrev(edge.confidenceClass)} ${edge.confidence.toFixed(2)}}` : '';
    const term = terminusLabel(node);
    console.log(`${prefix}${node.label}${tag}${conf}${term}`);
  };

  const render = (
    id: string,
    prefix: string,
    isLast: boolean,
    edge?: (typeof result.edges)[number]
  ) => {
    const node = byId.get(id);
    if (!node) return;
    const branch = prefix === '' ? '' : isLast ? '└─ ' : '├─ ';
    line(node, prefix + branch, edge);
    if (seen.has(id)) return; // cycle / shared node — print once, don't recurse
    seen.add(id);
    if (node.terminus === 'dynamic-dispatch-boundary') return; // stop at boundary
    const kids = (childrenOf.get(id) ?? []).filter((k) => !k.edge.revisit);
    const childPrefix = prefix + (prefix === '' ? '' : isLast ? '   ' : '│  ');
    kids.forEach((k, i) => render(k.targetId, childPrefix, i === kids.length - 1, k.edge));
  };

  render(result.startId, '', true);

  console.log(
    `\n${result.stats.nodeCount} nodes, ${result.stats.edgeCount} edges, ` +
      `${result.stats.externalCount} vendor, ${result.stats.dispatchBoundaries} dispatch boundaries` +
      (result.stats.truncated ? ' (truncated — raise --depth/--max-nodes)' : '')
  );
}

function abbrev(c: ConfidenceClass): string {
  return { proven: 'prv', 'artifact-backed': 'art', 'framework-inferred': 'fwk', heuristic: 'heu' }[
    c
  ];
}

function terminusLabel(n: TraceNode): string {
  switch (n.terminus) {
    case 'dynamic-dispatch-boundary':
      return `  ⟿ dispatch boundary (${n.dispatch?.dispatchKind}, re-entry deferred)`;
    case 'depth-limit':
      return '  ⋯ depth limit';
    case 'node-budget':
      return '  ⋯ node budget';
    case 'fanout-cap':
      return '  ⋯ fan-out capped';
    case 'leaf':
      return '';
    default:
      return '';
  }
}
