import type { LuxDatabase } from '../db/index.js';
import type { Expert } from '../db/types.js';
import type { ExpertSessionManager, QueryResult } from './session-manager.js';

/** An expert matched by FTS5 search with a relevance score. */
export interface ScoredExpert {
  expert: Expert;
  /** Number of FTS5 hits whose file_path falls under this expert's mount_path. */
  hits: number;
  /** Sum of FTS5 rank scores (lower is more relevant in SQLite FTS5). */
  score: number;
}

/** Result from routing a query to one or more experts. */
export interface RouteResult {
  /** The original query. */
  query: string;
  /** Experts that were matched, ordered by relevance (highest first). */
  matchedExperts: ScoredExpert[];
  /** Individual responses from each queried expert. */
  responses: QueryResult[];
  /** Synthesized response when multiple experts contributed. */
  synthesis?: string;
}

export interface RouterOptions {
  /** Maximum number of experts to query for a single route. Defaults to 3. */
  maxExperts?: number;
  /** Minimum hit count for an expert to be considered relevant. Defaults to 1. */
  minHits?: number;
}

/**
 * Routes a user query to the most relevant expert(s) using FTS5 search.
 *
 * Strategy:
 * 1. Run the query against all FTS5 indexes (knowledge_entries, clients, projects, communications).
 * 2. Collect file_path from each hit and match it against active expert mount_paths.
 * 3. Score experts by hit count (primary) and FTS5 rank sum (secondary).
 * 4. Query the top-N experts in parallel.
 * 5. If multiple experts respond, produce a synthesis prompt.
 */
export async function routeQuery(
  query: string,
  db: LuxDatabase,
  sessionManager: ExpertSessionManager,
  options: RouterOptions = {},
): Promise<RouteResult> {
  const maxExperts = options.maxExperts ?? 3;
  const minHits = options.minHits ?? 1;

  // Get all active experts
  const activeExperts = db.getExpertsByStatus('active');
  if (activeExperts.length === 0) {
    return { query, matchedExperts: [], responses: [] };
  }

  // Score experts using FTS5 search
  const scored = scoreExperts(query, db, activeExperts);

  // Filter by minimum hits and cap at maxExperts
  const qualified = scored
    .filter((s) => s.hits >= minHits)
    .slice(0, maxExperts);

  if (qualified.length === 0) {
    // No FTS5 matches — fall back to querying all active experts (capped)
    const fallback = activeExperts.slice(0, maxExperts);
    const matchedExperts = fallback.map((e) => ({ expert: e, hits: 0, score: 0 }));
    const responses = await queryExperts(fallback, query, sessionManager);
    return {
      query,
      matchedExperts,
      responses,
      synthesis: responses.length > 1 ? synthesize(query, responses) : undefined,
    };
  }

  const experts = qualified.map((s) => s.expert);
  const responses = await queryExperts(experts, query, sessionManager);

  return {
    query,
    matchedExperts: qualified,
    responses,
    synthesis: responses.length > 1 ? synthesize(query, responses) : undefined,
  };
}

/**
 * Score experts by running the query against FTS5 indexes and mapping
 * file_path hits to expert mount_paths.
 */
function scoreExperts(
  query: string,
  db: LuxDatabase,
  experts: Expert[],
): ScoredExpert[] {
  const scores = new Map<string, { expert: Expert; hits: number; score: number }>();

  for (const expert of experts) {
    scores.set(expert.slug, { expert, hits: 0, score: 0 });
  }

  // Sanitize query for FTS5 — wrap each token in quotes to avoid syntax errors
  const ftsQuery = sanitizeFtsQuery(query);
  if (!ftsQuery) {
    return [];
  }

  // Search all FTS5 indexes and collect (file_path, rank) pairs
  const hits = collectFtsHits(ftsQuery, db);

  // Map each hit to the owning expert
  for (const hit of hits) {
    for (const expert of experts) {
      if (isUnderMountPath(hit.filePath, expert.mount_path)) {
        const entry = scores.get(expert.slug)!;
        entry.hits += 1;
        // FTS5 rank is negative; more negative = more relevant.
        // We accumulate the raw rank so lower total = better.
        entry.score += hit.rank;
        break; // one hit maps to at most one expert
      }
    }
  }

  // Sort: most hits first, then by FTS5 rank (lower/more negative = better)
  return Array.from(scores.values())
    .filter((s) => s.hits > 0)
    .sort((a, b) => {
      if (b.hits !== a.hits) return b.hits - a.hits;
      return a.score - b.score; // lower rank sum = more relevant
    });
}

