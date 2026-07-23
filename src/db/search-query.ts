// Pure FTS5 MATCH-expression construction + refusal classification for `lux search` (D3, D4).
// No DB handle here — this module is DB-layer and imports nothing above it. The two failure
// classes a search can produce are modeled as one typed error the CLI/MCP map to distinct
// exit codes, remediations, and usage error.codes; there is no silent catch anywhere.

/** The two refusal classes. A genuine zero-result answer is NOT a refusal — it is exit 0. */
export type SearchRefusalReason = 'invalid-query' | 'fts-unavailable';

/** The default result cap applied when a limit is absent or invalid. Shared by every path that
 *  COERCES a bad limit (federated CLI + MCP, single-repo MCP); the single-repo CLI path instead
 *  REJECTS a bad `--limit` as an exit-2 usage error, so it deliberately does not use this. */
export const DEFAULT_SEARCH_LIMIT = 20;

/**
 * Coerce an arbitrary limit input to a safe positive-integer row cap for `LIMIT ?`. A NaN, <1,
 * non-integer, or non-number value → `DEFAULT_SEARCH_LIMIT`. This is the ONE rule the coercing
 * callers share so no unvalidated limit can reach SQL: a negative arrives at SQLite as `LIMIT -1`
 * (unbounded), `0` fabricates an empty answer, and a non-integer float hard-aborts the WASM module.
 */
export function coerceSearchLimit(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1
    ? value
    : DEFAULT_SEARCH_LIMIT;
}

/** Thrown by searchDocumentsRanked. Carries the offending FTS5 expression for echoing (D3). */
export class SearchRefusalError extends Error {
  constructor(
    public readonly reason: SearchRefusalReason,
    /** the FTS5 MATCH expression that failed to build or execute (echoed on invalid-query) */
    public readonly expression: string,
    /** human-facing remediation */
    message: string,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = 'SearchRefusalError';
  }
}

/**
 * Build the FTS5 MATCH expression for a user query.
 *  - default: the trimmed user query, passed through to FTS5 verbatim (operator syntax preserved).
 *  - contentOnly (D4): the WHOLE expression is scoped — `content: (<query>)` — so every term is
 *    confined to the content column, closing the first-term-only leak (`content:` || ? , the live
 *    88-vs-84 bug at queries.ts:171). Parenthesis balance is validated first so the scoping wrap
 *    cannot itself manufacture a syntax error.
 * Throws SearchRefusalError('invalid-query') for an empty query or an unbalanced paren/quote under
 * --content.
 */
export function buildFtsMatchExpression(
  userQuery: string,
  opts: { contentOnly?: boolean } = {}
): string {
  const trimmed = userQuery.trim();
  if (trimmed.length === 0) {
    throw new SearchRefusalError(
      'invalid-query',
      userQuery,
      'Empty search query. Provide at least one term.'
    );
  }
  if (!opts.contentOnly) return trimmed;
  // parensBalanced also returns false for an unterminated `"` phrase (it leaves `inPhrase` open), so
  // the refusal must name a quote imbalance too — the scoping wrap would otherwise emit an unbalanced
  // `content: (…"…)` and manufacture a downstream syntax error (n10).
  if (!parensBalanced(trimmed)) {
    throw new SearchRefusalError(
      'invalid-query',
      trimmed,
      `Unbalanced parentheses or quotes in --content query: ${trimmed}`
    );
  }
  return `content: (${trimmed})`;
}

/** Count parentheses outside FTS5 double-quoted phrases; balanced iff net 0 and never negative. */
function parensBalanced(expr: string): boolean {
  let depth = 0;
  let inPhrase = false;
  for (const ch of expr) {
    if (ch === '"') {
      inPhrase = !inPhrase;
      continue;
    }
    if (inPhrase) continue;
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth < 0) return false;
    }
  }
  return depth === 0 && !inPhrase;
}

/**
 * Classify a SQLite error raised while running the MATCH statement (D3). A missing/unmigrated FTS
 * table (or a genuinely unreadable index) is `fts-unavailable` — the honest "I could not look",
 * routed to the `lux migrate up` remediation. An FTS5 MATCH parse failure — including a user
 * `col:term` filter naming a nonexistent column (FTS5 raises `no such column: <col>`, a QUERY error,
 * not a broken index) — is `invalid-query`, with the offending expression echoed. Everything
 * unrecognized is treated as `fts-unavailable` (the conservative, non-fabricating direction) with
 * the raw message preserved.
 */
export function classifySearchError(error: unknown, expression: string): SearchRefusalError {
  if (error instanceof SearchRefusalError) return error;
  const message = error instanceof Error ? error.message : String(error);

  // `disk image is malformed` is the REAL SQLite corruption string ("database disk image is
  // malformed") — the bare `malformed database` never appears in the driver, so a subtly-corrupt
  // index would otherwise fall through to the invalid-query branch (or crash) instead of refusing
  // honestly as fts-unavailable (m4).
  if (
    /no such table|no such module|not an fts5|malformed database|disk image is malformed|file is not a database/i.test(
      message
    )
  ) {
    return new SearchRefusalError(
      'fts-unavailable',
      expression,
      'FTS5 search index is unavailable. Run `lux migrate up` and `lux index rebuild`, then try again.',
      error
    );
  }
  if (
    /fts5|syntax error|unterminated|unknown special query|expected|no such column|no such cursor|unable to use function MATCH/i.test(
      message
    )
  ) {
    return new SearchRefusalError(
      'invalid-query',
      expression,
      `Invalid FTS5 query near: ${expression} (${message})`,
      error
    );
  }
  // Unrecognized: refuse honestly rather than fabricate a zero-result answer.
  return new SearchRefusalError(
    'fts-unavailable',
    expression,
    `FTS5 search could not run: ${message}. Run \`lux migrate up\` and \`lux index rebuild\`.`,
    error
  );
}
