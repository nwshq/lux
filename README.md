# Lux

Internal reference for the current Lux CLI and MCP server.

## Runtime path resolution

Shared resolver: `src/utils/runtime-paths.ts`

- corpus: `--corpus` -> `LUX_CORPUS_PATH` -> current working directory
- db: `--db` -> `LUX_DB_PATH` -> `<resolved corpus>/.lux/lux.db`

## Current CLI surface

- `lux index rebuild|sync|status`
- `lux search`
- `lux hooks install|uninstall`
- `lux migrate status|up|create`
- `lux lint`
- `lux expert list|show|add|remove|discover`
- `lux ask`
- `lux deps graph|clusters|impact|coverage`
- `lux overlay status|check`

## Current MCP surface

From `src/mcp/server.ts`:
- `lux_search`
- `lux_log_event`
- `lux_get_file`
- `lux_rebuild_index`
- `lux_list_experts`
- `lux_ask`

## Working rules

- corpus files are source of truth
- db is derived state
- `lux index rebuild` is the canonical rebuild path
- `lux overlay check` is the hard gate for overlay-complete validation
- trust code over stale prose

## Pointers

- `CLAUDE.md`
- `docs/README.md`
- `docs/USAGE.md`
- `docs/MCP-CONFIGURATION.md`
- `docs/MCP-TOOLS.md`
