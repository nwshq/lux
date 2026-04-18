# Lux Architecture Overview

## System Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     Interface Layer                          │
│                                                             │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │   CLI (lux)  │  │  MCP Server  │  │  Git Post-Commit │  │
│  │  Commander.js │  │  (lux-mcp)  │  │      Hook        │  │
│  │  12 commands  │  │  8 tools     │  │  Auto-rebuild    │  │
│  └──────┬───────┘  └──────┬───────┘  └────────┬─────────┘  │
│         │                 │                    │             │
└─────────┼─────────────────┼────────────────────┼─────────────┘
          │                 │                    │
          ▼                 ▼                    ▼
┌─────────────────────────────────────────────────────────────┐
│                    Business Logic Layer                      │
│                                                             │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │   Expert     │  │   Scanner    │  │    Lint Engine    │  │
│  │   Router     │  │  (General)   │  │  (Pluggable      │  │
│  │  FTS5 + LLM  │  │  Glob + YAML │  │   Rules)         │  │
│  │  + Subprocess │  │  + LSP       │  │                  │  │
│  └──────┬───────┘  └──────┬───────┘  └────────┬─────────┘  │
│         │                 │                    │             │
└─────────┼─────────────────┼────────────────────┼─────────────┘
          │                 │                    │
          ▼                 ▼                    ▼
┌─────────────────────────────────────────────────────────────┐
│                     Data Access Layer                        │
│                                                             │
│  ┌──────────────────────────────────────────────────────┐   │
│  │                  LuxDatabase                          │   │
│  │  CRUD operations · FTS5 queries · Migration runner    │   │
│  │  PreparedQueries · Event logging · Expert sessions    │   │
│  └──────────────────────────┬───────────────────────────┘   │
│                             │                               │
└─────────────────────────────┼───────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                     Storage Layer                            │
│                                                             │
│  ┌─────────────────────┐    ┌───────────────────────────┐   │
│  │   SQLite + FTS5     │    │   CORPUS Filesystem       │   │
│  │   ~/.lux/lux.db     │    │   ~/CORPUS                │   │
│  │   WAL mode          │    │   Markdown (source of     │   │
│  │   Auto-migrations   │    │   truth)                  │   │
│  └─────────────────────┘    └───────────────────────────┘   │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

## Data Flow

```
CORPUS Files (markdown + YAML frontmatter)
    │
    ▼
Scanner ──── parse ────► LuxDatabase ◄──── query ──── CLI / MCP / Expert Router
    │                        │
    │ (optional)             │ FTS5
    ▼                        ▼
LSP Enricher           Search Results
(PHP, etc.)            (ranked by relevance)
```

**Index lifecycle:**
1. `lux index rebuild` triggers the canonical overlay-complete rebuild path, while `lux index rebuild --content-only` runs the fallback content-only path
2. `lux index sync` performs incremental updates from git state and escalates to canonical overlay rebuild when structural files changed
3. Scanner globs `knowledge/10_clients/` for clients, projects, communications, knowledge entries
4. YAML frontmatter parsed via `gray-matter`, content extracted
5. `LuxDatabase` clears and re-indexes all entities, then persists overlay trust state when structural rebuilds run
6. FTS5 triggers auto-populate virtual tables for search
7. `lux overlay status` and `lux overlay check` consume the same trust model used by rebuild and sync

## Design Principles

| Principle | Description |
|-----------|-------------|
| **File-first** | CORPUS markdown files are the source of truth. Database indexes metadata and paths only. |
| **MCP-native** | MCP server is the primary AI interface; CLI is the human interface. Both share business logic. |
| **Eventually consistent** | Index rebuilds on git commits (hook) or manual trigger. Not real-time. |
| **Subprocess isolation** | Expert queries run in clean subprocess environments with allowlisted env vars. |
| **Pluggable extensions** | Lint rules and LSP enrichers follow interface contracts for extensibility. |

## Module Table

