# Lux MCP Configuration

## Runtime path behavior

The MCP server selects its active corpus at initialization:

1. `LUX_CORPUS_PATH` / `LUX_DB_PATH` are explicit operator overrides. When either is set, the
   process stays fixed to that runtime and ignores client roots.
2. Otherwise, a roots-capable MCP client must provide exactly one `file://` workspace root. Lux uses
   `<root>/.lux/lux.db` and refreshes the runtime when the client sends
   `notifications/roots/list_changed`.
3. A client without roots, an empty/multiple/invalid root list, or a failed root refresh produces a
   structured `workspace-unavailable` refusal. Lux never silently queries its installation cwd.

A root switch is atomic for callers: new calls wait for the latest root refresh and use the new
repository; in-flight calls finish on their leased database handle before that handle closes.

Use `LUX_CORPUS_PATH` only for a deliberately fixed-repository server or with MCP clients that do not
support roots. Omit `LUX_DB_PATH` unless you intentionally want to override the repo-local database.

## Server

- entrypoint: `dist/mcp/server.js`
- transport: stdio
- implementation: `src/mcp/server.ts`

## Minimal config

### Fixed-repository clients

Clients without MCP Roots must set the repository explicitly in the server environment. For example:

```json
{
  "mcpServers": {
    "lux": {
      "command": "lux-mcp",
      "env": {
        "LUX_CORPUS_PATH": "/absolute/path/to/repository"
      }
    }
  }
}
```

### Roots-capable clients

Configure the globally installed `lux-mcp` command without a corpus override. The client-provided active workspace becomes the Lux corpus and may change during the session.

```json
{
  "mcpServers": {
    "lux": {
      "command": "lux-mcp"
    }
  }
}
```

## Verification

```bash
lux-mcp
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

MCP rebuild uses the same canonical overlay-complete rebuild semantics as the CLI and persists overlay trust metadata. If status reports `no-overlay`, `content-only`, `stale-overlay`, or `degraded-overlay`, run `lux index rebuild` against the same corpus/db settings used by the MCP server.
