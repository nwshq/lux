# Architecture Standards

Rules and constraints that govern Lux development. Complements [OVERVIEW.md](OVERVIEW.md) (system architecture, data flow) and the [ADRs](adr/README.md) (decision rationale).

## Layer Dependency Rules

The system has four layers. Dependencies flow **downward only**.

```
Interface Layer       cli/  mcp/
                        ↓
Business Logic Layer  experts/  scanner/  lint/  init/
                        ↓
Data Access Layer     db/
                        ↓
Storage Layer         SQLite + CORPUS filesystem
```

### Allowed Imports

| Source module | May import from |
|---------------|-----------------|
| `cli/` | `db/`, `scanner/`, `experts/`, `lint/`, `init/`, `utils/` |
| `mcp/` | `db/`, `scanner/`, `experts/`, `utils/` |
| `experts/` | `db/`, `utils/` |
| `scanner/` | `db/`, `scanner/lsp/`, `utils/` |
| `lint/` | Node stdlib only (no internal module imports) |
| `init/` | `utils/` |
| `utils/` | Node stdlib only (no internal module imports) |
| `db/` | Node stdlib, `better-sqlite3` only |

### Violations

These import directions are **forbidden**:

- **Upward:** `db/` must never import from `cli/`, `mcp/`, `experts/`, `scanner/`, `lint/`, or `init/`
- **Lateral at the same layer:** `experts/` must not import from `scanner/` or `lint/`; `scanner/` must not import from `experts/` or `lint/`
- **Foundation reaching up:** `utils/` must not import from any feature module
- **Circular:** No two modules may import from each other, directly or transitively

### Module Boundary Rule

Import only from a module's public surface — `index.ts` or `types.ts`. Never reach into internal implementation files.

```typescript
// Correct
import { LuxDatabase } from '../db/index.js';
import type { Expert } from '../db/types.js';

// Forbidden — reaching into internals
import { PreparedQueries } from '../db/queries.js';
import { MigrationRunner } from '../db/migrations.js';
```

## Forbidden Patterns

### 1. `process.env` in Business Logic or Data Access

Environment variables must be resolved at the interface layer (CLI or MCP) and passed as explicit parameters. Business logic and data access code must never read `process.env` directly.

```typescript
// Forbidden — in experts/router.ts or db/index.ts
const dbPath = process.env.LUX_DB_PATH;

// Correct — CLI resolves env, passes value
// cli/index.ts
const dbPath = program.opts().db as string; // resolved from env/flag
const db = new LuxDatabase(dbPath);
```

**Exception:** `src/utils/subprocess-env.ts` reads `process.env` to build the sanitized allowlist. This is its sole purpose.

### 2. `require()` and CommonJS

The project is ESM-only (`"type": "module"` in `package.json`, `"module": "Node16"` in `tsconfig.json`). CommonJS patterns are forbidden in all source code.

```typescript
// Forbidden
const fs = require('fs');
module.exports = { foo };

// Correct
import fs from 'node:fs';
export { foo };
```

### 3. Imports Without `.js` Extension

TypeScript with `module: Node16` requires `.js` extensions on all relative imports. The compiler rejects bare specifiers.

```typescript
// Forbidden — will fail at runtime
import { LuxDatabase } from '../db/index';

// Correct
import { LuxDatabase } from '../db/index.js';
```

This applies to external packages with deep path imports as well:

```typescript
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
```

### 4. Circular Imports

No module may import from another module that directly or transitively imports back from it. Circular dependencies cause initialization ordering bugs and are structurally forbidden.

If two modules need to share types, extract the shared types into `types.ts` at the appropriate level or into `utils/`.

### 5. `any` in Source Code

`@typescript-eslint/no-explicit-any` is set to `error`. Use `unknown` and type-narrow instead.

```typescript
// Forbidden
function handle(data: any) { ... }

// Correct
function handle(data: unknown) {
  if (data instanceof Error) { ... }
}

// Correct — catch blocks
catch (error) {
  const message = error instanceof Error ? error.message : String(error);
}
```

**Exception:** Test files (`**/__tests__/**/*.ts`, `**/*.test.ts`) relax this rule.

### 6. Raw SQL Outside `db/`

All SQL lives in `PreparedQueries` (parameterized statements) or migration `.sql` files. No other module may construct or execute SQL strings.

### 7. Uncontrolled Subprocess Environment

Every subprocess spawn must pass `env: buildCleanEnv()` from `src/utils/subprocess-env.ts`. Passing `process.env` directly or omitting the `env` option (which inherits `process.env`) leaks sensitive variables and breaks subprocess isolation (see [ADR-004](adr/004-subprocess-isolation.md)).

```typescript
// Forbidden
spawn('claude', args);
spawn('claude', args, { env: process.env });

// Correct
import { buildCleanEnv } from '../utils/subprocess-env.js';
spawn('claude', args, { env: buildCleanEnv() });
```

### 8. `console.log()` in MCP Server

The MCP server uses stdout as the JSON-RPC protocol channel. Any non-protocol output to stdout corrupts the transport. Use `console.error()` for all diagnostics.

```typescript
// Forbidden in src/mcp/
console.log('Debug info');

// Correct
console.error('Lux MCP server: debug info');
```

### 9. Path Aliases

No path aliases (`@/`, `~/`, `#/`, etc.) are used. All imports are relative paths. This keeps the build simple and avoids resolution mismatches between TypeScript, Node, and test runners.

### 10. Unclosed Database Connections

`LuxDatabase` instances must be closed before exit or throw. CLI commands create a connection per invocation and close it in every code path (success and error).

```typescript
const db = new LuxDatabase(dbPath);
try {
  // ... operations
} finally {
  db.close();
}
```

## Naming Conventions

### Files

