#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { LuxDatabase, SearchRefusalError, coerceSearchLimit } from '../db/index.js';
import { buildSearchReport, buildSearchRefusalReport } from '../cli/search-envelope.js';
import { GeneralScanner } from '../scanner/index.js';
import { attachEnrichment } from '../scanner/general.js';
import { rebuildWithOverlay } from '../scanner/rebuild-orchestrator.js';
import { persistRebuildTrustState } from '../scanner/overlay-trust-state.js';
import { readFileSync } from 'fs';
import { resolveRuntimePaths } from '../utils/runtime-paths.js';
import { LUX_VERSION } from '../utils/version.js';
import { computeImpact } from '../cli/deps-impact.js';
import { buildIndexStatusPayload, buildOverlayStatusPayload } from '../cli/status-payload.js';
import { getHeadCommit, isGitRepository } from '../scanner/git.js';
import { executeSpecEvidenceAsk } from '../cli/spec-evidence.js';
import { resolveStartNode, traceFrom } from '../scanner/associations/trace.js';
import { traceFromFederated } from '../scanner/associations/federation-trace.js';
import { runFederatedSearch } from '../scanner/search-federation.js';
import { openFederationHandles } from './federation-handles.js';
import { computeDelta } from '../scanner/delta/run.js';
import type { ConfidenceClass, EdgeType, RankedSearchResult } from '../db/types.js';
import {
  createInvocationId,
  emitUsageEvent,
  safeUsageTrustState,
} from '../db/observability/usage-event.js';
import { runAnchorSearch, anchorRefusalCoverage } from '../cli/anchor-search.js';
import { AnchorRefusalError } from '../scanner/anchors/anchor-refusal.js';
import { buildAnchorReport, buildAnchorRefusalReport } from '../cli/anchors-envelope.js';

/** Confidence classes delta/trace understand. Mirrors the CLI guard (`src/cli/delta.ts`): an
 *  out-of-enum `min_confidence` (e.g. "high") must NOT reach the reverse-walk as an unknown class —
 *  its rank would be `undefined`, the floor comparison always false, and the agent would get a
 *  confidently-wrong EMPTY (non-truncated) result. Fall back to the documented default instead. */
const CONFIDENCE_CLASSES: readonly ConfidenceClass[] = [
  'proven',
  'artifact-backed',
  'framework-inferred',
  'heuristic',
];

function resolveMinConfidence(value: unknown): ConfidenceClass {
  return typeof value === 'string' && (CONFIDENCE_CLASSES as readonly string[]).includes(value)
    ? (value as ConfidenceClass)
    : 'framework-inferred';
}

// Single runtime resolution shared by the read tools. corpusPath/dbPath are byte-identical to the
// prior resolveCorpusPath/resolveDbPath derivation; the full RuntimePathResolution additionally
// carries corpusSource/dbSource for the index/overlay status payloads (buildIndexStatusPayload).
const DEFAULT_RUNTIME = resolveRuntimePaths({
  corpus: process.env.LUX_CORPUS_PATH,
  db: process.env.LUX_DB_PATH,
});
const DEFAULT_CORPUS_PATH = DEFAULT_RUNTIME.corpusPath;
const DEFAULT_DB_PATH = DEFAULT_RUNTIME.dbPath;

const db = new LuxDatabase(DEFAULT_DB_PATH);

