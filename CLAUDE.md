# Lux Knowledge Platform

TypeScript MCP server and CLI for CORPUS semantic search, knowledge retrieval, and expert panel routing.

## Quick Reference

```bash
npm run build          # Compile TypeScript + copy SQL assets
npm run dev            # Watch mode
npm test               # Vitest (single run)
npm run test:watch     # Vitest watch
npm run test:coverage  # Coverage report
npm run lint           # ESLint
npm run lint:fix       # ESLint auto-fix
npm run format         # Prettier write
npm run format:check   # Prettier check
npm run check          # Full gate: lint + format + build + test
```

**Binaries:** `lux` (CLI) and `lux-mcp` (MCP server)
**Node:** >=20.0.0 | **Module system:** ESM (`"type": "module"`)
**Database:** SQLite with WAL mode + FTS5 full-text search

## Architecture Overview

```
CLI / MCP Layer          ← User-facing commands and AI tool interface
    ↓
Business Logic           ← Expert routing, scanning, search, linting
    ↓
Database (LuxDatabase)   ← Single class: CRUD, migrations, FTS5 queries
    ↓
SQLite + FTS5            ← Portable single-file storage with full-text search
```

**Core design principles:**

- **File-first:** Markdown files in CORPUS are the source of truth. The database indexes metadata and file paths; AI reads files directly for content.
- **MCP-native:** The MCP server (`lux-mcp`) is the primary AI interface. CLI (`lux`) is the human interface. Both share the same database and business logic.
- **Expert panel:** Domain-specialist AI agents registered to subdirectories, routed via FTS5 scoring + LLM selection (Haiku), queried via subprocess isolation.
- **Eventually consistent:** Index rebuilds on git commits (post-commit hook) or manual `lux index rebuild`.

## Project Structure

```
src/
├── cli/                 # Commander.js CLI commands
│   ├── index.ts         # Entry point — registers all command groups
│   ├── ask.ts           # Expert panel query command
│   ├── comm.ts          # Communication logging
│   ├── expert.ts        # Expert registration/management
│   ├── hooks.ts         # Git post-commit hook install/uninstall
│   ├── lint.ts          # CORPUS structure linting
│   ├── migrate.ts       # Database migration commands
│   ├── search.ts        # FTS5 search command
│   ├── init.ts          # AI-powered lux.yaml generator
│   ├── docs.ts          # Documentation viewer
│   ├── exploration.ts   # Exploration management
│   └── journal.ts       # Journal management
├── db/                  # Database layer (better-sqlite3)
│   ├── index.ts         # LuxDatabase class — all CRUD + lifecycle
│   ├── types.ts         # Entity interfaces (Client, Project, etc.)
│   ├── queries.ts       # PreparedQueries — parameterized SQL
│   ├── migrations.ts    # MigrationRunner — versioned .sql files
│   └── migrations/      # SQL migration files (001–004)
├── experts/             # Expert panel system
│   ├── router.ts        # 3-stage routing: FTS5 → LLM → subprocess
│   ├── session-manager.ts     # Abstract session interface
│   └── subprocess-manager.ts  # Subprocess lifecycle management
├── mcp/                 # Model Context Protocol server
│   └── server.ts        # Stdio MCP server with 8 tools
├── scanner/             # CORPUS filesystem scanner
│   ├── general.ts       # Glob + frontmatter parsing
│   ├── config.ts        # lux.yaml config loader (Zod)
│   ├── types.ts         # Scanner result types
│   └── lsp/             # Language Server Protocol enrichment
│       ├── client.ts    # LSP client implementation
│       └── php.ts       # PHP-specific enricher
├── lint/                # CORPUS linting engine
│   ├── index.ts         # LintEngine — pluggable rule runner
│   ├── types.ts         # LintRule interface, LintResult
│   └── rules/           # Rule implementations
│       ├── naming/      # File naming conventions
│       ├── location/    # Directory structure validation
│       └── structure/   # Content structure checks
├── init/                # Corpus initialization
│   └── index.ts         # AI-assisted lux.yaml generation
└── utils/               # Shared utilities
    ├── frontmatter.ts   # YAML frontmatter helpers
    └── subprocess-env.ts # Clean env for subprocesses

bin/                     # Git hook scripts
config/                  # MCP/mcporter configuration templates
docs/                    # Extended documentation (18 files)
schemas/                 # JSON schemas
```

## Key Patterns

