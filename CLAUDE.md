# Lux

Developer and agent reference.

## Runtime

- Node >= 22.12 (WASM SQLite — no native build; `commander@15` sets the floor)
- ESM project
- CLI binary: `lux`
- MCP binary: `lux-mcp`

## Path resolution

Shared resolver: `src/utils/runtime-paths.ts`

- corpus: `--corpus` -> `LUX_CORPUS_PATH` -> cwd
- db: `--db` -> `LUX_DB_PATH` -> `<corpus>/.lux/lux.db`

## Current CLI surface

- `lux index rebuild|sync|status`
- `lux search`
- `lux hooks install|uninstall`
- `lux migrate status|up|create`
- `lux deps graph|clusters|impact|coverage`
- `lux vendor-pack build|status`
- `lux trace <symbol>`
- `lux overlay status|check|ownership|operational ask|boundaries ...`

## Current MCP surface

From `src/mcp/server.ts`:
- `lux_search`
- `lux_log_event`
- `lux_get_file`
- `lux_rebuild_index`
- `lux_trace`
- `lux_spec_derivation_evidence`

## Overlay

Important commands:

```bash
lux index rebuild
lux overlay status
lux overlay check
```

Current operator-facing overlay states:
- `overlay-complete`
- `degraded-overlay`
- `content-only`

## Key files

- `src/cli/index.ts`
- `src/cli/search.ts`
- `src/cli/hooks.ts`
- `src/cli/deps.ts`
- `src/cli/trace.ts`
- `src/cli/overlay.ts`
- `src/mcp/server.ts`
- `src/utils/runtime-paths.ts`

## Rules

- trust code over stale prose
- do not document removed command groups or MCP tools as live
- corpus files are source of truth, db is derived state
