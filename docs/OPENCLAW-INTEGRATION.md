# OpenClaw Integration

## Overview

The Lux Knowledge Platform MCP server is now registered with OpenClaw through the `mcporter` skill. This enables OpenClaw agents to access Lux's CORPUS semantic search and knowledge retrieval capabilities.

## Configuration

### Location

The Lux MCP server is registered in `~/.mcporter/mcporter.json`:

```json
{
  "mcpServers": {
    "lux": {
      "description": "Lux Knowledge Platform - CORPUS semantic search and knowledge retrieval",
      "command": "node",
      "args": [
        "/path/to/lux/dist/mcp/server.js"
      ],
      "env": {
        "NODE_ENV": "production"
      }
    }
  }
}
```

### OpenClaw mcporter Skill

OpenClaw includes a bundled `mcporter` skill that automatically discovers MCP servers configured in `~/.mcporter/mcporter.json`.

**Skill Status:**
```bash
openclaw skills info mcporter
```

**Output:**
```
📦 mcporter ✓ Ready

Use the mcporter CLI to list, configure, auth, and call MCP servers/tools
directly (HTTP or stdio), including ad-hoc servers, config edits, and
CLI/type generation.
```

## Verification

### List Available Servers

```bash
mcporter list
```

**Expected Output:**
```
mcporter 0.7.3 — Listing 1 server(s) (per-server timeout: 30s)
- lux — Lux Knowledge Platform - CORPUS semantic search and knowledge retrieval (7 tools, 0.1s)
✔ Listed 1 server (1 healthy).
```

### List Lux Tools

```bash
mcporter list lux --schema
```

**Available Tools:**
1. `lux_search` - Search for clients, projects, communications, or knowledge entries
2. `lux_get_client` - Get detailed client information
3. `lux_list_projects` - List all projects for a client
4. `lux_get_file` - Get file content from CORPUS
5. `lux_log_comm` - Log a communication
6. `lux_log_event` - Log an event
7. `lux_rebuild_index` - Rebuild the search index

### Test Tool Call

```bash
mcporter call lux.lux_search query="acme" type="all"
```

## Usage in OpenClaw

OpenClaw agents can now use the Lux MCP server through the mcporter skill:

```bash
# Ask OpenClaw to search CORPUS
openclaw agent --message "Use mcporter to search for acme clients in Lux"

# Have OpenClaw log a communication
openclaw agent --message "Use mcporter to log an email communication to acme-corp"
```

## Architecture

```
┌─────────────────┐
│   OpenClaw      │
│   Agent         │
└────────┬────────┘
         │
         │ uses
         ↓
┌─────────────────┐
│   mcporter      │
│   skill         │
└────────┬────────┘
         │
         │ reads config
         ↓
┌─────────────────┐
│ ~/.mcporter/    │
│ mcporter.json   │
└────────┬────────┘
         │
         │ defines
         ↓
┌─────────────────┐
│   Lux MCP       │
│   Server        │
└────────┬────────┘
         │
         │ accesses
         ↓
┌─────────────────┐
│   CORPUS        │
│   Knowledge     │
│   Base          │
└─────────────────┘
```

## Updating the Configuration

If you move the Lux project or need to update the configuration:

1. Edit `~/.mcporter/mcporter.json`
2. Update the absolute path in `args` array
3. Verify with `mcporter list`

## Troubleshooting

### Server Not Found

**Problem:** `mcporter list` doesn't show Lux server

**Solution:**
1. Check that `~/.mcporter/mcporter.json` exists
2. Verify the file contains valid JSON
3. Ensure the path to `server.js` is correct

### Server Unhealthy

**Problem:** Server appears but marked as unhealthy

**Solution:**
1. Ensure the project is built: `cd /path/to/lux && npm run build`
2. Test the server directly: `node /path/to/lux/dist/mcp/server.js`
3. Check that `~/.lux/lux.db` exists
4. Verify Node.js version >= 20

### Tool Calls Fail

**Problem:** mcporter can list tools but calls fail

**Solution:**
1. Run index rebuild: `lux index rebuild`
2. Verify CORPUS directory exists: `ls ~/CORPUS`
3. Check database permissions: `ls -la ~/.lux/lux.db`

## Related Documentation

- [MCP Configuration Guide](./MCP-CONFIGURATION.md) - Complete MCP setup documentation
- [MCP Tools](./MCP-TOOLS.md) - Detailed tool documentation
- [Usage Guide](./USAGE.md) - CLI and MCP usage examples
- [mcporter Documentation](https://mcporter.dev) - Official mcporter documentation

## Resources

- [OpenClaw Documentation](https://docs.openclaw.ai/)
- [OpenClaw Skills](https://docs.openclaw.ai/skills/)
- [MCP Specification](https://spec.modelcontextprotocol.io/)

Sources:
- [Feature: Native MCP support · Issue #4834](https://github.com/openclaw/openclaw/issues/4834)
- [OpenClaw MCP Support Discussion](https://news.ycombinator.com/item?id=46847406)