const server = new Server(
  {
    name: 'lux',
    version: LUX_VERSION,
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Tool definitions
const TOOLS: Tool[] = [
  {
    name: 'lux_search',
    description:
      'Search all indexed documents. Returns document title and file path. Optionally filter by entity type.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query string',
        },
        type: {
          type: 'string',
          enum: ['all', 'knowledge'],
          description: 'Filter by entity type',
          default: 'all',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results',
          default: 20,
        },
        content_only: {
          type: 'boolean',
          description: 'Scope the query to file content only (whole-expression column filter).',
        },
        snippets: {
          type: 'boolean',
          description: 'Include a query-centered FTS5 snippet per result.',
        },
        with: {
          type: 'array',
          items: { type: 'string' },
          description:
            "Federate across registered siblings by name (or ['all']). Returns repo-grouped, " +
            'independently-ranked result groups plus a per-sibling freshness block.',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'lux_log_event',
    description: 'Log an event to the audit trail for tracking system activity.',
    inputSchema: {
      type: 'object',
      properties: {
        source: {
          type: 'string',
          description: 'Event source (e.g., mcp, cli, scanner)',
        },
        event_type: {
          type: 'string',
          description: 'Type of event',
        },
        summary: {
          type: 'string',
          description: 'Event summary',
        },
        payload: {
          type: 'object',
          description: 'Additional event data (optional)',
        },
      },
      required: ['source', 'event_type', 'summary'],
    },
  },
  {
    name: 'lux_get_file',
    description: 'Read and return the content of an indexed file by path.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: 'Absolute or relative file path',
        },
      },
      required: ['file_path'],
    },
  },
  {
    name: 'lux_rebuild_index',
    description:
      'Rebuild the entire index by scanning the content directory. Run this after content files are updated.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'lux_spec_derivation_evidence',
    description:
      'Return a SpecDerivationEvidencePacketV1 for one route, handler, job, listener, or command target. Lux returns source evidence only; it does not write or approve specifications.',
    inputSchema: {
      type: 'object',
      properties: {
        question: {
          type: 'string',
          description: 'Evidence question for the downstream specification system.',
        },
        target: {
          type: 'string',
          description: 'Single target identifier to resolve.',
        },
        kind: {
          type: 'string',
          enum: ['route', 'handler', 'job', 'listener', 'command'],
          description: 'Target seed kind.',
        },
      },
      required: ['question', 'target', 'kind'],
    },
  },
  {
    name: 'lux_trace',
    description:
      'Trace calls from a symbol across the app→vendor boundary. Follows calls/references ' +
      'edges multi-hop into merged vendor nodes; synchronous framework calls reach the ' +
      'resolving in-vendor method, dynamic-dispatch calls (dispatch/event) reach the ' +
      'dispatch machinery and are marked as re-entry-deferred boundaries. Returns an ' +
      'annotated node/edge graph.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: {
          type: 'string',
          description:
            'Start symbol: a structural node id, a PHP FQN (Ns\\Class::method), or a leaf name.',
        },
        depth: { type: 'number', description: 'Max hops to follow', default: 8 },
        max_nodes: { type: 'number', description: 'Total node budget', default: 2000 },
        edge_types: {
          type: 'array',
          items: { type: 'string' },
          description: 'Edge types to follow',
          default: ['calls', 'references'],
        },
        min_confidence: {
          type: 'string',
          enum: ['proven', 'artifact-backed', 'framework-inferred', 'heuristic'],
          description: 'Lowest confidence class to follow',
          default: 'framework-inferred',
        },
        include_external: {
          type: 'boolean',
          description: 'Follow edges into vendor nodes',
          default: true,
        },
        with: {
          type: 'array',
          items: { type: 'string' },
          description:
            "Federate across registered siblings by name (or ['all']). Crosses repo boundaries " +
            'only on portable ids (namespace-qualified PHP FQCNs; HTTP surfaces toward the kernel).',
        },
      },
      required: ['symbol'],
    },
  },
  {
    name: 'lux_anchors',
    description:
      'Rank structural-node anchors (symbols) from a natural-language concept query. Returns real ' +
      'structural node ids that lux_trace / feature-path / deps accept verbatim — the entry points ' +
      'for the structural ops on concept-spread questions. Symbols/entry points; for documents/' +
      'content use lux_search.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The concept to mint anchors from' },
        limit: { type: 'number', description: 'Maximum anchors to return', default: 10 },
      },
      required: ['query'],
    },
  },
  {
    name: 'lux_delta',
    description:
      'Analyze what a git change touches structurally: touched symbols and declared surfaces, ' +
      'downstream HTTP/operational entry surfaces (with honest async-boundary annotations), module ' +
      'dependents, kernel/client ownership transitions, and invalidated spec-evidence targets. ' +
      'Read-only with respect to structural state. Returns the schemaVersion:1 delta envelope.',
    inputSchema: {
      type: 'object',
      properties: {
        base: {
          type: 'string',
          description: 'Diff baseline ref/SHA (default: the index last_indexed_commit)',
        },
        committed_only: {
          type: 'boolean',
          description: 'Exclude uncommitted working-tree changes',
          default: false,
        },
        depth: { type: 'number', description: 'Reverse-walk depth budget', default: 6 },
        max_nodes: { type: 'number', description: 'Reverse-walk node budget', default: 2000 },
        min_confidence: {
          type: 'string',
          enum: ['proven', 'artifact-backed', 'framework-inferred', 'heuristic'],
          description: 'Lowest confidence class to follow',
          default: 'framework-inferred',
        },
        against: {
          type: 'array',
          items: { type: 'string' },
          description:
            "Report cross-repo impact in registered siblings by name (or ['all']). Read-only join; " +
            'the sibling entry surfaces this diff affects.',
        },
      },
    },
  },
  {
    name: 'lux_deps_impact',
    description:
      'Analyze the blast radius of a change to a file: resolve the file to its module and return ' +
      'every module that depends on it, with per-dependent reference counts and sample files. ' +
      'Read-only. Mirrors `lux deps impact <file>`.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description:
            'File to analyze (absolute, or relative to the corpus root). Resolved to its module ' +
            'via the detected module boundaries.',
        },
      },
      required: ['file_path'],
    },
  },
  {
    name: 'lux_overlay_status',
    description:
      'Report the structural-overlay trust state (overlay-complete / degraded-overlay / ' +
      'content-only / none), surface and node counts, the runtime corpus/db resolution, and ' +
      'working-tree freshness (indexed commit vs HEAD, dirty structural files). Read-only. ' +
      'Mirrors `lux overlay status --json`.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'lux_index_status',
    description:
      'Report index freshness: knowledge/event stats, structural-overlay trust state, the runtime ' +
      'corpus/db resolution, and working-tree freshness (indexed commit vs HEAD, dirty structural ' +
      'files). Read-only. Mirrors `lux index status --json`.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
];

