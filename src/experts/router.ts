import { spawn } from 'child_process';
import { readFileSync } from 'fs';
import type { LuxDatabase } from '../db/index.js';
import type { Expert } from '../db/types.js';
import type { ExpertSessionManager, QueryOptions, QueryResult } from './session-manager.js';
import { buildCleanEnv } from '../utils/subprocess-env.js';
import { computeClusters } from '../scanner/imports/clustering.js';

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
  /** How the expert was selected: 'llm' or 'fts5'. */
  routingMethod: 'llm' | 'fts5';
}

export interface RouterOptions {
  /** Maximum number of experts to query for a single route. Defaults to 1. */
  maxExperts?: number;
  /** Minimum hit count for an expert to be considered relevant. Defaults to 1. */
  minHits?: number;
  /** Maximum bytes of context to inject into the augmented query. Defaults to 153600 (~150KB). */
  maxContextBytes?: number;
  /** Use LLM (Haiku) to select the best expert. Defaults to true. */
  useLlmRouting?: boolean;
  /** Model to use for LLM routing. Defaults to claude-haiku-4-5-20251001. */
  routingModel?: string;
  /** Called with each chunk of expert response as it arrives. */
  onChunk?: (chunk: string) => void;
}

export interface FtsHit {
  filePath: string;
  rank: number;
  content?: string;
  title?: string;
  /** Raw metadata JSON string from the database entity. May contain lsp enrichment data. */
  metadata?: string;
}

interface ScoreResult {
  scored: ScoredExpert[];
  hitsByExpert: Map<string, FtsHit[]>;
}

/** Telemetry captured from a single LLM routing call. */
export interface LlmRoutingResult {
  /** The expert slug returned, or null if routing failed. */
  slug: string | null;
  /** The full prompt sent to the routing LLM. */
  prompt: string;
  /** The raw stdout from the LLM (before parsing). Empty on failure. */
  rawResponse: string;
  /** Model used for routing. */
  model: string;
  /** Wall-clock time for the LLM call in milliseconds. */
  durationMs: number;
  /** Error message if the call failed, otherwise null. */
  error: string | null;
}

/**
 * Routes a user query to the most relevant expert.
 *
 * Three-stage routing:
 * 1. FTS5 search — find relevant documents for context enrichment.
 * 2. LLM routing (Haiku) — pick the single best expert given the question + expert roster.
 * 3. Expert query (Sonnet) — send augmented query to chosen expert.
 *
 * FTS5 scoring remains as fallback if LLM routing is disabled or fails.
 */