| Context | Convention | Examples |
|---------|-----------|----------|
| TypeScript source | `kebab-case.ts` | `subprocess-env.ts`, `session-manager.ts` |
| Test files | `<unit>.test.ts` | `router.test.ts`, `general.test.ts` |
| SQL migrations | `NNN-description.sql` (zero-padded) | `001-initial-schema.sql`, `004-experts.sql` |
| CLI commands | `<domain>.ts` | `search.ts`, `expert.ts`, `hooks.ts` |

### TypeScript Identifiers

| Kind | Convention | Examples |
|------|-----------|----------|
| Classes | `PascalCase` | `LuxDatabase`, `LintEngine`, `GeneralScanner` |
| Interfaces / Types | `PascalCase` | `LintRule`, `QueryResult`, `RouterOptions` |
| Functions | `camelCase` | `buildCleanEnv()`, `routeQuery()`, `sanitizeFtsQuery()` |
| Constants | `UPPER_SNAKE_CASE` | `DEFAULT_DB_PATH`, `EXACT_ALLOWLIST`, `TOOLS` |
| Variables | `camelCase` | `dbPath`, `corpusPath`, `expertSlug` |
| Unused parameters | `_camelCase` prefix | `_corpusPath`, `_options` |

### CLI Command Registration

Each command group exports a function following the `add*Commands(program: Command)` pattern:

```typescript
export function addSearchCommand(program: Command): void { ... }
export function addExpertCommands(program: Command): void { ... }
```

### Database Naming

| Context | Convention | Examples |
|---------|-----------|----------|
| Table names | `snake_case` (plural) | `clients`, `knowledge_entries`, `expert_sessions` |
| Column names | `snake_case` | `file_path`, `client_id`, `event_type` |
| Entity interfaces | `PascalCase` (singular) | `Client`, `Expert`, `KnowledgeEntry` |
| Insert types | `PascalCase` + `Insert` suffix | `ClientInsert`, `ExpertInsert` |
| FTS5 tables | `<table>_fts` | `clients_fts`, `communications_fts` |

### MCP Tool Names

Prefixed with `lux_`, then `snake_case`: `lux_search`, `lux_get_client`, `lux_rebuild_index`, `lux_list_experts`.

### Event Naming

- **source:** lowercase identifier — `cli`, `mcp`, `scanner`, `expert-router`
- **event_type:** `snake_case` — `search`, `index_rebuild`, `expert_ask`, `expert_route`

## Enforcement

### Automated (Blocking)

These are enforced by tooling and block builds or commits when violated.

| Rule | Tool | Config |
|------|------|--------|
| TypeScript strict mode | `tsc` | `tsconfig.json` — `strict`, `noUnusedLocals`, `noUnusedParameters`, `noImplicitReturns` |
| No `any` in source | ESLint | `@typescript-eslint/no-explicit-any: error` |
| Unused variables | ESLint | `@typescript-eslint/no-unused-vars: error` (with `argsIgnorePattern: '^_'`) |
| Unsafe type operations | ESLint | `recommended-requiring-type-checking` — `no-unsafe-assignment`, `no-unsafe-member-access`, etc. |
| `.js` extension on imports | TypeScript | `module: Node16` rejects bare specifiers |
| Code formatting | Prettier | `.prettierrc.json` — single quotes, semicolons, 100-char width |
| No `require()` / CJS | TypeScript | `module: Node16` + `"type": "module"` in `package.json` |
| Full quality gate | npm script | `npm run check` = lint + format:check + build + test |

### Manual (Code Review)

These rules are not yet enforced by automated tooling. They must be verified during code review.

| Rule | What to check |
|------|---------------|
| Layer dependency direction | No upward or lateral imports across module boundaries |
| Module boundary rule | Imports use `index.ts` or `types.ts`, not internal files |
| No `process.env` in domain | Business logic receives config as parameters, not from env |
| Subprocess env isolation | Every `spawn()` / `execFile()` passes `env: buildCleanEnv()` |
| No raw SQL outside `db/` | SQL only in `PreparedQueries` or migration files |
| No `console.log` in MCP | MCP server uses `console.error()` for all diagnostics |
| Database connection cleanup | `db.close()` called in all exit paths |
| No circular imports | Module dependency graph is acyclic |
| No path aliases | All imports use relative paths |

### Future Automation Candidates

Rules currently enforced by review that could be automated:

| Rule | Potential tool |
|------|---------------|
| Layer dependencies | `eslint-plugin-import` with `no-restricted-paths` or `dependency-cruiser` |
| Circular imports | `madge` or `eslint-plugin-import/no-cycle` |
| No `process.env` in domain | Custom ESLint rule restricting `process.env` to `cli/`, `mcp/`, `utils/subprocess-env.ts` |
| Module boundary imports | `eslint-plugin-import` with `no-internal-modules` |

## Style Reference

Formatting is handled by Prettier (`.prettierrc.json`):

| Setting | Value |
|---------|-------|
| Quotes | Single |
| Semicolons | Required |
| Trailing commas | ES5 positions |
| Print width | 100 characters |
| Indentation | 2 spaces |
| Arrow parens | Always |

## Related Documents

- [OVERVIEW.md](OVERVIEW.md) — System architecture, data flow, module table
- [ADR-001](adr/001-sqlite-fts5.md) — SQLite + FTS5 storage decision
- [ADR-002](adr/002-module-organization.md) — Feature-based module organization
- [ADR-003](adr/003-expert-routing.md) — Three-stage expert routing
- [ADR-004](adr/004-subprocess-isolation.md) — Subprocess environment isolation
- [ADR-005](adr/005-lint-rule-pattern.md) — Pluggable lint rule pattern
- [ADR-006](adr/006-mcp-stdio-transport.md) — MCP stdio transport
