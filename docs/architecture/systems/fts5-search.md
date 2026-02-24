# FTS5 Search System

SQLite FTS5 (Full-Text Search 5) powers all search operations in Lux, providing tokenized full-text search with BM25 relevance ranking across four entity types: clients, projects, communications, and knowledge entries.

## Index Structure

### Virtual Tables

Four FTS5 virtual tables shadow the base entity tables:

| FTS5 Table | Base Table | Indexed Columns |
|------------|------------|----------------|
| `clients_fts` | `clients` | slug, name, type, status, metadata, content |
| `projects_fts` | `projects` | slug, name, status, metadata, content |
| `communications_fts` | `communications` | type, subject, date_range, participants, metadata, content |
| `knowledge_entries_fts` | `knowledge_entries` | type, title, tags, metadata, content |

Each virtual table is declared as a **content-synced** FTS5 table, meaning it reads column values from the base table on demand rather than storing a duplicate copy:

```sql
CREATE VIRTUAL TABLE clients_fts USING fts5(
    slug, name, type, status, metadata, content,
    content='clients',
    content_rowid='id'
);
```

The `content='clients'` directive points FTS5 to the `clients` table for column data. The `content_rowid='id'` directive maps the FTS5 internal rowid to the base table's `id` primary key, enabling the JOIN pattern used in all search queries.

### FTS5 Tokenizer

The tables use FTS5's default `unicode61` tokenizer, which:

- Splits text on Unicode-defined word boundaries
- Folds characters to ASCII equivalents (e.g., accented characters)
- Is case-insensitive (all tokens are lowercased internally)

No custom tokenizer configuration is applied. JSON blobs stored in `metadata`, `tags`, and `participants` columns are tokenized as raw text, meaning JSON keys and values are searchable but JSON structure is not preserved.

### Schema Evolution

FTS5 was introduced across two migrations:

| Migration | Change |
|-----------|--------|
| **002** (`add_fts5_search`) | Created FTS5 virtual tables indexing metadata fields only (slug, name, type, status, tags, participants, metadata). Populated from existing data. |
| **003** (`add_content_to_fts5`) | Added `content` column to base tables. Dropped and recreated all FTS5 tables and triggers to include `content` in the index. Re-populated from existing data. |

Migration 003 performs a destructive rebuild: it drops all existing FTS5 tables and triggers, adds `content TEXT` columns to the base tables via `ALTER TABLE`, then recreates the FTS5 tables with the expanded column set. This approach was chosen because FTS5 virtual tables cannot be altered in place.

## Index Population

### Trigger-Based Synchronization

FTS5 indexes stay in sync with base tables through AFTER triggers on INSERT, UPDATE, and DELETE operations. Application code never explicitly updates FTS5 tables.

**Insert trigger** (example for `clients`):
```sql
CREATE TRIGGER clients_fts_insert AFTER INSERT ON clients BEGIN
    INSERT INTO clients_fts(rowid, slug, name, type, status, metadata, content)
    VALUES (new.id, new.slug, new.name, new.type, new.status, new.metadata, new.content);
END;
```

**Delete trigger** uses FTS5's special `'delete'` command to remove entries:
```sql
CREATE TRIGGER clients_fts_delete AFTER DELETE ON clients BEGIN
    INSERT INTO clients_fts(clients_fts, rowid, slug, name, type, status, metadata, content)
    VALUES ('delete', old.id, old.slug, old.name, old.type, old.status, old.metadata, old.content);
END;
```

**Update trigger** performs a delete-then-insert (FTS5 does not support in-place updates):
```sql
CREATE TRIGGER clients_fts_update AFTER UPDATE ON clients BEGIN
    INSERT INTO clients_fts(clients_fts, rowid, ...)
    VALUES ('delete', old.id, ...);
    INSERT INTO clients_fts(rowid, ...)
    VALUES (new.id, ...);
END;
```

This trigger pattern is replicated identically across all four entity tables (16 triggers total: 4 tables x 3 operations each).

