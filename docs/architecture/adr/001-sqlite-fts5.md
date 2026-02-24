# ADR-001: SQLite with FTS5 for Knowledge Storage

**Status:** accepted
**Date:** 2026-02-23

## Context

Lux is a knowledge platform that indexes a CORPUS of markdown files — clients, projects, communications, and knowledge entries — and needs to provide fast full-text search across all entities. The system must support:

1. **Full-text search** — users and AI agents search by natural language queries, expecting ranked results by relevance.
2. **Structured metadata** — entities have typed fields (slug, name, status, type) alongside free-text content.
3. **Portable single-file storage** — the database must be easy to back up, move between machines, and inspect.
4. **Concurrent read access** — the CLI, MCP server, and git hooks may query the database simultaneously.
5. **Zero-ops deployment** — no database server to install, configure, or maintain.

Options considered:

- **PostgreSQL + pg_trgm** — powerful full-text search and trigram matching, but requires a running server, connection management, and is overkill for a local knowledge platform.
- **Elasticsearch / Meilisearch** — purpose-built search engines with excellent relevance scoring, but require separate services and significantly increase deployment complexity.
- **SQLite + FTS5** — embedded database with a built-in full-text search extension. Single file, zero configuration, BM25 ranking, and content-synced virtual tables via triggers. Mature and well-supported by the `better-sqlite3` Node.js binding.

## Decision

We use **SQLite with FTS5** as the storage and search engine, accessed via the `better-sqlite3` package, with **WAL mode** for concurrent read access.

### Database Initialization

The `LuxDatabase` class in `src/db/index.ts` manages the connection lifecycle:

```typescript
import Database from 'better-sqlite3';

export class LuxDatabase {
  private db: Database.Database;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');

    // Run versioned migrations automatically
    this.runMigrations();
    this.initQueries();
  }
}
```

### WAL Mode

Write-Ahead Logging (WAL) is enabled at connection time via `PRAGMA journal_mode = WAL`. This provides:

- **Concurrent reads during writes** — readers do not block writers, and writers do not block readers. The CLI can query while the scanner rebuilds the index.
- **Better write performance** — writes append to a WAL file instead of modifying the database file directly, reducing disk I/O.
- **Crash resilience** — uncommitted writes in the WAL are automatically rolled back on recovery.

### Schema Design

The base schema (migration 001) defines five tables with foreign keys, indexes, and Unix epoch timestamps:

```sql
CREATE TABLE clients (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    type TEXT,
    status TEXT,
    file_path TEXT NOT NULL,
    metadata TEXT,    -- JSON blob
    content TEXT,     -- Full markdown content
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id INTEGER NOT NULL,
    slug TEXT NOT NULL,
    name TEXT NOT NULL,
    status TEXT,
    file_path TEXT NOT NULL,
    metadata TEXT,
    content TEXT,
    FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE,
    UNIQUE(client_id, slug)
);

CREATE TABLE knowledge_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id INTEGER,
    project_id INTEGER,
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    file_path TEXT NOT NULL UNIQUE,
    tags TEXT,         -- JSON array
    metadata TEXT,     -- JSON blob
    content TEXT
);

CREATE TABLE communications ( /* ... client_id, type, subject, date_range, participants, content */ );
CREATE TABLE events ( /* ... source, event_type, summary, payload — audit trail */ );
```

### FTS5 Virtual Tables

Migration 002 creates FTS5 virtual tables as content-synced shadows of the base tables:

```sql
CREATE VIRTUAL TABLE clients_fts USING fts5(
    slug, name, type, status, metadata, content,
    content='clients',
    content_rowid='id'
);
```

The `content='clients'` and `content_rowid='id'` directives make this a **content-synced** FTS5 table — it reads column values from the `clients` table on demand rather than storing a separate copy. This halves storage requirements.

Four FTS5 tables are created: `clients_fts`, `projects_fts`, `communications_fts`, and `knowledge_entries_fts`.

### Trigger-Based Synchronization

Insert, update, and delete triggers keep FTS5 indexes in sync with base tables automatically:

```sql
CREATE TRIGGER clients_fts_insert AFTER INSERT ON clients BEGIN
    INSERT INTO clients_fts(rowid, slug, name, type, status, metadata, content)
    VALUES (new.id, new.slug, new.name, new.type, new.status, new.metadata, new.content);
END;

CREATE TRIGGER clients_fts_delete AFTER DELETE ON clients BEGIN
    INSERT INTO clients_fts(clients_fts, rowid, slug, name, type, status, metadata, content)
    VALUES ('delete', old.id, old.slug, old.name, old.type, old.status, old.metadata, old.content);
END;

CREATE TRIGGER clients_fts_update AFTER UPDATE ON clients BEGIN
    -- Delete old entry, insert new entry (FTS5 does not support in-place updates)
    INSERT INTO clients_fts(clients_fts, rowid, ...)
    VALUES ('delete', old.id, ...);
    INSERT INTO clients_fts(rowid, ...)
    VALUES (new.id, ...);
END;
```

