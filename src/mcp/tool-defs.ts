import type { Tool } from '@modelcontextprotocol/sdk/types.js';

/**
 * Canonical MCP tool-definition array — the single source of truth for the tool surface the
 * ListTools handler exposes. `src/mcp/server.ts` imports this for the wire handler, and
 * `scripts/verify-docs-surface.ts` imports the SAME array to assert the three docs-surface lists
 * (docs/MCP-TOOLS.md, README.md, CLAUDE.md) never drift from it.
 *
 * This module is deliberately SIDE-EFFECT-FREE — its only import is the `Tool` type (erased at
 * runtime). server.ts, by contrast, constructs the database and connects the stdio transport at
 * module load; the docs-surface guard must be able to read the registry WITHOUT triggering any of
 * that, which is exactly why the definitions live here rather than in server.ts.
 */
export const TOOLS: Tool[] = [
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