export async function routeQuery(
  query: string,
  db: LuxDatabase,
  sessionManager: ExpertSessionManager,
  options: RouterOptions = {}
): Promise<RouteResult> {
  const maxExperts = options.maxExperts ?? 1;
  const minHits = options.minHits ?? 1;
  const useLlmRouting = options.useLlmRouting ?? true;
  const queryOpts: QueryOptions | undefined = options.onChunk
    ? { onChunk: options.onChunk }
    : undefined;

  // Get all active experts
  const activeExperts = db.getExpertsByStatus('active');

  if (activeExperts.length === 0) {
    return { query, matchedExperts: [], responses: [], routingMethod: 'fts5' };
  }

  // Stage 1: FTS5 search for context enrichment
  const { scored, hitsByExpert } = scoreExperts(query, db, activeExperts);

  // FTS5 top candidates for telemetry comparison
  const ftsTopN = scored.slice(0, 5).map((s) => ({
    slug: s.expert.slug,
    hits: s.hits,
    score: s.score,
  }));

  // Stage 2: Expert selection — LLM or FTS5 fallback
  let chosenExpert: Expert | null = null;
  let routingMethod: 'llm' | 'fts5' = 'fts5';
  let llmResult: LlmRoutingResult | null = null;

  if (useLlmRouting) {
    llmResult = await selectExpertWithLlm(query, activeExperts, options.routingModel);

    // Log LLM routing telemetry (always, even on failure — that's the point)
    try {
      db.insertEvent({
        source: 'expert-router',
        event_type: 'expert_route_llm',
        summary: llmResult.slug
          ? `LLM selected "${llmResult.slug}" in ${llmResult.durationMs}ms`
          : `LLM routing failed: ${llmResult.error}`,
        payload: {
          question: query,
          model: llmResult.model,
          chosen_slug: llmResult.slug,
          raw_response: llmResult.rawResponse,
          duration_ms: llmResult.durationMs,
          error: llmResult.error,
          prompt: llmResult.prompt,
          expert_count: activeExperts.length,
        },
      });
    } catch {
      // Don't let telemetry failures break routing
    }

    if (llmResult.slug) {
      const found = activeExperts.find((e) => e.slug === llmResult!.slug);
      if (found) {
        chosenExpert = found;
        routingMethod = 'llm';
      }
    }
  }

  // FTS5 fallback if LLM routing was disabled or failed
  if (!chosenExpert) {
    const qualified = scored.filter((s) => s.hits >= minHits).slice(0, maxExperts);

    if (qualified.length === 0) {
      // No FTS5 matches — fall back to first active expert
      const fallback = activeExperts.slice(0, maxExperts);
      const matchedExperts = fallback.map((e) => ({ expert: e, hits: 0, score: 0 }));
      const responses = await queryExperts(fallback, query, sessionManager, queryOpts);
      const result: RouteResult = { query, matchedExperts, responses, routingMethod: 'fts5' };
      logRouteEvent(db, query, result, ftsTopN, llmResult);
      return result;
    }

    // Multi-expert FTS5 path (maxExperts > 1)
    if (qualified.length > 1) {
      const responses: QueryResult[] = [];
      for (const se of qualified) {
        const expertHits = hitsByExpert.get(se.expert.slug) ?? [];
        const augmented = buildAugmentedQuery(query, expertHits, options.maxContextBytes);
        const settled = await Promise.allSettled([
          sessionManager.query(se.expert.slug, augmented, queryOpts),
        ]);
        for (const outcome of settled) {
          if (outcome.status === 'fulfilled') {
            responses.push(outcome.value);
          }
        }
      }
      const result: RouteResult = {
        query,
        matchedExperts: qualified,
        responses,
        routingMethod: 'fts5',
      };
      logRouteEvent(db, query, result, ftsTopN, llmResult);
      return result;
    }

    chosenExpert = qualified[0].expert;
  }

  // Build matched expert entry with FTS5 stats (if any)
  const ftsEntry = scored.find((s) => s.expert.slug === chosenExpert.slug);
  const matchedExperts: ScoredExpert[] = [ftsEntry ?? { expert: chosenExpert, hits: 0, score: 0 }];

  // Collect FTS5 hits under chosen expert's mount_path for context enrichment
  const expertHits = hitsByExpert.get(chosenExpert.slug) ?? [];
  const moduleContext = buildModuleContext(db, expertHits);
  const augmented = buildAugmentedQuery(query, expertHits, options.maxContextBytes, moduleContext);

  // Stage 3: Query the chosen expert
  const responses: QueryResult[] = [];
  const settled = await Promise.allSettled([
    sessionManager.query(chosenExpert.slug, augmented, queryOpts),
  ]);
  for (const outcome of settled) {
    if (outcome.status === 'fulfilled') {
      responses.push(outcome.value);
    }
  }

  const result: RouteResult = { query, matchedExperts, responses, routingMethod };
  logRouteEvent(db, query, result, ftsTopN, llmResult);
  return result;
}

/**
 * Log a routing decision event for after-the-fact analysis.
 * Captures the chosen expert, routing method, FTS5 rankings, and
 * LLM telemetry (if applicable) so you can compare decisions.
 */
function logRouteEvent(
  db: LuxDatabase,
  question: string,
  result: RouteResult,
  ftsTopN: Array<{ slug: string; hits: number; score: number }>,
  llmResult: LlmRoutingResult | null
): void {
  try {
    const chosenSlug = result.matchedExperts[0]?.expert.slug ?? null;
    const ftsWouldPick = ftsTopN[0]?.slug ?? null;

    db.insertEvent({
      source: 'expert-router',
      event_type: 'expert_route',
      summary: `${result.routingMethod.toUpperCase()}-routed to "${chosenSlug}"`,
      payload: {
        question,
        routing_method: result.routingMethod,
        chosen_slug: chosenSlug,
        fts5_top: ftsTopN,
        fts5_would_pick: ftsWouldPick,
        llm_agreed_with_fts5: llmResult?.slug === ftsWouldPick,
        llm_slug: llmResult?.slug ?? null,
        llm_duration_ms: llmResult?.durationMs ?? null,
        llm_model: llmResult?.model ?? null,
        expert_count: result.matchedExperts.length,
        context_hits: result.matchedExperts[0]?.hits ?? 0,
      },
    });
  } catch {
    // Don't let telemetry failures break routing
  }
}