### Scanner-Driven Population

Content flows into FTS5 through the scanner indexing pipeline:

```
CORPUS Filesystem
    │
    ▼
GeneralScanner.scan()
    │  Parse markdown via gray-matter
    │  Extract frontmatter + content body
    ▼
GeneralScanner.index()
    │  INSERT into base tables
    │  (triggers fire automatically)
    ▼
FTS5 Virtual Tables
    (populated by AFTER INSERT triggers)
```

The `GeneralScanner.index()` method calls `LuxDatabase` insert methods (e.g., `insertClient()`, `insertKnowledgeEntry()`), which execute parameterized INSERT statements on the base tables. The AFTER INSERT triggers then transparently populate the corresponding FTS5 tables.

### Rebuild Cycle

The index is rebuilt via `lux index rebuild` or the git post-commit hook:

1. `LuxDatabase.clearAll()` deletes all rows from base tables (cascading to FTS5 via DELETE triggers)
2. `GeneralScanner.scan()` re-reads the CORPUS filesystem
3. `GeneralScanner.index()` re-inserts all entities (INSERT triggers repopulate FTS5)

This is a full rebuild, not an incremental update. The database is temporarily empty during the rebuild window.

## Content Indexing

### What Gets Indexed

Each entity's FTS5 index includes both structured metadata fields and the full markdown body content:

**Clients:**
- `slug` — URL-safe identifier (e.g., `acme-corp`)
- `name` — Display name (e.g., `Acme Corporation`)
- `type` — Client classification (from frontmatter)
- `status` — Active/inactive status (from frontmatter)
- `metadata` — Full frontmatter as JSON string
- `content` — Markdown body (after frontmatter extraction)

**Knowledge entries:**
- `type` — Entry classification (methodology, spec, architecture, exploration, etc.)
- `title` — Entry title (from frontmatter or filename)
- `tags` — JSON array of tags (from frontmatter)
- `metadata` — Full frontmatter as JSON string
- `content` — Markdown body

### Content Extraction

The `GeneralScanner.parseMarkdownFile()` method uses `gray-matter` to separate YAML frontmatter from markdown content:

```typescript
const parsed = matter(content);
// parsed.data  → frontmatter object (stored in metadata column)
// parsed.content → markdown body (stored in content column)
```

Both the frontmatter (serialized to JSON) and the raw markdown body are indexed by FTS5, enabling searches across structured metadata and document prose.

### Content-Only Search

The system provides content-only search variants that restrict matching to the `content` column using FTS5 column filters:

```sql
-- Content-only search via column prefix
WHERE clients_fts MATCH 'content:' || ?
```

This is exposed through `searchClientsContent()`, `searchProjectsContent()`, etc., and through the CLI's `--content` flag.

## Query Syntax

### FTS5 Match Syntax

FTS5 queries support several operators:

| Feature | Syntax | Example |
|---------|--------|---------|
| Simple term | `word` | `deployment` |
| Phrase search | `"two words"` | `"sinai chicago"` |
| Prefix match | `word*` | `deploy*` matches `deployment`, `deploying` |
| AND | `term1 AND term2` | `active AND client` |
| OR | `term1 OR term2` | `email OR slack` |
| NOT | `term1 NOT term2` | `meeting NOT standup` |
| Column filter | `column:term` | `content:kubernetes` |

### Query Sanitization

User input is sanitized before reaching FTS5 to prevent syntax errors from special characters. The `sanitizeFtsQuery()` function in `src/experts/router.ts`:

```typescript
export function sanitizeFtsQuery(query: string): string {
  const tokens = query
    .split(/\s+/)
    .map((t) => t.replace(/[^\w*-]/g, ''))  // Strip special chars, keep * and -
    .filter((t) => t.length > 0);

  if (tokens.length === 0) return '';
  return tokens.map((t) => `"${t}"`).join(' OR ');
}
```