### CLI Command Registration
Each command group is a separate file exporting `add*Commands(program: Command)`. Database is instantiated per-command (no persistent connection).

```typescript
// src/cli/search.ts
export function addSearchCommand(program: Command): void {
  program.command('search <query>').action((query, options) => {
    const db = new LuxDatabase(program.opts().db as string);
    // ... use db, then db.close()
  });
}
```

### Database Error Wrapping
`LuxDatabase` translates SQLite constraint errors into user-friendly messages via `wrapDbError()`. Maps UNIQUE, FOREIGN KEY, and NOT NULL failures to descriptive text.

### Expert Routing (3-stage)
1. **FTS5 scoring** — search all indexes, map hits to experts by mount_path prefix
2. **LLM selection** — Haiku picks the best expert from the roster
3. **Subprocess query** — spawn `claude --print` with RAG context (150KB budget)

### Lint Rules
Pluggable rules implementing `LintRule` interface with `check(file, corpusPath)`. Rules are categorized: naming, location, structure.

### LSP Enrichment
Optional enrichers implementing `LspEnricher` interface. Configured in `lux.yaml`. Currently: PHP via phpactor. Disabled by default.

### Event Audit Trail
All operations log to the `events` table with source, event_type, summary, and JSON payload. Sources: `cli`, `mcp`, `scanner`, `expert-router`.

## Module Dependencies

```
cli/index.ts
├── db/          (LuxDatabase)
├── scanner/     (GeneralScanner)
├── experts/     (routeQuery, SubprocessSessionManager)
├── lint/        (LintEngine)
└── init/        (corpus init)

mcp/server.ts
├── db/          (LuxDatabase)
├── scanner/     (GeneralScanner)
└── experts/     (routeQuery, SubprocessSessionManager)

experts/router.ts
├── db/          (FTS5 queries, expert lookup)
└── experts/subprocess-manager.ts

scanner/general.ts
├── db/          (indexing via LuxDatabase)
└── scanner/lsp/ (optional enrichment)
```

**External dependencies:**
- `@modelcontextprotocol/sdk` — MCP protocol
- `better-sqlite3` — SQLite with FTS5
- `commander` — CLI framework
- `gray-matter` — YAML frontmatter parsing
- `zod` — Schema validation
- `glob` — File pattern matching
- `yaml` — YAML parsing/stringifying

## Database Entities

| Table | Purpose | Key Fields |
|-------|---------|------------|
| `clients` | Client registry | slug, name, type, status, file_path |
| `projects` | Projects per client | slug, name, client_id, file_path |
| `communications` | Comms log | type, subject, date_range, participants |
| `knowledge_entries` | Knowledge base | type, title, tags, file_path |
| `events` | Audit trail | source, event_type, summary, payload |
| `experts` | Expert panel | slug, mount_path, model, claude_md_path |
| `expert_sessions` | Session tracking | expert_id, session_ref, status |

FTS5 virtual tables with triggers auto-sync on insert/update/delete for clients, projects, communications, and knowledge_entries.

**Migrations:** `src/db/migrations/001-004*.sql` — applied automatically on database init.

## Testing

**Framework:** Vitest 4.0.18 with global test functions
**Location:** `src/<module>/__tests__/<name>.test.ts`
**Coverage:** v8 provider with text, JSON, HTML reporters

### Key conventions

- **Filesystem fixtures:** Create temp directories in `beforeEach`, clean up in `afterEach` with `rmSync`
- **Database tests:** Create fresh `LuxDatabase` in temp dir per test, `db.close()` in teardown
- **Mocking:** Use `vi.mock()` for module mocks, `vi.spyOn()` for spies, factory functions for test fixtures
- **Test relaxations:** ESLint relaxes `no-explicit-any`, `no-unsafe-*` rules in test files

### Test file inventory (20 files)

| Module | Tests |
|--------|-------|
| `lint/` | 8 — rule validation, engine behavior |
| `cli/` | 4 — ask command, expert commands, path validation |
| `db/` | 2 — expert CRUD, expert sessions |
| `experts/` | 2 — router, subprocess manager |
| `scanner/` | 2 — general scanner, LSP enrichment |
| `mcp/` | 1 — server tools |
| `utils/` | 1 — subprocess env |

## Code Standards

### TypeScript
- **Strict mode** with `noUnusedLocals`, `noUnusedParameters`, `noImplicitReturns`
- **Target:** ES2022 | **Module:** Node16
- All imports use `.js` extension (ESM requirement)
- Declarations and source maps emitted