// Tool handlers
server.setRequestHandler(ListToolsRequestSchema, () => {
  return { tools: TOOLS };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case 'lux_search': {
        const {
          query,
          type = 'all',
          limit = 20,
        } = args as {
          query: string;
          type?: string;
          limit?: number;
        };
        // Validate/coerce the limit BEFORE it can reach `LIMIT ?` on EITHER branch (M2). An
        // injectable agent limit (negative → unbounded dump, 0 → fabricated empty, non-integer →
        // WASM hard-abort) is neutralized by the same shared rule the CLI/federated paths use.
        const safeLimit = coerceSearchLimit(limit);

        // Federated branch (Decision 5): opt-in via `with`, strictly additive. The single-repo path
        // below is unchanged. Sibling handles are read-only and closed in a finally (SC-7).
        const searchWith = Array.isArray(args?.with) ? (args.with as string[]) : undefined;
        if (searchWith && searchWith.length) {
          const fed = openFederationHandles(db, DEFAULT_CORPUS_PATH, searchWith);
          try {
            let result;
            try {
              result = runFederatedSearch(db, fed.handles, query, fed.federation, safeLimit);
            } catch (error) {
              if (!(error instanceof SearchRefusalError)) throw error; // outer catch renders it
              // M1: an invalid FTS5 query fails identically for every group including `main`, so it is
              // a query-level refusal, not a per-sibling degrade. Surface the same structured refusal
              // (isError + refusal.reason, expression echoed) the single-repo path returns.
              emitUsageEvent(db, {
                source: 'mcp',
                surface: 'search',
                action: 'query',
                invocationId: createInvocationId(),
                commandOutcome: 'error',
                retrievalOutcome: 'refused',
                exitCode: 1,
                corpusPath: DEFAULT_CORPUS_PATH,
                dbPath: DEFAULT_DB_PATH,
                queryText: query,
                attributes: {
                  federated: true,
                  with: fed.handles.map((h) => h.name),
                  type,
                  limit: safeLimit,
                },
                error: {
                  code: error.reason === 'invalid-query' ? 'invalid_query' : 'fts_unavailable',
                },
              });
              return {
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify(
                      buildSearchRefusalReport({
                        query,
                        type: type === 'knowledge' ? 'knowledge' : 'all',
                        contentOnly: false,
                        limit: safeLimit,
                        refusal: {
                          reason: error.reason,
                          expression: error.expression,
                          message: error.message,
                        },
                      }),
                      null,
                      2
                    ),
                  },
                ],
                isError: true,
              };
            }
            emitUsageEvent(db, {
              source: 'mcp',
              surface: 'search',
              action: 'query',
              invocationId: createInvocationId(),
              commandOutcome: 'success',
              // m7: derive answered/unresolved from union non-emptiness (now invalid-query re-throws),
              // so a federated zero-result feeds usage clustering like a single-repo one.
              retrievalOutcome: result.groups.some((g) => g.results.length > 0)
                ? 'answered'
                : 'unresolved',
              exitCode: 0,
              corpusPath: DEFAULT_CORPUS_PATH,
              dbPath: DEFAULT_DB_PATH,
              queryText: query,
              attributes: {
                federated: true,
                with: fed.handles.map((h) => h.name),
                type,
                limit: safeLimit,
              },
            });
            return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
          } finally {
            fed.close();
          }
        }

        const contentOnly = args?.content_only === true;
        const snippets = args?.snippets === true;

        let ranked: RankedSearchResult[];
        try {
          ranked = db.searchDocumentsRanked(query, { contentOnly, snippets, limit: safeLimit });
        } catch (error) {
          if (error instanceof SearchRefusalError) {
            const report = buildSearchRefusalReport({
              query,
              type: type === 'knowledge' ? 'knowledge' : 'all',
              contentOnly,
              limit: safeLimit,
              refusal: {
                reason: error.reason,
                expression: error.expression,
                message: error.message,
              },
            });
            emitUsageEvent(db, {
              source: 'mcp',
              surface: 'search',
              action: 'query',
              invocationId: createInvocationId(),
              commandOutcome: 'error',
              retrievalOutcome: 'refused',
              exitCode: 1,
              corpusPath: DEFAULT_CORPUS_PATH,
              dbPath: DEFAULT_DB_PATH,
              queryText: query,
              attributes: { type, contentOnly, limit: safeLimit },
              error: {
                code: error.reason === 'invalid-query' ? 'invalid_query' : 'fts_unavailable',
              },
            });
            return {
              content: [{ type: 'text', text: JSON.stringify(report, null, 2) }],
              isError: true,
            };
          }
          throw error;
        }

        const report = buildSearchReport({
          query,
          type: type === 'knowledge' ? 'knowledge' : 'all',
          contentOnly,
          limit: safeLimit,
          results: ranked,
        });

        db.insertEvent({
          source: 'mcp',
          event_type: 'search',
          summary: `Search query: "${query}" (type: ${type}, results: ${ranked.length})`,
          payload: { query, type, limit: safeLimit, results_count: ranked.length },
        });
        emitUsageEvent(db, {
          source: 'mcp',
          surface: 'search',
          action: 'query',
          invocationId: createInvocationId(),
          commandOutcome: 'success',
          retrievalOutcome: ranked.length > 0 ? 'answered' : 'unresolved',
          exitCode: 0,
          corpusPath: DEFAULT_CORPUS_PATH,
          dbPath: DEFAULT_DB_PATH,
          queryText: query,
          attributes: { type, contentOnly, limit: safeLimit, resultsCount: ranked.length },
        });

        return { content: [{ type: 'text', text: JSON.stringify(report, null, 2) }] };
      }

      case 'lux_log_event': {
        const { source, event_type, summary, payload } = args as {
          source: string;
          event_type: string;
          summary: string;
          payload?: Record<string, unknown>;
        };

        db.insertEvent({
          source,
          event_type,
          summary,
          payload,
        });

        return {
          content: [{ type: 'text', text: JSON.stringify({ success: true }, null, 2) }],
        };
      }

      case 'lux_get_file': {
        const { file_path } = args as { file_path: string };

        try {
          const content = readFileSync(file_path, 'utf-8');
          return {
            content: [{ type: 'text', text: content }],
          };
        } catch (error) {
          return {
            content: [{ type: 'text', text: `Error reading file: ${String(error)}` }],
            isError: true,
          };
        }
      }

      case 'lux_rebuild_index': {
        const scanner = new GeneralScanner(DEFAULT_CORPUS_PATH);
        const { result, scanResult } = await rebuildWithOverlay(db, DEFAULT_CORPUS_PATH);
        const indexedScan = {
          ...scanResult.scan,
          knowledge: scanResult.scan.knowledge.map((entry) =>
            attachEnrichment(entry, scanResult.enrichments)
          ),
        };

        await scanner.index(db, indexedScan);
        if (scanResult.dependencies.length > 0) {
          db.clearModuleDependencies();
          for (const dep of scanResult.dependencies) {
            db.insertModuleDependency({
              source_module: dep.source_module,
              target_module: dep.target_module,
              reference_count: dep.reference_count,
              sample_files: JSON.stringify(dep.sample_files),
            });
          }
        }

        const headCommit = isGitRepository(DEFAULT_CORPUS_PATH)
          ? getHeadCommit(DEFAULT_CORPUS_PATH)
          : null;
        if (headCommit) db.setIndexMetadata('last_indexed_commit', headCommit);
        const trustState = persistRebuildTrustState(db, result, {
          lastIndexedCommit: headCommit ?? undefined,
        });

        db.insertEvent({
          source: 'mcp',
          event_type: 'index_rebuild',
          summary: `Indexed ${scanResult.scan.knowledge.length} knowledge entries with ${result.surfaceCount} overlay surfaces`,
        });
        emitUsageEvent(db, {
          source: 'mcp',
          surface: 'index-rebuild',
          action: 'overlay-complete',
          invocationId: createInvocationId(),
          commandOutcome: 'success',
          retrievalOutcome: 'not_applicable',
          trustState: safeUsageTrustState(trustState.mode),
          exitCode: 0,
          corpusPath: DEFAULT_CORPUS_PATH,
          dbPath: DEFAULT_DB_PATH,
          repoCommit: headCommit ?? undefined,
          attributes: {
            knowledgeEntries: scanResult.scan.knowledge.length,
            surfaceCount: result.surfaceCount,
          },
        });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  success: true,
                  indexed: {
                    knowledge: scanResult.scan.knowledge.length,
                  },
                  overlay: {
                    mode: trustState.mode,
                    trustLevel:
                      trustState.mode === 'overlay-complete'
                        ? 'overlay-complete'
                        : trustState.mode === 'content-only'
                          ? 'content-only'
                          : 'degraded-overlay',
                    surfaceCount: trustState.surfaceCount,
                    fileNodeCount: trustState.fileNodeCount,
                    symbolNodeCount: trustState.symbolNodeCount,
                    warnings: trustState.warnings,
                  },
                  runtime: {
                    corpusPath: DEFAULT_CORPUS_PATH,
                    dbPath: DEFAULT_DB_PATH,
                  },
                },
                null,
                2
              ),
            },
          ],
        };
      }

      case 'lux_spec_derivation_evidence': {
        const { question, target, kind } = args as {
          question: string;
          target: string;
          kind: string;
        };

        const invocationId = createInvocationId();
        const startedAt = Date.now();
        const result = executeSpecEvidenceAsk(db, question, {
          target,
          kind,
          json: true,
          corpusPath: DEFAULT_CORPUS_PATH,
          dbPath: DEFAULT_DB_PATH,
        });
        emitUsageEvent(db, {
          source: 'mcp',
          surface: 'spec-evidence',
          action: 'ask',
          invocationId,
          commandOutcome: result.exitCode === 0 ? 'success' : 'error',
          retrievalOutcome:
            result.packet.target.resolutionState === 'resolved'
              ? 'answered'
              : result.packet.target.resolutionState === 'ambiguous'
                ? 'ambiguous'
                : 'unresolved',
          trustState: result.packet.sourceScope.trustState,
          durationMs: Date.now() - startedAt,
          exitCode: result.exitCode,
          corpusPath: DEFAULT_CORPUS_PATH,
          dbPath: DEFAULT_DB_PATH,
          queryText: question,
          normalizedIntent: result.packet.target.kind,
        });

        return {
          content: [{ type: 'text', text: JSON.stringify(result.packet, null, 2) }],
          isError: result.exitCode !== 0,
        };
      }

      case 'lux_trace': {
        const {
          symbol,
          depth = 8,
          max_nodes: maxNodes = 2000,
          edge_types: edgeTypes = ['calls', 'references'],
          min_confidence: minConfidence = 'framework-inferred',
          include_external: includeExternal = true,
        } = args as {
          symbol: string;
          depth?: number;
          max_nodes?: number;
          edge_types?: string[];
          min_confidence?: string;
          include_external?: boolean;
        };

        const resolved = resolveStartNode(db, symbol);
        if ('notFound' in resolved) {
          return {
            content: [
              {
                type: 'text',
                text: `No structural symbol found for: ${symbol}. Rebuild the index or pass a fully-qualified name.`,
              },
            ],
            isError: true,
          };
        }
        if ('ambiguous' in resolved) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    ambiguous: true,
                    candidates: resolved.ambiguous.map((c) => ({
                      id: c.id,
                      name: c.qualified_name ?? c.symbol_name,
                    })),
                  },
                  null,
                  2
                ),
              },
            ],
            isError: true,
          };
        }

        // Federated branch (Decision 5): opt-in via `with`, strictly additive. Returns BEFORE the
        // plain traceFrom below. Sibling handles are read-only and closed in a finally (SC-7).
        const traceWith = Array.isArray(args?.with) ? (args.with as string[]) : undefined;
        if (traceWith && traceWith.length) {
          const fed = openFederationHandles(db, DEFAULT_CORPUS_PATH, traceWith);
          try {
            const result = traceFromFederated(db, fed.handles, resolved.nodeId, fed.federation, {
              maxDepth: depth,
              maxNodes,
              edgeTypes: edgeTypes as EdgeType[],
              minConfidenceClass: minConfidence as ConfidenceClass,
              includeExternal,
            });
            emitUsageEvent(db, {
              source: 'mcp',
              surface: 'trace',
              action: 'query',
              invocationId: createInvocationId(),
              commandOutcome: 'success',
              retrievalOutcome: 'answered',
              exitCode: 0,
              corpusPath: DEFAULT_CORPUS_PATH,
              dbPath: DEFAULT_DB_PATH,
              queryText: symbol,
              attributes: {
                federated: true,
                with: fed.handles.map((h) => h.name),
                nodeCount: result.stats.nodeCount,
                bridged: result.stats.bridgedCount,
              },
            });
            return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
          } finally {
            fed.close();
          }
        }

        const result = traceFrom(db, resolved.nodeId, {
          maxDepth: depth,
          maxNodes,
          edgeTypes: edgeTypes as EdgeType[],
          minConfidenceClass: minConfidence as ConfidenceClass,
          includeExternal,
        });

        db.insertEvent({
          source: 'mcp',
          event_type: 'trace',
          summary: `Traced ${symbol}: ${result.stats.nodeCount} nodes, ${result.stats.dispatchBoundaries} dispatch boundaries`,
          payload: { symbol, depth, nodeCount: result.stats.nodeCount },
        });
        emitUsageEvent(db, {
          source: 'mcp',
          surface: 'trace',
          action: 'query',
          invocationId: createInvocationId(),
          commandOutcome: 'success',
          retrievalOutcome: 'answered',
          exitCode: 0,
          corpusPath: DEFAULT_CORPUS_PATH,
          dbPath: DEFAULT_DB_PATH,
          queryText: symbol,
          attributes: { nodeCount: result.stats.nodeCount, external: result.stats.externalCount },
        });

        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      case 'lux_delta': {
        const base = typeof args?.base === 'string' ? args.base : undefined;
        // Cross-repo impact (Decision 9): `against` names registered siblings; computeDelta resolves
        // + opens/closes their read-only handles internally, so the handler only forwards the names.
        // An unresolvable name surfaces as attached:false in crossRepoImpact, never silently dropped.
        const against = Array.isArray(args?.against) ? (args.against as string[]) : undefined;
        // --base is validated inside computeDelta (resolveDeltaBase → isSafeGitRef) BEFORE any git
        // call (Decision 17). MCP exposes this verb to prompt-injectable agents, so validation +
        // argv-form git (no shell) is mandatory here, not optional hardening.
        const result = computeDelta(db, DEFAULT_CORPUS_PATH, {
          base,
          committedOnly: args?.committed_only === true,
          depth: typeof args?.depth === 'number' ? args.depth : 6,
          maxNodes: typeof args?.max_nodes === 'number' ? args.max_nodes : 2000,
          maxFanout: 64,
          minConfidence: resolveMinConfidence(args?.min_confidence),
          against,
          json: true,
        });
        emitUsageEvent(db, {
          source: 'mcp',
          surface: 'delta',
          action: 'analyze',
          commandOutcome: 'refusal' in result ? 'error' : 'success',
          trustState:
            'refusal' in result ? 'unknown' : safeUsageTrustState(result.report.trust.overlay),
          corpusPath: DEFAULT_CORPUS_PATH,
          dbPath: DEFAULT_DB_PATH,
          // Federated dimensions only when `against` is set — a non-federated delta event is
          // byte-identical to the shipped shape (SC-9 / spec 15A).
          ...(against && against.length
            ? {
                attributes: {
                  federated: true,
                  against,
                  crossRepoSiblings:
                    'refusal' in result
                      ? 0
                      : (result.report.crossRepoImpact?.siblings.filter((s) => s.attached).length ??
                        0),
                },
              }
            : {}),
        });
        const payload = 'refusal' in result ? { error: result.refusal } : result.report;
        return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
      }

      case 'lux_anchors': {
        const { query = '', limit: rawLimit = 10 } = args as { query?: string; limit?: number };
        const limit = Number.isFinite(rawLimit) && rawLimit >= 1 ? Math.trunc(rawLimit) : 10;
        try {
          const result = await runAnchorSearch(db, query, {
            limit,
            corpusPath: DEFAULT_CORPUS_PATH,
          });
          const report = buildAnchorReport({
            query,
            limit,
            results: result.results,
            lowConfidence: result.lowConfidence,
            coverage: result.coverage,
          });
          emitUsageEvent(db, {
            source: 'mcp',
            surface: 'anchors',
            action: 'query',
            invocationId: createInvocationId(),
            commandOutcome: 'success',
            retrievalOutcome: result.results.length > 0 ? 'answered' : 'unresolved',
            exitCode: 0,
            corpusPath: DEFAULT_CORPUS_PATH,
            dbPath: DEFAULT_DB_PATH,
            queryText: query,
            attributes: {
              limit,
              resultsCount: result.results.length,
              lowConfidence: result.lowConfidence,
            },
          });
          return { content: [{ type: 'text', text: JSON.stringify(report, null, 2) }] };
        } catch (error) {
          if (error instanceof AnchorRefusalError) {
            const report = buildAnchorRefusalReport({
              query,
              limit,
              // Accurate anchor-viable count even for a non-overlay refusal over a populated index
              // (anchor-search.ts anchorRefusalCoverage); a genuine 0 for overlay/texts-absent.
              coverage: anchorRefusalCoverage(db),
              refusal: {
                reason: error.reason,
                expression: error.expression,
                message: error.message,
              },
            });
            emitUsageEvent(db, {
              source: 'mcp',
              surface: 'anchors',
              action: 'query',
              invocationId: createInvocationId(),
              commandOutcome: 'error',
              retrievalOutcome: 'refused',
              exitCode: 1,
              corpusPath: DEFAULT_CORPUS_PATH,
              dbPath: DEFAULT_DB_PATH,
              queryText: query,
              attributes: { limit },
              error: { code: error.reason },
            });
            return {
              content: [{ type: 'text', text: JSON.stringify(report, null, 2) }],
              isError: true,
            };
          }
          throw error;
        }
      }

      case 'lux_deps_impact': {
        const { file_path: filePath } = args as { file_path: string };

        // Shared blast-radius computation — the CLI `deps impact` action calls the same
        // computeImpact (src/cli/deps-impact.ts); the MCP layer does not fork the query.
        const result = computeImpact(db, DEFAULT_CORPUS_PATH, filePath);

        if (!result.resolved) {
          emitUsageEvent(db, {
            source: 'mcp',
            surface: 'deps-impact',
            action: 'query',
            invocationId: createInvocationId(),
            commandOutcome: 'error',
            retrievalOutcome: 'unresolved',
            exitCode: 1,
            corpusPath: DEFAULT_CORPUS_PATH,
            dbPath: DEFAULT_DB_PATH,
            queryText: filePath,
            error: { code: 'module_unresolved' },
          });
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    error: 'module-unresolved',
                    file: result.file,
                    message: `Could not resolve file to a module: ${result.file}`,
                  },
                  null,
                  2
                ),
              },
            ],
            isError: true,
          };
        }

        emitUsageEvent(db, {
          source: 'mcp',
          surface: 'deps-impact',
          action: 'query',
          invocationId: createInvocationId(),
          commandOutcome: 'success',
          retrievalOutcome: 'answered',
          exitCode: 0,
          corpusPath: DEFAULT_CORPUS_PATH,
          dbPath: DEFAULT_DB_PATH,
          queryText: filePath,
          attributes: {
            module: result.impact.module,
            dependentModules: result.impact.blastRadius.modules,
            totalReferences: result.impact.blastRadius.totalReferences,
          },
        });

        return { content: [{ type: 'text', text: JSON.stringify(result.impact, null, 2) }] };
      }

      case 'lux_overlay_status': {
        // Reuses the canonical status-payload builder shared with `lux overlay status --json`.
        const payload = buildOverlayStatusPayload(db, DEFAULT_RUNTIME);
        // With a runtime passed, payload is the {overlay,runtime,freshness} shape; narrow to read
        // the trust level for the usage event (both OverlayTrustPayload variants carry trustLevel).
        const overlayTrust = 'overlay' in payload ? payload.overlay : payload;
        emitUsageEvent(db, {
          source: 'mcp',
          surface: 'overlay-status',
          action: 'status',
          invocationId: createInvocationId(),
          commandOutcome: 'success',
          retrievalOutcome: 'not_applicable',
          trustState: safeUsageTrustState(overlayTrust.trustLevel),
          exitCode: 0,
          corpusPath: DEFAULT_CORPUS_PATH,
          dbPath: DEFAULT_DB_PATH,
          attributes: { trustLevel: overlayTrust.trustLevel },
        });
        return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
      }

      case 'lux_index_status': {
        // Reuses the canonical status-payload builder shared with `lux index status --json`.
        const payload = buildIndexStatusPayload(db, DEFAULT_RUNTIME);
        emitUsageEvent(db, {
          source: 'mcp',
          surface: 'index-status',
          action: 'status',
          invocationId: createInvocationId(),
          commandOutcome: 'success',
          retrievalOutcome: 'not_applicable',
          trustState: safeUsageTrustState(payload.overlay.trustLevel),
          exitCode: 0,
          corpusPath: DEFAULT_CORPUS_PATH,
          dbPath: DEFAULT_DB_PATH,
          attributes: { trustLevel: payload.overlay.trustLevel },
        });
        return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
      }

      default:
        return {
          content: [{ type: 'text', text: `Unknown tool: ${name}` }],
          isError: true,
        };
    }
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${String(error)}` }],
      isError: true,
    };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Lux MCP server running on stdio');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