This pattern is repeated for all four entity tables. The application code performs normal INSERT/UPDATE/DELETE on base tables; FTS5 stays in sync transparently.

### BM25 Ranking

FTS5 uses the BM25 ranking function by default when results are ordered by the `rank` column:

```sql
SELECT c.* FROM clients c
JOIN clients_fts ON c.id = clients_fts.rowid
WHERE clients_fts MATCH ?
ORDER BY rank
```

BM25 (Best Matching 25) scores documents by:
- **Term frequency (TF)** — how often the query term appears in the document, with diminishing returns for repeated occurrences.
- **Inverse document frequency (IDF)** — terms that appear in fewer documents get higher weight (more discriminative).
- **Document length normalization** — longer documents are not unfairly penalized.

The `rank` column in FTS5 is a negative BM25 score — more negative values indicate higher relevance. `ORDER BY rank` returns the most relevant results first.

### Query Sanitization

User queries are sanitized before being passed to FTS5 to prevent syntax errors from special characters:

```typescript
export function sanitizeFtsQuery(query: string): string {
  const tokens = query
    .split(/\s+/)
    .map((t) => t.replace(/[^\w*-]/g, ''))
    .filter((t) => t.length > 0);

  if (tokens.length === 0) return '';
  return tokens.map((t) => `"${t}"`).join(' OR ');
}
```

Each word is wrapped in double quotes (exact token match) and joined with `OR` for permissive matching. The `*` character is preserved for prefix queries (e.g., `deploy*` matches `deployment`, `deploying`).

### Prepared Statements

All SQL queries are prepared once at initialization via the `PreparedQueries` class in `src/db/queries.ts` and reused for the lifetime of the connection. This provides both performance (no re-parsing) and safety (parameterized queries prevent SQL injection).

### Versioned Migrations

Schema changes are managed by the `MigrationRunner` class, which applies numbered `.sql` files from `src/db/migrations/` in order:

| Migration | Description |
|-----------|-------------|
| 001 | Base schema: clients, projects, communications, knowledge_entries, events |
| 002 | FTS5 virtual tables and sync triggers for all entity tables |
| 003 | Add `content` column to base tables and FTS5 indexes for full markdown search |
| 004 | Expert panel: experts and expert_sessions tables |

Migrations run automatically on database construction (`autoMigrate = true`). The migration runner tracks applied versions in the database and only applies new migrations.

## Consequences

### Positive

- **Zero-ops.** No database server to install or maintain. The database is a single file at `~/.lux/lux.db` that can be backed up with `cp`.
- **Built-in full-text search.** FTS5 provides tokenization, stemming awareness, BM25 ranking, prefix queries, and phrase matching without any external service.
- **Transparent sync.** Trigger-based FTS5 synchronization means application code never explicitly updates search indexes — standard CRUD operations keep everything consistent.
- **Concurrent access.** WAL mode allows the CLI to query while the MCP server writes, or while the git post-commit hook rebuilds the index.
- **Portable.** The database file can be moved between machines. SQLite's file format is stable and cross-platform.
- **Fast startup.** `better-sqlite3` opens an SQLite database in milliseconds. Each CLI command creates a fresh connection, uses it, and closes it — no connection pooling needed.

### Negative

- **No semantic search.** FTS5 is keyword-based. It cannot find conceptually related documents that use different terminology. Semantic similarity would require embedding vectors and a vector database extension.
- **Single-writer limitation.** While WAL allows concurrent reads, only one writer can hold the write lock at a time. Concurrent index rebuilds from multiple processes will serialize.
- **FTS5 query syntax is fragile.** Unquoted special characters (`(`, `)`, `AND`, `OR`, `NOT`, `NEAR`) are interpreted as FTS5 operators. The `sanitizeFtsQuery()` function mitigates this but limits advanced query syntax.
- **Content-synced FTS5 limitations.** Content-synced virtual tables cannot be queried independently of the base table — if the base table is dropped or data is modified outside triggers, FTS5 becomes inconsistent. The `clearAll()` method handles this by rebuilding.

### Neutral

- **JSON in TEXT columns.** Metadata, tags, and participants are stored as JSON strings in TEXT columns. SQLite's JSON functions can query these but are not used — the application parses JSON in TypeScript. This is a pragmatic choice that avoids schema complexity for semi-structured data.
- **Unix epoch timestamps.** Timestamps use `unixepoch()` (integer seconds) rather than ISO 8601 strings. This is consistent with SQLite's built-in time functions and avoids timezone ambiguity.
- **Rebuild-based consistency.** Rather than incremental updates, the scanner clears all entities and re-indexes from the CORPUS filesystem. This is simple and correct but means the database is temporarily empty during rebuilds.