### Style
- **Prettier:** single quotes, semicolons, trailing commas (ES5), 100 char width
- **ESLint:** recommended + type-aware TypeScript rules, `no-explicit-any` enforced in source
- **Naming:** PascalCase classes/interfaces, camelCase functions/files, UPPER_SNAKE constants
- **Unused params:** prefix with `_` to satisfy `@typescript-eslint/no-unused-vars`

### Conventions
- **Conventional commits:** `<type>[scope]: <description>` (feat, fix, docs, refactor, etc.)
- **Error handling:** Type-safe extraction (`error instanceof Error`), meaningful messages with identifiers
- **Output:** `console.log()` for data, `console.error()` for diagnostics, JSON mode suppresses verbose
- **Resource cleanup:** Always `db.close()` before exit or throw

## Environment

### Variables
| Variable | Default | Purpose |
|----------|---------|---------|
| `LUX_DB_PATH` | `~/.lux/lux.db` | Database location |
| `LUX_CORPUS_PATH` | `~/CORPUS` | Content root |
| `LUX_SKIP_REBUILD` | — | Skip git hook rebuild |
| `LUX_LOG_FILE` | — | Git hook debug logging |
| `LUX_REBUILD_TIMEOUT` | `300` | Hook timeout (seconds) |

### CLI global options
```bash
lux --db <path> --corpus <path> <command>
```

### MCP server
```bash
NODE_ENV=production node dist/mcp/server.js
```
Configure in Claude Desktop or mcporter via `mcp-config.example.json`.

## Navigation

### By task

| I want to... | Start here |
|---------------|-----------|
| Add a CLI command | `src/cli/index.ts` (register), new file in `src/cli/` |
| Add an MCP tool | `src/mcp/server.ts` |
| Add a database entity | `src/db/types.ts` (interface), `src/db/queries.ts` (SQL), new migration |
| Add a lint rule | `src/lint/rules/` (implement `LintRule`), register in `src/lint/index.ts` |
| Add an LSP enricher | `src/scanner/lsp/` (implement `LspEnricher`) |
| Modify expert routing | `src/experts/router.ts` |
| Change scanner behavior | `src/scanner/general.ts` |
| Debug git hooks | `bin/post-commit-hook.sh`, set `LUX_LOG_FILE` |
| Run quality checks | `npm run check` |

### Key files

| File | Lines | Role |
|------|-------|------|
| `src/db/index.ts` | ~500 | Core database class — all CRUD, migrations, search |
| `src/cli/index.ts` | ~440 | CLI entry — command registration, client/project/index commands |
| `src/mcp/server.ts` | ~400 | MCP server — 8 tools for AI integration |
| `src/experts/router.ts` | ~300 | Expert routing — FTS5 + LLM + subprocess |
| `src/scanner/general.ts` | ~250 | CORPUS scanner — glob, frontmatter, indexing |
| `src/db/types.ts` | ~170 | All entity interfaces and insert types |

### Documentation

| Doc | Purpose |
|-----|---------|
| `docs/architecture/OVERVIEW.md` | System architecture, data flow, module table |
| `docs/architecture/adr/` | Architecture Decision Records (6 ADRs) |
| `docs/MCP-TOOLS.md` | Detailed MCP tool reference |
| `docs/SEARCH.md` | FTS5 search features and syntax |
| `docs/GIT-HOOKS.md` | Post-commit hook documentation |
| `docs/SCANNER-API.md` | CORPUS scanner API reference |
| `docs/MCP-CONFIGURATION.md` | MCP server setup guide |

### Architecture Decision Records

| ADR | Decision |
|-----|----------|
| [001](docs/architecture/adr/001-sqlite-fts5.md) | SQLite with FTS5 for knowledge storage (WAL mode, BM25 ranking) |
| [002](docs/architecture/adr/002-module-organization.md) | Feature-based module organization with colocated `__tests__/` |
| [003](docs/architecture/adr/003-expert-routing.md) | Three-stage expert routing (FTS5 → Haiku → subprocess) |
| [004](docs/architecture/adr/004-subprocess-isolation.md) | Subprocess environment isolation via `buildCleanEnv()` allowlist |
| [005](docs/architecture/adr/005-lint-rule-pattern.md) | Pluggable lint rule pattern with `LintRule` interface |
| [006](docs/architecture/adr/006-mcp-stdio-transport.md) | MCP stdio transport with static tool registry |
