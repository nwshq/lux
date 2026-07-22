#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { LuxDatabase } from '../db/index.js';
import { GeneralScanner } from '../scanner/index.js';
import { attachEnrichment } from '../scanner/general.js';
import { rebuildWithOverlay } from '../scanner/rebuild-orchestrator.js';
import { persistRebuildTrustState } from '../scanner/overlay-trust-state.js';
import { readFileSync } from 'fs';
import { resolveCorpusPath, resolveDbPath } from '../utils/runtime-paths.js';
import { getHeadCommit, isGitRepository } from '../scanner/git.js';
import { executeSpecEvidenceAsk } from '../cli/spec-evidence.js';
import { resolveStartNode, traceFrom } from '../scanner/associations/trace.js';
import { traceFromFederated } from '../scanner/associations/federation-trace.js';
import { runFederatedSearch } from '../scanner/search-federation.js';
import { openFederationHandles } from './federation-handles.js';
import { computeDelta } from '../scanner/delta/run.js';
import type { ConfidenceClass, EdgeType } from '../db/types.js';
import {
  createInvocationId,
  emitUsageEvent,
  safeUsageTrustState,
} from '../db/observability/usage-event.js';

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

const DEFAULT_CORPUS_PATH = resolveCorpusPath({ corpus: process.env.LUX_CORPUS_PATH });
const DEFAULT_DB_PATH = resolveDbPath({
  corpus: DEFAULT_CORPUS_PATH,
  db: process.env.LUX_DB_PATH,
});

const db = new LuxDatabase(DEFAULT_DB_PATH);

const server = new Server(
  {
    name: 'lux',
    version: '0.1.0',
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

        // Federated branch (Decision 5): opt-in via `with`, strictly additive. The single-repo path
        // below is unchanged. Sibling handles are read-only and closed in a finally (SC-7).
        const searchWith = Array.isArray(args?.with) ? (args.with as string[]) : undefined;
        if (searchWith && searchWith.length) {
          const fed = openFederationHandles(db, DEFAULT_CORPUS_PATH, searchWith);
          try {
            const result = runFederatedSearch(db, fed.handles, query, fed.federation, limit);
            emitUsageEvent(db, {
              source: 'mcp',
              surface: 'search',
              action: 'query',
              invocationId: createInvocationId(),
              commandOutcome: 'success',
              retrievalOutcome: 'not_applicable',
              exitCode: 0,
              corpusPath: DEFAULT_CORPUS_PATH,
              dbPath: DEFAULT_DB_PATH,
              queryText: query,
              attributes: { federated: true, with: fed.handles.map((h) => h.name), type, limit },
            });
            return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
          } finally {
            fed.close();
          }
        }

        const results: Array<{
          type: string;
          title: string;
          path: string;
          context?: string;
        }> = [];

        try {
          if (type === 'all') {
            // Unified document search across all entity types
            const docs = db.searchAllDocuments(query);
            for (const doc of docs) {
              results.push({
                type: 'document',
                title: doc.title,
                path: doc.file_path,
              });
            }
          } else if (type === 'knowledge') {
            const entries = db.searchKnowledgeEntries(query);
            for (const entry of entries) {
              results.push({
                type: 'knowledge',
                title: entry.title,
                path: entry.file_path,
                context: entry.type,
              });
            }
          }
        } catch (error) {
          const message = [
            'FTS5 search unavailable.',
            `Cause: ${(error as Error).message}`,
            'Run `lux migrate up` and `lux index rebuild`, then try again.',
          ].join(' ');

          console.error(message);
          return {
            content: [{ type: 'text', text: message }],
            isError: true,
          };
        }

        // Log search event
        db.insertEvent({
          source: 'mcp',
          event_type: 'search',
          summary: `Search query: "${query}" (type: ${type}, results: ${results.length})`,
          payload: {
            query,
            type,
            limit,
            results_count: results.length,
          },
        });
        emitUsageEvent(db, {
          source: 'mcp',
          surface: 'search',
          action: 'query',
          invocationId: createInvocationId(),
          commandOutcome: 'success',
          retrievalOutcome: 'not_applicable',
          exitCode: 0,
          corpusPath: DEFAULT_CORPUS_PATH,
          dbPath: DEFAULT_DB_PATH,
          queryText: query,
          attributes: { type, limit, resultsCount: results.length },
        });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(results.slice(0, limit), null, 2),
            },
          ],
        };
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