const DEFAULT_ROUTING_MODEL = 'claude-haiku-4-5-20251001';
const ROUTING_TIMEOUT_MS = 30_000;

/**
 * Build a one-line-per-expert roster string for the LLM routing prompt.
 * Each line: `` `{slug}` — {name}: {brief} ``
 *
 * Brief is the first ~200 chars from the expert's claude_md_path file,
 * stripped of markdown headers and frontmatter.
 */
export function buildExpertRoster(experts: Expert[]): string {
  const lines: string[] = [];

  for (const expert of experts) {
    let brief = 'No description available';

    if (expert.claude_md_path) {
      try {
        const raw = readFileSync(expert.claude_md_path, 'utf-8');
        // Strip YAML frontmatter (--- ... ---)
        const withoutFrontmatter = raw.replace(/^---[\s\S]*?---\s*/, '');
        // Strip markdown headers
        const withoutHeaders = withoutFrontmatter.replace(/^#+\s+.*$/gm, '');
        // Collapse whitespace and take first ~200 chars
        const cleaned = withoutHeaders.trim().replace(/\s+/g, ' ');
        if (cleaned.length > 0) {
          brief = cleaned.slice(0, 200);
        }
      } catch {
        // File missing or unreadable — use default
      }
    }

    lines.push(`- \`${expert.slug}\` — ${expert.name}: ${brief}`);
  }

  return lines.join('\n');
}

/**
 * Use a lightweight LLM (Haiku) to select the best expert for a question.
 *
 * Calls `claude --print --model <model>` as a stateless subprocess.
 * Returns an LlmRoutingResult with the slug (or null on failure) plus
 * full telemetry for after-the-fact analysis.
 */
export async function selectExpertWithLlm(
  question: string,
  experts: Expert[],
  model?: string
): Promise<LlmRoutingResult> {
  const roster = buildExpertRoster(experts);
  const validSlugs = new Set(experts.map((e) => e.slug));
  const resolvedModel = model ?? DEFAULT_ROUTING_MODEL;

  const prompt = `You are a query router. Given a user's question and a list of domain experts, respond with ONLY the slug of the single best expert to answer the question. Do not explain your choice. Respond with just the slug.

## Available Experts

${roster}

## Question

${question}`;

  const startTime = Date.now();

  try {
    const stdout = await spawnClaude(
      ['--print', '--model', resolvedModel, prompt],
      ROUTING_TIMEOUT_MS
    );
    const durationMs = Date.now() - startTime;

    const slug = stdout.trim().replace(/`/g, '').trim();
    if (validSlugs.has(slug)) {
      return { slug, prompt, rawResponse: stdout, model: resolvedModel, durationMs, error: null };
    }

    // LLM returned something we don't recognize
    return {
      slug: null,
      prompt,
      rawResponse: stdout,
      model: resolvedModel,
      durationMs,
      error: `invalid slug: ${slug}`,
    };
  } catch (err) {
    const durationMs = Date.now() - startTime;
    const error = err instanceof Error ? err.message : String(err);
    return { slug: null, prompt, rawResponse: '', model: resolvedModel, durationMs, error };
  }
}

/**
 * Spawn `claude` CLI as a subprocess with stdin closed.
 * Returns stdout on success, rejects on failure/timeout.
 */
function spawnClaude(args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('claude', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: buildCleanEnv(),
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`Routing timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        const stderr = Buffer.concat(stderrChunks).toString('utf-8').trim();
        reject(new Error(stderr || `claude exited with code ${code}`));
        return;
      }
      resolve(Buffer.concat(stdoutChunks).toString('utf-8'));
    });
  });
}

/**
 * Score experts by running the query against FTS5 indexes and mapping
 * file_path hits to expert mount_paths. Also collects hits per expert
 * for later context enrichment.
 */
