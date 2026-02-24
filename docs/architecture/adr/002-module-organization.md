# ADR-002: Feature-Based Module Organization

**Status:** accepted
**Date:** 2026-02-23

## Context

Lux is a TypeScript application with multiple distinct capabilities: CLI commands, an MCP server, a database layer, a CORPUS scanner, an expert routing system, a lint engine, and shared utilities. As the codebase grows, a clear organizational strategy is needed to keep modules cohesive, discoverable, and independently testable.

Two common approaches exist for TypeScript projects:

1. **Layer-based organization** — grouping files by technical role (`controllers/`, `models/`, `services/`, `tests/`). This separates related logic across directories and makes it difficult to understand a feature in isolation.

2. **Feature-based organization** — grouping files by domain capability (`db/`, `experts/`, `lint/`, `scanner/`). Each module directory contains its types, implementation, sub-modules, and tests together.

Lux also needs a convention for test file placement. Tests colocated near source files reduce navigation friction and make it immediately clear which modules have coverage gaps.

## Decision

We adopt **feature-based module organization** with **colocated `__tests__/` directories** inside each module.

### Directory Structure Convention

Each top-level module in `src/` is a self-contained directory organized by domain capability:

```
src/
├── cli/                     # Human interface — CLI commands
│   ├── __tests__/           # Tests for CLI commands
│   │   ├── ask-command.test.ts
│   │   ├── expert-commands.test.ts
│   │   └── validate-mount-path.test.ts
│   ├── index.ts             # Entry point — registers all command groups
│   ├── ask.ts               # Expert panel query command
│   ├── comm.ts              # Communication logging
│   ├── expert.ts            # Expert registration/management
│   ├── hooks.ts             # Git hook install/uninstall
│   ├── lint.ts              # CORPUS linting command
│   ├── migrate.ts           # Database migration commands
│   └── search.ts            # FTS5 search command
│
├── db/                      # Data access — SQLite CRUD, FTS5, migrations
│   ├── __tests__/
│   │   ├── expert-crud.test.ts
│   │   └── expert-sessions.test.ts
│   ├── index.ts             # LuxDatabase class
│   ├── types.ts             # Entity interfaces
│   ├── queries.ts           # PreparedQueries (parameterized SQL)
│   ├── migrations.ts        # MigrationRunner
│   └── migrations/          # Versioned .sql files (001–004)
│
├── experts/                 # Expert panel — routing + subprocess management
│   ├── __tests__/
│   │   ├── router.test.ts
│   │   └── subprocess-manager.test.ts
│   ├── router.ts            # 3-stage routing (FTS5 → LLM → subprocess)
│   ├── session-manager.ts   # Abstract session interface
│   └── subprocess-manager.ts
│
├── lint/                    # CORPUS linting — pluggable rules
│   ├── __tests__/
│   │   ├── lint-engine.test.ts
│   │   └── ...              # One test file per rule
│   ├── index.ts             # LintEngine + rule registration
│   ├── types.ts             # LintRule interface, LintResult, Severity
│   └── rules/               # Sub-module: rule implementations
│       ├── naming/          # File naming convention rules
│       ├── location/        # Directory structure validation rules
│       └── structure/       # Content structure check rules
│
├── scanner/                 # CORPUS filesystem scanner
│   ├── __tests__/
│   │   └── scanner.test.ts
│   ├── index.ts             # Re-exports
│   ├── general.ts           # GeneralScanner (glob + frontmatter)
│   ├── config.ts            # lux.yaml loader (Zod schema)
│   ├── types.ts             # Scanner result types
│   └── lsp/                 # Sub-module: LSP enrichment
│       ├── __tests__/
│       │   └── enrichment-pipeline.test.ts
│       ├── index.ts         # Re-exports
│       ├── client.ts        # LSP client implementation
│       └── php.ts           # PHP-specific enricher
│
├── mcp/                     # MCP server — AI tool interface
│   ├── __tests__/
│   │   └── server.test.ts
│   └── server.ts            # Stdio MCP server (8 tools)
│
├── init/                    # Corpus initialization
│   └── index.ts             # AI-assisted lux.yaml generation
│
├── utils/                   # Shared utilities
│   ├── __tests__/
│   │   └── subprocess-env.test.ts
│   ├── frontmatter.ts       # YAML frontmatter helpers
│   └── subprocess-env.ts    # Clean env for subprocesses
│
└── integration/             # Cross-module integration tests
    └── __tests__/
        └── auctic-core.test.ts
```

