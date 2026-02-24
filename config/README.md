# Configuration Files

## mcporter.json

Configuration for [mcporter](https://github.com/steipete/mcporter), enabling CLI-based MCP interactions with the Lux server.

### Usage

From this project directory, mcporter will automatically discover the Lux server:

```bash
# List available servers and tools
mcporter list

# Show detailed tool schemas
mcporter list lux --schema

# Call tools using key=value syntax
mcporter call lux.lux_search query="acme" type="all"

# List registered experts
mcporter call lux.lux_list_experts

# Ask a question (auto-routes to the best expert)
mcporter call lux.lux_ask question="What is the project status?"

# Ask a specific expert
mcporter call lux.lux_ask question="What is the project status?" expert_hint="my-expert"
```

### Global Installation

To make Lux available system-wide, copy this file to `~/.mcporter/mcporter.json`:

```bash
mkdir -p ~/.mcporter
cp config/mcporter.json ~/.mcporter/mcporter.json
```

**Important**: Update the absolute path in the global config to match your installation:

```json
{
  "mcpServers": {
    "lux": {
      "description": "Lux Knowledge Platform - CORPUS semantic search and knowledge retrieval",
      "command": "node",
      "args": [
        "/absolute/path/to/your/lux/dist/mcp/server.js"
      ],
      "env": {
        "NODE_ENV": "production"
      }
    }
  }
}
```

### Using npm link

If you've installed Lux globally via `npm link`, you can use the simpler command-based config:

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

### Environment Variables

You can customize the server behavior using environment variables:

```json
{
  "mcpServers": {
    "lux": {
      "command": "node",
      "args": ["/path/to/lux/dist/mcp/server.js"],
      "env": {
        "NODE_ENV": "production",
        "LUX_DB_PATH": "${HOME}/.lux/lux.db",
        "LUX_CORPUS_PATH": "${HOME}/CORPUS"
      }
    }
  }
}
```

## See Also

- [MCP Configuration Guide](../docs/MCP-CONFIGURATION.md) - Complete MCP setup documentation
- [MCP Tools](../docs/MCP-TOOLS.md) - Detailed tool documentation
- [Usage Guide](../docs/USAGE.md) - CLI and MCP usage examples