function scoreExperts(query: string, db: LuxDatabase, experts: Expert[]): ScoreResult {
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

  // Search all FTS5 indexes and collect (file_path, rank, content, title, metadata) tuples
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
 * Collect file_path + rank + content + title + metadata from all FTS5 tables.
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
        metadata: entry.metadata ?? undefined,
      });
    }
  } catch {
    // FTS5 not available for knowledge entries
  }

  return hits;
}

/**
 * Build an augmented query that injects FTS5-retrieved document content
 * and LSP relationship data as reference material for the expert.
 *
 * @param question - The user's original question
 * @param hits - FTS5 hits with content and metadata, already ordered by relevance
 * @param maxContextBytes - Maximum bytes for the reference section (~150KB default)
 */
export function buildAugmentedQuery(
  question: string,
  hits: FtsHit[],
  maxContextBytes?: number,
  moduleContext?: string
): string {
  const budget = maxContextBytes ?? 153_600;

  // Filter to hits that actually have content or LSP data
  const relevantHits = hits.filter((h) => (h.content && h.content.trim().length > 0) || h.metadata);

  if (relevantHits.length === 0) {
    return question;
  }

  const parts: string[] = [];
  let usedBytes = 0;

  for (const hit of relevantHits) {
    const label = hit.title ?? hit.filePath;
    const header = `### ${label}\n`;
    const separator = '\n---\n';
    const overhead = Buffer.byteLength(header + separator, 'utf-8');

    const remaining = budget - usedBytes - overhead;
    if (remaining <= 0) break;

    const bodyParts: string[] = [];

    // Include LSP relationship summary if available
    const lspSummary = extractLspRelationships(hit.metadata);
    if (lspSummary) {
      bodyParts.push(lspSummary);
    }

    // Include document content
    if (hit.content && hit.content.trim().length > 0) {
      bodyParts.push(hit.content);
    }

    if (bodyParts.length === 0) continue;

    let body = bodyParts.join('\n\n');
    const contentBytes = Buffer.byteLength(body, 'utf-8');
    if (contentBytes > remaining) {
      body = body.slice(0, remaining) + '\n[...truncated]';
    }

    parts.push(header + body + separator);
    usedBytes += Buffer.byteLength(parts[parts.length - 1], 'utf-8');
  }

  if (parts.length === 0) {
    return question;
  }

  const moduleSection = moduleContext ? `\n## Module Context\n\n${moduleContext}\n` : '';

  return `Answer the following question using the reference documents provided below.

## Reference Documents

${parts.join('\n')}${moduleSection}
## Question

${question}`;
}

// ---------------------------------------------------------------------------
// Module dependency context
// ---------------------------------------------------------------------------

/**
 * Build module context string from dependency data for the augmented query.
 * Adds module name, coupling partners, and cluster membership.
 */