interface FtsHit {
  filePath: string;
  rank: number;
}

/**
 * Collect file_path + rank from all FTS5 tables.
 * Silently returns empty on FTS5 errors (e.g., schema not migrated).
 */
function collectFtsHits(ftsQuery: string, db: LuxDatabase): FtsHit[] {
  const hits: FtsHit[] = [];

  try {
    const knowledgeEntries = db.searchKnowledgeEntries(ftsQuery);
    for (const entry of knowledgeEntries) {
      hits.push({ filePath: entry.file_path, rank: 0 });
    }
  } catch {
    // FTS5 not available for knowledge entries
  }

  try {
    const clients = db.searchClients(ftsQuery);
    for (const client of clients) {
      hits.push({ filePath: client.file_path, rank: 0 });
    }
  } catch {
    // FTS5 not available for clients
  }

  try {
    const projects = db.searchProjects(ftsQuery);
    for (const project of projects) {
      hits.push({ filePath: project.file_path, rank: 0 });
    }
  } catch {
    // FTS5 not available for projects
  }

  try {
    const communications = db.searchCommunications(ftsQuery);
    for (const comm of communications) {
      hits.push({ filePath: comm.file_path, rank: 0 });
    }
  } catch {
    // FTS5 not available for communications
  }

  return hits;
}

/**
 * Check if a file path falls under an expert's mount path.
 * Both paths are compared as normalized strings.
 */
function isUnderMountPath(filePath: string, mountPath: string): boolean {
  const normalizedFile = normalizePath(filePath);
  const normalizedMount = normalizePath(mountPath);
  return normalizedFile.startsWith(normalizedMount);
}

function normalizePath(p: string): string {
  // Ensure trailing separator for prefix matching
  const normalized = p.endsWith('/') ? p : p + '/';
  return normalized;
}

/**
 * Sanitize a user query for FTS5 by wrapping each word token in double quotes.
 * This prevents FTS5 syntax errors from special characters.
 */
export function sanitizeFtsQuery(query: string): string {
  const tokens = query
    .split(/\s+/)
    .map((t) => t.replace(/[^\w*-]/g, ''))
    .filter((t) => t.length > 0);

  if (tokens.length === 0) return '';

  // Use OR to be permissive — any token match counts
  return tokens.map((t) => `"${t}"`).join(' OR ');
}

/**
 * Query multiple experts in parallel, collecting results.
 * Failures for individual experts are caught and skipped.
 */
async function queryExperts(
  experts: Expert[],
  question: string,
  sessionManager: ExpertSessionManager,
): Promise<QueryResult[]> {
  const settled = await Promise.allSettled(
    experts.map((expert) => sessionManager.query(expert.slug, question)),
  );

  const results: QueryResult[] = [];
  for (const outcome of settled) {
    if (outcome.status === 'fulfilled') {
      results.push(outcome.value);
    }
    // Rejected queries are silently skipped — the session manager
    // already logs errors via events.
  }

  return results;
}

/**
 * Produce a synthesis summary when multiple experts respond.
 * Returns a structured markdown string combining all expert responses.
 */
function synthesize(query: string, responses: QueryResult[]): string {
  const parts: string[] = [
    `## Synthesized Response`,
    '',
    `**Query:** ${query}`,
    `**Experts consulted:** ${responses.map((r) => r.expertSlug).join(', ')}`,
    '',
  ];

  for (const response of responses) {
    parts.push(`### ${response.expertSlug}`);
    parts.push('');
    parts.push(response.response);
    parts.push('');
  }

  return parts.join('\n');
}
