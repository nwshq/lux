# Architecture Decision Records

This directory contains Architecture Decision Records (ADRs) for the Lux Knowledge Platform.

ADRs document significant architectural decisions, their context, and consequences. Use the [template](TEMPLATE.md) when creating new records.

## Index

| ID | Title | Status | Date |
|----|-------|--------|------|
| [001](001-sqlite-fts5.md) | SQLite with FTS5 for Knowledge Storage | accepted | 2026-02-23 |
| [002](002-module-organization.md) | Feature-Based Module Organization | accepted | 2026-02-23 |
| [003](003-expert-routing.md) | Three-Stage Expert Routing Algorithm | accepted | 2026-02-23 |
| [004](004-subprocess-isolation.md) | Subprocess Environment Isolation | accepted | 2026-02-23 |
| [005](005-lint-rule-pattern.md) | Pluggable Lint Rule Pattern | accepted | 2026-02-23 |
| [006](006-mcp-stdio-transport.md) | MCP Stdio Transport Integration | accepted | 2026-02-23 |

## Conventions

- **Filename format:** `NNN-title-in-kebab-case.md` (e.g., `001-sqlite-as-index-store.md`)
- **Statuses:** `proposed` → `accepted` → `deprecated` or `superseded`
- **Numbering:** Sequential, zero-padded to three digits
- Use the [ADR template](TEMPLATE.md) for all new records