function buildModuleContext(db: LuxDatabase, hits: FtsHit[]): string | undefined {
  if (hits.length === 0) return undefined;

  try {
    const allDeps = db.getAllModuleDependencies();
    if (allDeps.length === 0) return undefined;

    // Find distinct modules from hits by checking file paths
    const hitModules = new Set<string>();
    for (const hit of hits) {
      // Extract module from file path metadata if available
      const metadata = hit.metadata ? (JSON.parse(hit.metadata) as Record<string, unknown>) : null;
      const tags = metadata?.tags;
      if (Array.isArray(tags) && tags.length > 0) {
        hitModules.add(String(tags[0]));
      }
    }

    if (hitModules.size === 0) return undefined;

    const lines: string[] = [];
    const clusters = computeClusters(allDeps);

    for (const mod of hitModules) {
      const deps = allDeps.filter((d) => d.source_module === mod || d.target_module === mod);
      if (deps.length === 0) continue;

      lines.push(`module: ${mod}`);

      const coupling = deps
        .sort((a, b) => b.reference_count - a.reference_count)
        .slice(0, 5)
        .map((d) => {
          const partner = d.source_module === mod ? d.target_module : d.source_module;
          return `${partner} (${d.reference_count} refs)`;
        });
      lines.push(`module_coupling: ${coupling.join(', ')}`);

      const cluster = clusters.find((c) => c.members.includes(mod));
      if (cluster) {
        lines.push(`cluster: ${cluster.name} (${cluster.members.join(', ')})`);
      }
    }

    return lines.length > 0 ? lines.join('\n') : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// LSP relationship extraction
// ---------------------------------------------------------------------------

/** Parsed LSP metadata shape from the database metadata JSON. */
interface LspMetadata {
  symbols?: Array<{
    name: string;
    kindLabel?: string;
    children?: Array<{ name: string; kindLabel?: string }>;
  }>;
  definitions?: Array<{
    symbolName: string;
    targetUri: string;
  }>;
}

/** Extended LSP metadata with PHP enrichment fields. */
interface LspMetadataWithRelations extends LspMetadata {
  typeHierarchy?: Array<{
    name: string;
    supertypes?: Array<{ name: string }>;
    subtypes?: Array<{ name: string }>;
  }>;
  references?: Array<{
    symbolName: string;
    referenceCount: number;
    referenceLocations?: Array<{ uri: string }>;
  }>;
}

/**
 * Extract LSP relationship data from a database entity's metadata JSON
 * and format it as a human-readable summary for the augmented query.
 *
 * Extracts four relationship types:
 * - **extends**: supertype relationships from type hierarchy
 * - **implements**: interface implementations from type hierarchy
 * - **dependencies**: definition targets (what this file depends on)
 * - **referenced_by**: files that reference symbols in this file
 *
 * @returns Formatted summary string, or null if no LSP data is present.
 */
export function extractLspRelationships(metadataJson: string | undefined): string | null {
  if (!metadataJson) return null;

  let metadata: Record<string, unknown>;
  try {
    metadata = JSON.parse(metadataJson) as Record<string, unknown>;
  } catch {
    return null;
  }

  const lsp = metadata.lsp as LspMetadataWithRelations | undefined;
  if (!lsp) return null;

  const lines: string[] = [];

  // Extract extends/implements from type hierarchy
  if (lsp.typeHierarchy && lsp.typeHierarchy.length > 0) {
    for (const entry of lsp.typeHierarchy) {
      if (entry.supertypes && entry.supertypes.length > 0) {
        const superNames = entry.supertypes.map((s) => s.name);
        lines.push(`**extends**: ${entry.name} → ${superNames.join(', ')}`);
      }
      if (entry.subtypes && entry.subtypes.length > 0) {
        const subNames = entry.subtypes.map((s) => s.name);
        lines.push(`**implements**: ${entry.name} ← ${subNames.join(', ')}`);
      }
    }
  }

  // Extract dependencies from definition targets
  if (lsp.definitions && lsp.definitions.length > 0) {
    const depFiles = new Set<string>();
    for (const def of lsp.definitions) {
      if (def.targetUri) {
        const fileName = def.targetUri.split('/').pop() ?? def.targetUri;
        depFiles.add(fileName);
      }
    }
    if (depFiles.size > 0) {
      lines.push(`**dependencies**: ${Array.from(depFiles).join(', ')}`);
    }
  }

  // Extract referenced_by from reference locations
  if (lsp.references && lsp.references.length > 0) {
    const referencingFiles = new Set<string>();
    for (const ref of lsp.references) {
      if (ref.referenceLocations) {
        for (const loc of ref.referenceLocations) {
          if (loc.uri) {
            const fileName = loc.uri.split('/').pop() ?? loc.uri;
            referencingFiles.add(fileName);
          }
        }
      }
    }
    if (referencingFiles.size > 0) {
      lines.push(`**referenced_by**: ${Array.from(referencingFiles).join(', ')}`);
    }
  }

  // Include symbol outline if available
  if (lsp.symbols && lsp.symbols.length > 0) {
    const symbolList = lsp.symbols
      .map((s) => `${s.kindLabel ?? 'Symbol'} \`${s.name}\``)
      .slice(0, 20)
      .join(', ');
    lines.push(`**symbols**: ${symbolList}`);
  }

  if (lines.length === 0) return null;

  return `> **LSP Relationships**\n> ${lines.join('\n> ')}`;
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
  queryOpts?: QueryOptions
): Promise<QueryResult[]> {
  const settled = await Promise.allSettled(
    experts.map((expert) => sessionManager.query(expert.slug, question, queryOpts))
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
