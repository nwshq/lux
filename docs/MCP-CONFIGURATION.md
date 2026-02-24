# MCP Server Configuration Guide

## Overview

The Lux Knowledge Platform MCP server uses **stdio transport** for communication. This means the server communicates via standard input/output streams, making it compatible with MCP clients like Claude Desktop, mcporter, and other MCP-compliant tools.

## Transport Configuration

### Stdio Transport

The server is configured with `StdioServerTransport` from the MCP SDK:

```typescript
const transport = new StdioServerTransport();
await server.connect(transport);
```

**Key characteristics:**
- **Communication**: Uses stdin/stdout for JSON-RPC messages
- **Error logging**: Uses stderr (does not interfere with protocol)
- **Synchronous**: Single client connection per server instance
- **Stateful**: Maintains connection state throughout session

## Server Metadata

- **Name**: `lux-knowledge-platform`
- **Version**: `0.1.0`
- **Capabilities**: `tools` (6 tools available)

## Client Configuration

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "lux": {
      "command": "node",
      "args": ["/Users/yourusername/Code/lux/dist/mcp/server.js"]
    }
  }
}
```

### Using npm link (Recommended for Development)

After running `npm link` in the project directory:

```json
{
  "mcpServers": {
    "lux": {
      "command": "lux-mcp"
    }
  }
}
```

**Note**: You'll need to add a `lux-mcp` script to `package.json` bin section:

```json
{
  "bin": {
    "lux": "./dist/cli/index.js",
    "lux-mcp": "./dist/mcp/server.js"
  }
}
```

### mcporter

mcporter provides CLI-based MCP interactions and can discover servers from various editor configs.

#### Configuration

**Option 1: Project-level config** (recommended for development)

Use the included `config/mcporter.json`:

```json
{
  "mcpServers": {
    "lux": {
      "description": "Lux Knowledge Platform - CORPUS semantic search and knowledge retrieval",
      "command": "node",
      "args": [
        "/Users/yourusername/Code/lux/dist/mcp/server.js"
      ],
      "env": {
        "NODE_ENV": "production"
      }
    }
  }
}
```

**Option 2: Global config** (for system-wide access)

Create `~/.mcporter/mcporter.json`:

```json
{
  "mcpServers": {
    "lux": {
      "description": "Lux Knowledge Platform - CORPUS semantic search and knowledge retrieval",
      "command": "node",
      "args": [
        "/absolute/path/to/lux/dist/mcp/server.js"
      ],
      "env": {
        "NODE_ENV": "production"
      }
    }
  }
}
```

**Option 3: Using npm link**

After running `npm link`, you can use the `lux-mcp` command:

```json
{
  "mcpServers": {
    "lux": {
      "description": "Lux Knowledge Platform",
      "command": "lux-mcp"
    }
  }
}
```

#### Usage Examples

```bash
# List configured servers
mcporter list

# List Lux tools with schema
mcporter list lux --schema

# Search CORPUS
mcporter call lux.lux_search query="acme" type="all"

# Get client details
mcporter call lux.lux_get_client slug="acme-corp"

# List projects
mcporter call lux.lux_list_projects client_slug="acme-corp"

# Log a communication
mcporter call lux.lux_log_comm client_slug="acme-corp" type="email" subject="Project kickoff" date="2024-01-15"

# Get file content
mcporter call lux.lux_get_file file_path="~/CORPUS/knowledge/10_clients/acme-corp/README.md"

# Rebuild index
mcporter call lux.lux_rebuild_index
```

### Custom MCP Client

For programmatic access:

```typescript
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { spawn } from 'child_process';

const serverProcess = spawn('node', [
  '/path/to/lux/dist/mcp/server.js'
]);

const transport = new StdioClientTransport({
  stdin: serverProcess.stdin,
  stdout: serverProcess.stdout
});

const client = new Client({
  name: 'my-client',
  version: '1.0.0'
}, {
  capabilities: {}
});

await client.connect(transport);

// Call tools
const result = await client.request({
  method: 'tools/call',
  params: {
    name: 'lux_search',
    arguments: {
      query: 'acme',
      type: 'all'
    }
  }
});
```

## Environment Variables

The server respects these environment variables:

- `HOME` - Used to determine default paths (`~/.lux/lux.db`, `~/CORPUS`)
- `NODE_ENV` - Can be set to `production` or `development`

## Verification

### Check Server Starts

```bash
# Should output: "Lux MCP server running on stdio" to stderr
node dist/mcp/server.js
```

**Note**: The server will wait for input on stdin. Press Ctrl+C to exit.

### Test with echo (Simple protocol test)

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0.0"}}}' | node dist/mcp/server.js
```

