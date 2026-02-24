# ADR-006: MCP Stdio Transport Integration

**Status:** accepted
**Date:** 2026-02-23

## Context

Lux exposes its knowledge platform capabilities to AI assistants through the Model Context Protocol (MCP). MCP defines a standard interface for tools that AI models can invoke — search documents, read files, query experts, log communications, and more.

The MCP specification supports multiple transport mechanisms:

1. **Stdio transport** — JSON-RPC 2.0 messages over stdin/stdout. The server runs as a child process of the MCP client (e.g., Claude Desktop). Simple to deploy, no network configuration, single-client.

2. **HTTP/SSE transport** — JSON-RPC over HTTP with Server-Sent Events for streaming. Supports multiple concurrent clients, network deployment, authentication. More complex to operate.

Lux is designed as a local knowledge platform — the database and CORPUS are on the user's filesystem. The primary consumers are Claude Desktop and similar local AI tools. A transport that requires no network configuration, no authentication, and no port management is the simplest path to deployment.

## Decision

We implement the MCP server using **stdio transport** with a **static tool registry** pattern in `src/mcp/server.ts`.

### Server Initialization

```typescript
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';

const server = new Server(
  {
    name: 'lux-knowledge-platform',
    version: '0.1.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Lux MCP server running on stdio');
}
```

**Communication model:**
- **stdin** — receives JSON-RPC 2.0 requests from the MCP client
- **stdout** — sends JSON-RPC 2.0 responses back to the client
- **stderr** — used for diagnostic logging (does not interfere with the protocol)

### Tool Registration Pattern

Tools are defined as a static `TOOLS` array of `Tool` objects, each with a name, description, and JSON Schema input specification. Two request handlers manage the tool lifecycle:

```typescript
// Static tool definitions
const TOOLS: Tool[] = [
  {
    name: 'lux_search',
    description: 'Search all indexed documents...',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query string' },
        type: { type: 'string', enum: ['all', 'client', 'project', 'comm', 'knowledge'] },
        limit: { type: 'number', default: 20 },
      },
      required: ['query'],
    },
  },
  // ... additional tools
];

// ListTools — returns the tool catalog to the client
server.setRequestHandler(ListToolsRequestSchema, () => {
  return { tools: TOOLS };
});

// CallTool — dispatches tool invocations by name
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  switch (name) {
    case 'lux_search': { /* ... */ }
    case 'lux_get_client': { /* ... */ }
    // ...
    default:
      return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
  }
});
```

### Tool Inventory

| Tool | Parameters | Description |
|------|-----------|-------------|
| `lux_search` | `query`, `type?`, `client?`, `limit?` | FTS5 search across all indexed entities with optional type/client filtering. Falls back to legacy substring search if FTS5 is unavailable. |
| `lux_get_client` | `slug` | Retrieve client details including associated projects and recent communications. |
| `lux_list_projects` | `client_slug` | List all projects for a given client. |
| `lux_log_comm` | `client_slug`, `type`, `subject`, `date`, `project_slug?`, `participants?`, `content?` | Create a communication log — writes a markdown file with frontmatter and indexes it in the database. |
| `lux_log_event` | `source`, `event_type`, `summary`, `client_slug?`, `project_slug?`, `payload?` | Log an event to the audit trail. |
| `lux_get_file` | `file_path` | Read and return file content by path. |
| `lux_rebuild_index` | *(none)* | Clear and rebuild the entire index by scanning the CORPUS directory. |
| `lux_list_experts` | `status?` | List registered domain experts, optionally filtered by status. |
| `lux_ask` | `question`, `expert_hint?`, `context?` | Query the expert panel. Auto-routes via the three-stage routing pipeline (see [ADR-003](003-expert-routing.md)) or routes to a specific expert via `expert_hint`. |

### Response Format

All tool responses follow the MCP content block pattern:

```typescript
// Success response
return {
  content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
};

// Error response
return {
  content: [{ type: 'text', text: `Error: ${message}` }],
  isError: true,
};
```

Responses are serialized as JSON text within a `text` content block. The `isError` flag distinguishes tool-level errors from protocol-level errors.

### Shared Resources

