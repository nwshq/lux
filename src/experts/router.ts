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
}

export interface RouterOptions {
  /** Maximum number of experts to query for a single route. Defaults to 1. */
  maxExperts?: number;
  /** Minimum hit count for an expert to be considered relevant. Defaults to 1. */
  minHits?: number;
  /** Maximum bytes of context to inject into the augmented query. Defaults to 30720 (~30KB). */
  maxContextBytes?: number;
}

export interface FtsHit {
  filePath: string;
  rank: number;
  content?: string;
  title?: string;
}

interface ScoreResult {
  scored: ScoredExpert[];
  hitsByExpert: Map<string, FtsHit[]>;
}

/**
 * Routes a user query to the most relevant expert using FTS5 search.
 *
 * Strategy:
 * 1. Run the query against all FTS5 indexes (knowledge_entries, clients, projects, communications).
 * 2. Collect file_path + content from each hit and match it against active expert mount_paths.
 * 3. Score experts by hit count (primary) and FTS5 rank sum (secondary).
 * 4. Build an augmented query with retrieved document context for the best expert.
 * 5. Query the single best expert with the enriched prompt.
 */
export async function routeQuery(
  query: string,
  db: LuxDatabase,
  sessionManager: ExpertSessionManager,
  options: RouterOptions = {},
): Promise<RouteResult> {
  const maxExperts = options.maxExperts ?? 1;
  const minHits = options.minHits ?? 1;

  // Get all active experts
  const activeExperts = db.getExpertsByStatus('active');
  if (activeExperts.length === 0) {
    return { query, matchedExperts: [], responses: [] };
  }

  // Score experts using FTS5 search
  const { scored, hitsByExpert } = scoreExperts(query, db, activeExperts);

  // Filter by minimum hits and cap at maxExperts
  const qualified = scored
    .filter((s) => s.hits >= minHits)
    .slice(0, maxExperts);

  if (qualified.length === 0) {
    // No FTS5 matches — fall back to first active expert
    const fallback = activeExperts.slice(0, maxExperts);
    const matchedExperts = fallback.map((e) => ({ expert: e, hits: 0, score: 0 }));
    const responses = await queryExperts(fallback, query, sessionManager);
    return { query, matchedExperts, responses };
  }

  // Build augmented queries per expert, then query
  const responses: QueryResult[] = [];
  for (const se of qualified) {
    const expertHits = hitsByExpert.get(se.expert.slug) ?? [];
    const augmented = buildAugmentedQuery(query, expertHits, options.maxContextBytes);
    const settled = await Promise.allSettled([
      sessionManager.query(se.expert.slug, augmented),
    ]);
    for (const outcome of settled) {
      if (outcome.status === 'fulfilled') {
        responses.push(outcome.value);
      }
    }
  }

  return { query, matchedExperts: qualified, responses };
}

/**
 * Score experts by running the query against FTS5 indexes and mapping
 * file_path hits to expert mount_paths. Also collects hits per expert
 * for later context enrichment.
 */
function scoreExperts(
  query: string,
  db: LuxDatabase,
  experts: Expert[],
): ScoreResult {
  const scores = new Map<string, { expert: Expert; hits: number; score: number }>();
  const hitsByExpert = new Map<string, FtsHit[]>();

  for (const expert of experts) {
    scores.set(expert.slug, { expert, hits: 0, score: 0 });
    hitsByExpert.set(expert.slug, []);
  }

  // Sanitize query for FTS5 — wrap each token in quotes to avoid syntax errors
  const ftsQuery = sanitizeFtsQuery(query);
  if (!ftsQuery) {
    return { scored: [], hitsByExpert };
  }

  // Search all FTS5 indexes and collect (file_path, rank, content, title) tuples
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

        // Collect hit for this expert's context
        hitsByExpert.get(expert.slug)!.push(hit);
        break; // one hit maps to at most one expert
      }
    }
  }

  // Sort: most hits first, then by FTS5 rank (lower/more negative = better)
  const sorted = Array.from(scores.values())
    .filter((s) => s.hits > 0)
    .sort((a, b) => {
      if (b.hits !== a.hits) return b.hits - a.hits;
      return a.score - b.score; // lower rank sum = more relevant
    });

  return { scored: sorted, hitsByExpert };
}

/**
 * Collect file_path + rank + content + title from all FTS5 tables.
 * Silently returns empty on FTS5 errors (e.g., schema not migrated).
 */
function collectFtsHits(ftsQuery: string, db: LuxDatabase): FtsHit[] {
  const hits: FtsHit[] = [];

  try {
    const knowledgeEntries = db.searchKnowledgeEntries(ftsQuery);
    for (const entry of knowledgeEntries) {
      hits.push({
        filePath: entry.file_path,
        rank: 0,
        content: entry.content ?? undefined,
        title: entry.title,
      });
    }
  } catch {
    // FTS5 not available for knowledge entries
  }

  try {
    const clients = db.searchClients(ftsQuery);
    for (const client of clients) {
      hits.push({
        filePath: client.file_path,
        rank: 0,
        content: client.content ?? undefined,
        title: client.name,
      });
    }
  } catch {
    // FTS5 not available for clients
  }

  try {
    const projects = db.searchProjects(ftsQuery);
    for (const project of projects) {
      hits.push({
        filePath: project.file_path,
        rank: 0,
        content: project.content ?? undefined,
        title: project.name,
      });
    }
  } catch {
    // FTS5 not available for projects
  }

  try {
    const communications = db.searchCommunications(ftsQuery);
    for (const comm of communications) {
      hits.push({
        filePath: comm.file_path,
        rank: 0,
        content: comm.content ?? undefined,
        title: comm.subject ?? comm.file_path,
      });
    }
  } catch {
    // FTS5 not available for communications
  }

  return hits;
}

/**
 * Build an augmented query that injects FTS5-retrieved document content
 * as reference material for the expert to synthesize.
 *
 * @param question - The user's original question
 * @param hits - FTS5 hits with content, already ordered by relevance
 * @param maxContextBytes - Maximum bytes for the reference section (~30KB default)
 */
export function buildAugmentedQuery(
  question: string,
  hits: FtsHit[],
  maxContextBytes?: number,
): string {
  const budget = maxContextBytes ?? 30_720;

  // Filter to hits that actually have content
  const contentHits = hits.filter((h) => h.content && h.content.trim().length > 0);

  if (contentHits.length === 0) {
    return question;
  }

  const parts: string[] = [];
  let usedBytes = 0;

  for (const hit of contentHits) {
    const content = hit.content!;
    const label = hit.title ?? hit.filePath;
    const header = `### ${label}\n`;
    const separator = '\n---\n';
    const overhead = Buffer.byteLength(header + separator, 'utf-8');

    const remaining = budget - usedBytes - overhead;
    if (remaining <= 0) break;

    let body: string;
    const contentBytes = Buffer.byteLength(content, 'utf-8');
    if (contentBytes <= remaining) {
      body = content;
    } else {
      // Truncate to fit within remaining budget (rough byte-to-char approximation)
      const truncated = content.slice(0, remaining);
      body = truncated + '\n[...truncated]';
    }

    parts.push(header + body + separator);
    usedBytes += Buffer.byteLength(parts[parts.length - 1], 'utf-8');
  }

  return `Answer the following question using the reference documents provided below.

## Reference Documents

${parts.join('\n')}
## Question

${question}`;
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