| Module | Directory | Responsibility | Key Exports |
|--------|-----------|---------------|-------------|
| **CLI** | `src/cli/` | Human interface — 12 command groups via Commander.js | `add*Commands()` functions |
| **MCP Server** | `src/mcp/` | AI interface — 8 tools via stdio MCP protocol | MCP server entry point |
| **Database** | `src/db/` | SQLite CRUD, FTS5 search, migrations, event logging | `LuxDatabase`, entity types |
| **Scanner** | `src/scanner/` | CORPUS filesystem scanning, frontmatter parsing, indexing | `GeneralScanner` |
| **Expert Router** | `src/experts/` | 3-stage expert routing (FTS5 → LLM → subprocess) | `routeQuery()`, `SubprocessSessionManager` |
| **Lint Engine** | `src/lint/` | Pluggable rule-based CORPUS structure validation | `LintEngine`, `LintRule` interface |
| **Init** | `src/init/` | AI-assisted CORPUS initialization and lux.yaml generation | `initCorpus()` |
| **Utils** | `src/utils/` | Shared helpers — frontmatter generation, subprocess env | `buildCleanEnv()` |

## Module Dependencies

```
cli/
├── db/
├── scanner/
├── experts/
├── lint/
└── init/

mcp/
├── db/
├── scanner/
└── experts/

experts/
└── db/

scanner/
├── db/
└── scanner/lsp/
```

## External Dependencies

| Package | Purpose |
|---------|---------|
| `@modelcontextprotocol/sdk` | MCP protocol server implementation |
| `better-sqlite3` | SQLite database with FTS5 support |
| `commander` | CLI framework |
| `gray-matter` | YAML frontmatter parsing from markdown |
| `zod` | Runtime schema validation (config, inputs) |
| `glob` | Filesystem pattern matching |
| `yaml` | YAML parsing and stringifying |
| `vscode-languageserver-protocol` | LSP types for enrichment system |

## Database Schema

Seven tables across four migrations:

| Table | Migration | Purpose |
|-------|-----------|---------|
| `clients` | 001 | Client registry with slug, name, type, status, file_path |
| `projects` | 001 | Projects per client (FK to clients) |
| `communications` | 001 | Communication logs with type, subject, participants |
| `knowledge_entries` | 001 | Knowledge base entries with type, title, tags |
| `events` | 001 | Audit trail (source, event_type, payload) |
| `experts` | 004 | Expert panel (slug, mount_path, model, claude_md_path) |
| `expert_sessions` | 004 | Session tracking (expert_id, session_ref, status) |

FTS5 virtual tables (migrations 002–003) auto-sync via triggers for clients, projects, communications, and knowledge_entries.

## Expert Routing Pipeline

```
User Query
    │
    ▼
┌─ Stage 1: FTS5 Scoring ────────────────────┐
│  Search all FTS5 indexes                    │
│  Map hits to experts by mount_path prefix   │
│  Rank by hit count + relevance score        │
└─────────────────────┬──────────────────────┘
                      │
                      ▼
┌─ Stage 2: LLM Selection (Haiku) ───────────┐
│  Present expert roster with descriptions    │
│  Haiku selects the best expert for query    │
│  Log routing decision to events table       │
└─────────────────────┬──────────────────────┘
                      │
                      ▼
┌─ Stage 3: Expert Query (Subprocess) ────────┐
│  Spawn claude --print with expert's model   │
│  Inject FTS5 context (150KB budget)         │
│  Stream response via onChunk callback       │
└─────────────────────────────────────────────┘
```

## Architecture Decision Records

Significant architectural decisions are documented as ADRs in [`docs/architecture/adr/`](adr/README.md).

| ADR | Decision | Key Trade-off |
|-----|----------|---------------|
| [001](adr/001-sqlite-fts5.md) | SQLite with FTS5 for storage and search | Zero-ops portability vs. no semantic search |
| [002](adr/002-module-organization.md) | Feature-based module organization | Domain cohesion vs. cross-cutting visibility |
| [003](adr/003-expert-routing.md) | Three-stage expert routing (FTS5 → LLM → subprocess) | Routing accuracy vs. latency from LLM hop |
| [004](adr/004-subprocess-isolation.md) | Allowlist-based subprocess environment isolation | Security isolation vs. env var discoverability |
| [005](adr/005-lint-rule-pattern.md) | Pluggable lint rule pattern | Independent extensibility vs. O(files × rules) cost |
| [006](adr/006-mcp-stdio-transport.md) | MCP stdio transport for AI integration | Zero-config deployment vs. single-client limitation |
