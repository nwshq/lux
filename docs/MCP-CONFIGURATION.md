# Lux MCP Configuration

## Runtime path behavior

Server path resolution uses `src/utils/runtime-paths.ts`:

- corpus: `LUX_CORPUS_PATH` or cwd
- db: `LUX_DB_PATH` or `<corpus>/.lux/lux.db`

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
ls -la /path/to/corpus/.lux/lux.db
```

Use `LUX_DB_PATH` only when intentionally overriding the corpus-local default.