The server initializes shared resources at startup, reused across all tool invocations:

```typescript
const db = new LuxDatabase(DEFAULT_DB_PATH);           // Single database connection
const sessionManager = new SubprocessSessionManager(db); // Expert subprocess lifecycle
```

The database connection (`~/.lux/lux.db`) and session manager persist for the lifetime of the server process. The CORPUS path (`~/CORPUS`) is used by `lux_rebuild_index` and `lux_log_comm` for filesystem operations.

### Graceful Shutdown

The server registers signal handlers to clean up expert subprocesses:

```typescript
process.on('SIGTERM', () => {
  sessionManager.terminateAll();
  process.exit(0);
});
process.on('SIGINT', () => {
  sessionManager.terminateAll();
  process.exit(0);
});
```

This ensures that long-running expert queries (spawned Claude CLI processes) are terminated when the MCP client disconnects or the server is stopped.

### Client Configuration

MCP clients configure the server as a child process:

```json
{
  "mcpServers": {
    "lux": {
      "command": "node",
      "args": ["/path/to/lux/dist/mcp/server.js"],
      "env": {
        "NODE_ENV": "production"
      }
    }
  }
}
```

Or using the `lux-mcp` binary after `npm link`:

```json
{
  "mcpServers": {
    "lux": {
      "command": "lux-mcp"
    }
  }
}
```

### Event Logging

Tool invocations that modify state or perform significant operations log events to the `events` table with `source: 'mcp'`:

- `lux_search` → `event_type: 'search'` (query, type, result count)
- `lux_log_comm` → `event_type: 'comm_logged'` (file path)
- `lux_rebuild_index` → `event_type: 'index_rebuild'` (entity counts)
- `lux_ask` → `event_type: 'expert_ask'` (routing reason, experts consulted)

Read-only tools (`lux_get_client`, `lux_list_projects`, `lux_get_file`, `lux_list_experts`) do not log events.

## Consequences

### Positive

- **Zero-configuration deployment.** Stdio transport requires no network setup, port allocation, or authentication. The MCP client spawns the server as a child process and communicates directly via pipes.
- **Filesystem locality.** The server runs in the same environment as the CORPUS and database. File paths are directly accessible without network round-trips or path translation.
- **Standard tool discovery.** The `ListTools` handler returns the complete tool catalog with JSON Schema input specifications, enabling MCP clients to present tool descriptions and validate inputs before invocation.
- **Consistent error handling.** All tools use the same `{ content, isError }` response pattern. Errors within tool handlers are caught and returned as tool-level errors rather than crashing the server.
- **Audit trail.** State-modifying operations log to the `events` table, providing a complete record of AI-initiated actions for review.

### Negative

- **Single-client limitation.** Stdio transport supports exactly one client connection. Multiple AI tools cannot share a single server instance — each must spawn its own process.
- **No streaming.** MCP tool responses are returned as complete JSON objects. The `lux_ask` tool cannot stream expert responses token-by-token to the MCP client (unlike the CLI's `--stream` mode).
- **Process lifecycle coupling.** The server lives and dies with the MCP client process. If the client crashes, the server (and any in-flight expert queries) terminates abruptly. Signal handlers mitigate this for graceful shutdown, but ungraceful termination may leave orphaned subprocess state.
- **Static tool registry.** Tools are defined at compile time in a `TOOLS` array and dispatched via a switch statement. Adding a tool requires modifying `server.ts` directly — there is no plugin mechanism for dynamic tool registration.

### Neutral

- **JSON serialization overhead.** All tool responses are JSON-stringified inside a text content block, then JSON-serialized again by the MCP protocol layer. This double-serialization is a standard MCP pattern but adds parsing overhead for large responses (e.g., search results, expert answers).
- **Database connection is long-lived.** The single `LuxDatabase` instance persists for the server's lifetime. SQLite's WAL mode handles this well, but the connection is not shared with simultaneous CLI operations — each creates its own connection.
- **`lux_` prefix convention.** All tool names use the `lux_` prefix to avoid collisions with tools from other MCP servers in the same client configuration. This is a namespace convention, not an MCP protocol requirement.