This should return an `initialize` response with server capabilities.

### Test Tool Listing

Using mcporter or another MCP client:

```bash
mcporter call lux.list_tools
```

Expected response: List of 6 tools (lux_search, lux_get_client, etc.)

## Troubleshooting

### Server Not Starting

**Problem**: No output when running server

**Solution**: Check that:
1. Project is built: `npm run build`
2. Dependencies installed: `npm install`
3. Node version >= 20: `node --version`

### "Cannot find module" Error

**Problem**: Module import errors

**Solution**:
1. Ensure TypeScript compilation succeeded: `npm run build`
2. Check that `dist/` directory exists and contains compiled JS
3. Verify imports use `.js` extensions (required for ES modules)

### MCP Client Can't Connect

**Problem**: Client reports connection failure

**Solution**:
1. Verify absolute path to `server.js` in config
2. Check server runs standalone: `node dist/mcp/server.js`
3. Ensure no other process is using the server
4. Check client logs for specific error messages

### Database Not Found

**Problem**: Server starts but tools fail with "database not found"

**Solution**:
1. Run index rebuild: `lux index rebuild`
2. Verify `~/.lux/lux.db` exists
3. Check file permissions on database

## Protocol Details

### JSON-RPC Communication

The server uses JSON-RPC 2.0 over stdio:

**Request format** (stdin):
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "lux_search",
    "arguments": {
      "query": "acme"
    }
  }
}
```

**Response format** (stdout):
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "content": [
      {
        "type": "text",
        "text": "[{\"type\":\"client\",\"title\":\"Acme Corp\",\"slug\":\"acme-corp\"}]"
      }
    ]
  }
}
```

### Error Handling

Errors are returned in JSON-RPC error format:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "content": [
      {
        "type": "text",
        "text": "Error: Client not found: invalid-slug"
      }
    ],
    "isError": true
  }
}
```

## Security Considerations

### File System Access

The server can:
- ✅ Read files in `~/CORPUS` directory
- ✅ Write to `~/CORPUS/*/communications/` directories
- ✅ Read/write `~/.lux/lux.db` database
- ❌ Cannot access files outside CORPUS or .lux directories

### Recommended Permissions

```bash
# CORPUS should be readable/writable by user
chmod 755 ~/CORPUS

# Database directory
chmod 755 ~/.lux
chmod 644 ~/.lux/lux.db
```

### Running in Production

For production deployments:

1. Use absolute paths in configuration
2. Set `NODE_ENV=production`
3. Ensure proper file permissions
4. Consider running server as dedicated user
5. Monitor stderr for errors
6. Implement log rotation for error logs

## Advanced Configuration

### Custom Database Path

Modify `server.ts` to use custom database path:

```typescript
const dbPath = process.env.LUX_DB_PATH || DEFAULT_DB_PATH;
const db = new LuxDatabase(dbPath);
```

Then set environment variable in client config:

```json
{
  "mcpServers": {
    "lux": {
      "command": "node",
      "args": ["/path/to/server.js"],
      "env": {
        "LUX_DB_PATH": "/custom/path/to/lux.db"
      }
    }
  }
}
```

### Custom CORPUS Path

Similarly for CORPUS:

```typescript
const corpusPath = process.env.LUX_CORPUS_PATH || DEFAULT_CORPUS_PATH;
const scanner = new CorpusScanner(corpusPath);
```

### Multiple Server Instances

You can run multiple server instances with different configurations:

```json
{
  "mcpServers": {
    "lux-personal": {
      "command": "node",
      "args": ["/path/to/server.js"],
      "env": {
        "LUX_CORPUS_PATH": "~/personal/CORPUS"
      }
    },
    "lux-work": {
      "command": "node",
      "args": ["/path/to/server.js"],
      "env": {
        "LUX_CORPUS_PATH": "~/work/CORPUS"
      }
    }
  }
}
```

## Resources

- [MCP SDK Documentation](https://github.com/modelcontextprotocol/sdk)
- [MCP Specification](https://spec.modelcontextprotocol.io/)
- [Lux Usage Guide](./USAGE.md)
- [MCP Tools Documentation](./MCP-TOOLS.md)
- [JSON-RPC 2.0 Specification](https://www.jsonrpc.org/specification)
