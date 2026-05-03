# Lux MCP Configuration

## Runtime path behavior

Server path resolution uses `src/utils/runtime-paths.ts` at process startup:

- corpus: `LUX_CORPUS_PATH` or cwd
- db: `LUX_DB_PATH` or `<corpus>/.lux/lux.db`

Prefer setting `LUX_CORPUS_PATH` explicitly in MCP client configuration. Omit `LUX_DB_PATH` unless you intentionally want to override the repo-local database.

## Server

- entrypoint: `dist/mcp/server.js`
- transport: stdio
- implementation: `src/mcp/server.ts`

## Minimal config

### Claude Desktop

```json
{
  "mcpServers": {
    "lux": {
      "command": "node",
      "args": ["/absolute/path/to/lux/dist/mcp/server.js"]
    }
  }
}
```

### mcporter

```json
{
  "mcpServers": {
    "lux": {
      "command": "node",
      "args": ["/absolute/path/to/lux/dist/mcp/server.js"],
      "env": {
        "NODE_ENV": "production",
        "LUX_CORPUS_PATH": "/absolute/path/to/corpus"
      }
    }
  }
}
```

## Verification

```bash
node dist/mcp/server.js
mcporter list
mcporter list lux --schema
mcporter call lux.lux_search query="acme" type="all"
```

## Failure checks

```bash
lux index rebuild
lux index status --json
lux overlay status --json
ls -la /path/to/corpus/.lux/lux.db
```

Use `LUX_DB_PATH` only when intentionally overriding the corpus-local default. MCP rebuild uses the same canonical overlay-complete rebuild semantics as the CLI and persists overlay trust metadata; if status reports `no-overlay`, `content-only`, `stale-overlay`, or `degraded-overlay`, run `lux index rebuild` against the same corpus/db settings used by the MCP server.