Each word is:
1. Stripped of special characters (parentheses, colons, etc.) — the `*` wildcard is preserved
2. Wrapped in double quotes (forcing exact token match)
3. Joined with `OR` for permissive matching (any token hit counts)

This means a user query like `kubernetes deployment strategy` becomes `"kubernetes" OR "deployment" OR "strategy"` — matching documents containing any of those terms.

The CLI `lux search` command passes user queries directly to FTS5 without sanitization, allowing advanced users to use the full FTS5 syntax. The expert router uses `sanitizeFtsQuery()` to prevent syntax errors from arbitrary user questions.

### Search API Surface

The `LuxDatabase` class exposes eight FTS5 search methods:

| Method | Scope | Returns |
|--------|-------|---------|
| `searchClients(query)` | All client fields | `Client[]` |
| `searchProjects(query)` | All project fields | `Project[]` with client info |
| `searchCommunications(query)` | All comm fields | `Communication[]` |
| `searchKnowledgeEntries(query)` | All knowledge fields | `KnowledgeEntry[]` |
| `searchClientsContent(query)` | Content only | `Client[]` |
| `searchProjectsContent(query)` | Content only | `Project[]` with client info |
| `searchCommunicationsContent(query)` | Content only | `Communication[]` |
| `searchKnowledgeEntriesContent(query)` | Content only | `KnowledgeEntry[]` |

Additionally, `searchAllDocuments(query)` queries all four FTS5 tables and returns unified `DocumentSearchResult[]` with normalized `file_path`, `title`, `content`, and `rank` fields. It silently skips any FTS5 table that is unavailable (e.g., pre-migration).

## BM25 Ranking

### How BM25 Works

FTS5 uses the BM25 (Best Matching 25) ranking function to score documents by relevance. BM25 considers three factors:

1. **Term frequency (TF)** — how often the query term appears in the document. Frequency has diminishing returns: the 10th occurrence contributes less than the 1st.

2. **Inverse document frequency (IDF)** — terms appearing in fewer documents receive higher weight. A rare term like `kubernetes` is more discriminative than a common word like `the`.

3. **Document length normalization** — longer documents are not unfairly penalized for containing more terms. BM25 adjusts scores relative to the average document length in the corpus.

### Rank Column Behavior

FTS5 exposes BM25 scores through the `rank` pseudo-column. The rank is a **negative** value — more negative means more relevant:

```sql
SELECT c.* FROM clients c
JOIN clients_fts ON c.id = clients_fts.rowid
WHERE clients_fts MATCH ?
ORDER BY rank  -- most relevant first (most negative)
```

All prepared search queries in `src/db/queries.ts` use `ORDER BY rank` to return results in relevance order.

### Ranking Across Entity Types

The `searchAllDocuments()` method queries each FTS5 table independently and concatenates results. BM25 scores are **not comparable across different FTS5 tables** because IDF and average document length are computed per-table. The current implementation sets `rank: 0` for all unified results, meaning cross-table results are ordered by insertion sequence (knowledge entries first, then clients, projects, communications).

### Expert Router Scoring

The expert router in `src/experts/router.ts` uses FTS5 for a different purpose: mapping search hits to experts by file path. Rather than using BM25 scores directly, it:

1. Runs the query against all FTS5 tables to collect file paths
2. Matches each file path to an expert by `mount_path` prefix
3. Counts hits per expert and accumulates raw rank scores
4. Sorts by hit count first, then by cumulative rank (lower = more relevant)

```typescript
const sorted = Array.from(scores.values())
  .filter((s) => s.hits > 0)
  .sort((a, b) => {
    if (b.hits !== a.hits) return b.hits - a.hits;     // more hits = better
    return a.score - b.score;  // lower rank sum = more relevant
  });
```

## Consumers

### CLI (`lux search`)

The `lux search <query>` command is the primary human interface. It supports:

- `--type <type>` — filter by entity type (client, project, comm, knowledge, or all)
- `--client <slug>` — filter by client slug
- `--limit <n>` — cap result count (default: 20)
- `--content` — restrict search to content field only
- `--legacy` — fall back to pre-FTS5 substring search

If FTS5 queries fail (e.g., schema not migrated), the CLI automatically falls back to legacy substring search.

### MCP Server (`lux_search` tool)

The `lux_search` MCP tool provides the same search capability to AI agents. It accepts `query`, `type`, `client`, and `limit` parameters and uses `searchAllDocuments()` for unified search or type-specific methods for filtered search.

### Expert Router (context enrichment)

The expert router uses FTS5 search as its first stage — not to return results to the user, but to:

1. **Score experts** — determine which expert's domain has the most relevant documents
2. **Build augmented queries** — inject FTS5 hit content (up to 150KB) into the prompt sent to the chosen expert

## Performance Characteristics

### Time Complexity

- **Indexing:** O(n) where n is the number of tokens across all entities. Trigger-based synchronization adds constant overhead per INSERT/UPDATE/DELETE.
- **Search:** O(log n) per term via FTS5's inverted index, where n is the total number of indexed tokens. Multi-term queries perform a merge across posting lists.
- **Rebuild:** O(m) where m is the total number of CORPUS files. Requires full filesystem scan, markdown parsing, and re-insertion.

### Space Overhead

Content-synced FTS5 tables (`content=` directive) store only the inverted index, not a copy of the column data. The FTS5 index adds approximately 30-50% overhead on top of the base table size, depending on content density. This is significantly less than an external FTS5 table which would double storage.

### Concurrency

WAL (Write-Ahead Logging) mode enables concurrent read access during writes:

- Multiple CLI instances can query FTS5 simultaneously
- The MCP server can read while the scanner rebuilds the index
- Only one writer can hold the write lock at a time — concurrent rebuilds serialize

### Limitations

- **No semantic search.** FTS5 is keyword-based. It cannot find documents using different terminology for the same concept. Queries for `container orchestration` will not match documents that only mention `Kubernetes`.
- **No fuzzy matching.** Typos are not tolerated. `deploymnt` will not match `deployment`. Prefix queries (`deploy*`) partially mitigate this.
- **JSON fields indexed as text.** Metadata, tags, and participants stored as JSON strings are tokenized as raw text. JSON structure (keys, nesting) is not preserved — searches may match JSON keys as well as values.
- **Cross-table ranking not unified.** BM25 scores from different FTS5 tables are not directly comparable. `searchAllDocuments()` does not merge-sort by relevance across entity types.
- **Temporary emptiness during rebuild.** The full-rebuild strategy means FTS5 indexes are empty between `clearAll()` and re-indexing completion. Queries during this window return no results.

## Key Source Files

| File | Role |
|------|------|
| `src/db/migrations/002_add_fts5_search.sql` | Initial FTS5 virtual tables and triggers (metadata only) |
| `src/db/migrations/003_add_content_to_fts5.sql` | Added content column to FTS5 indexes |
| `src/db/queries.ts` | Prepared FTS5 search statements (8 queries) |
| `src/db/index.ts` | `LuxDatabase` search methods and `searchAllDocuments()` |
| `src/db/types.ts` | `DocumentSearchResult` interface |
| `src/experts/router.ts` | `sanitizeFtsQuery()`, `scoreExperts()`, `collectFtsHits()` |
| `src/cli/search.ts` | CLI search command with FTS5 and legacy fallback |
| `src/mcp/server.ts` | MCP `lux_search` tool handler |
| `src/scanner/general.ts` | Content extraction and indexing pipeline |

## Related Documentation

- [ADR-001: SQLite with FTS5](../adr/001-sqlite-fts5.md) — decision rationale for SQLite + FTS5
- [ADR-003: Expert Routing](../adr/003-expert-routing.md) — how FTS5 feeds the expert selection pipeline
- [Architecture Overview](../OVERVIEW.md) — system-level architecture and data flow