### Module Conventions

**Entry points.** Each module exposes its public API through an `index.ts` barrel file or a clearly named primary file (e.g., `router.ts`, `general.ts`, `server.ts`).

**Type definitions.** Modules with shared interfaces define them in a `types.ts` file adjacent to the implementation. This keeps type imports explicit (`import type { LintRule } from './types.js'`) and avoids circular dependencies.

**Sub-modules.** Modules that contain a distinct subsystem (e.g., `lint/rules/`, `scanner/lsp/`) organize that subsystem as a nested directory with its own `index.ts` re-exports and colocated `__tests__/` directory.

**SQL migrations.** The `db/migrations/` directory is a special case — it contains `.sql` files (not TypeScript modules) numbered sequentially (`001_*.sql`, `002_*.sql`). These are loaded at runtime by the `MigrationRunner`.

### Test Colocation Pattern

Tests live in a `__tests__/` directory inside the module they test:

```
src/<module>/__tests__/<name>.test.ts
```

**Rules:**

1. **Every module that contains logic gets a `__tests__/` sibling.** Modules with only re-exports (barrel files) do not need tests.

2. **Test files are named after the unit they test.** For example, `router.ts` is tested by `__tests__/router.test.ts`. Individual lint rules are tested by descriptively named files (e.g., `valid-exploration-filename.test.ts`).

3. **Sub-modules have their own `__tests__/`.** The `scanner/lsp/` sub-module contains `scanner/lsp/__tests__/enrichment-pipeline.test.ts`, not `scanner/__tests__/lsp-enrichment.test.ts`.

4. **Integration tests live in `src/integration/__tests__/`.** Tests that exercise multiple modules together are placed in a dedicated `integration/` module.

5. **Vitest discovers tests via glob.** The pattern `src/**/__tests__/**/*.test.ts` (configured in `vitest.config.ts`) automatically finds all colocated tests regardless of nesting depth.

### Import Conventions

All imports use ESM `.js` extensions as required by Node16 module resolution:

```typescript
// Correct: .js extension for ESM
import { LuxDatabase } from '../db/index.js';
import type { LintRule } from './types.js';

// Incorrect: bare specifier (will fail at runtime)
import { LuxDatabase } from '../db/index';
```

Cross-module imports reference other top-level modules by relative path from `src/`. Modules do not reach into another module's internal files — they import from the module's entry point or `types.ts`.

## Consequences

### Positive

- **Feature cohesion.** All files related to a capability (types, implementation, tests, sub-modules) are in a single directory. Developers can understand a module by reading one directory.
- **Discoverable test gaps.** A module directory without a `__tests__/` subdirectory is immediately visible as lacking coverage.
- **Independent module development.** Each module can be understood, tested, and modified without navigating across the full `src/` tree.
- **Natural code ownership.** Module boundaries map to areas of responsibility, making it clear who owns what during review.
- **Scalable sub-modules.** The nested sub-module pattern (e.g., `lint/rules/`, `scanner/lsp/`) scales to arbitrary depth without requiring a separate top-level directory.

### Negative

- **Deeper nesting for sub-modules.** The path `src/scanner/lsp/__tests__/enrichment-pipeline.test.ts` is four levels deep. This is manageable but may feel verbose for small sub-modules.
- **Barrel file maintenance.** Modules with `index.ts` re-exports require keeping the barrel file in sync when adding or removing exports.
- **Potential for oversized modules.** Without explicit guidance, a module like `cli/` can grow to contain many files. The convention relies on developers splitting into sub-modules when complexity warrants it.

### Neutral

- **No shared `__tests__/` at root.** Unlike some projects that place all tests in a top-level `test/` directory, Lux distributes tests across the source tree. This is a stylistic choice that trades centralized test discovery for colocation benefits.
- **`utils/` as a catch-all.** The `utils/` module exists for genuinely shared helpers. It should remain small — if a utility grows complex enough to warrant its own types and tests, it should become its own module.
