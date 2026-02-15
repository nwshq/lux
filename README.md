# Lux Knowledge Platform

A powerful TypeScript MCP server and CLI for semantic search and knowledge retrieval across your CORPUS.

## Overview

Lux provides **instant access to your entire knowledge base** through:

- **Fast FTS5 Full-Text Search**: Near-instantaneous search across 10,000+ entities with phrase matching, prefix search, and boolean operators
- **MCP Server Integration**: Native Model Context Protocol server for AI assistants (Claude Desktop, etc.)
- **Intelligent Git Hooks**: Automatic index rebuilds when CORPUS content changes
- **CLI Tools**: Human-friendly commands for querying clients, projects, and communications
- **Communication Logging**: Structured tracking of emails, meetings, and conversations
- **SQLite Database**: Portable, single-file index with automatic migrations

## Key Features

### 🔍 Advanced Search
- **FTS5 full-text search** with inverted indexes for instant results
- **Boolean operators** (`AND`, `OR`, `NOT`) for complex queries
- **Phrase search** with exact matching (`"exact phrase"`)
- **Prefix matching** with wildcards (`email*`, `prov*`)
- **Content-only search** to find text within markdown bodies
- **Relevance ranking** with automatic result ordering
- Search across clients, projects, communications, and knowledge entries

### 🤖 MCP Server
- **7 MCP tools** for AI integration: search, client info, project lists, file reading, communication logging, event tracking, and index rebuilding
- **Stdio transport** compatible with Claude Desktop, mcporter, and custom clients
- **Real-time access** to your CORPUS from AI assistants

### 🔄 Git Integration
- **Smart post-commit hook** with automatic change detection
- **Skip directives** in commit messages (`[skip lux]`, `[no index]`)
- **Performance optimized** to only rebuild when CORPUS content changes
- **Never fails commits** - robust error handling

### 📊 Database
- **SQLite with FTS5** for fast, scalable full-text search
- **Automatic migrations** for schema updates
- **WAL mode** for concurrent read access
- **Event audit trail** for tracking all operations

## Technology Stack

- **TypeScript** / Node.js (>=20.0.0)
- **MCP SDK** (@modelcontextprotocol/sdk) - Model Context Protocol integration
- **SQLite** (better-sqlite3) - Database with FTS5 full-text search
- **Commander.js** - CLI framework
- **gray-matter** - YAML frontmatter parsing
- **Vitest** - Testing framework with coverage

## Quick Start

### Installation

```bash
# Clone or navigate to the project
cd lux

# Install dependencies
npm install

# Build the project
npm run build

# Link for global CLI usage
npm link

# Index your CORPUS
lux index rebuild

# Check index status
lux index status
```

### First Search

```bash
# Basic search across all entities
lux search "acme"

# Advanced FTS5 search with boolean operators
lux search "provider AND photos"

# Phrase search for exact matches
lux search '"sinai chicago"'

# Prefix search with wildcards
lux search "email*"

# Filter by entity type
lux search "architecture" --type knowledge

# Search only file content (not metadata)
lux search "implementation details" --content
```

### View Client Information

```bash
# List all clients
lux client list

# Show detailed client information
lux client show acme-corp

# List projects for a client
lux project list --client acme-corp
```

## Common Workflows

### Log a Communication

```bash
# Log an email
lux comm log \
  --client acme-corp \
  --type email \
  --subject "Q1 Planning Discussion" \
  --date 2026-02-12 \
  --participants "john@example.com,jane@example.com"

# Log a meeting with project context
lux comm log \
  --client acme-corp \
  --project website-redesign \
  --type meeting \
  --subject "Design Review" \
  --date 2026-02-12

# List recent communications
lux comm list --client acme-corp --limit 10
```

### Set Up Git Hooks

```bash
# Install hook in your CORPUS repository
cd ~/CORPUS
lux hooks install

# The hook will now automatically rebuild the index after commits
# that modify knowledge/, explorations/, or implementation-payloads/

# Skip rebuild for a specific commit
git commit -m "WIP: draft notes [skip lux]"

# Uninstall hook if needed
lux hooks uninstall
```

### Run the MCP Server

```bash
# Start the MCP server (stdio mode)
npm run mcp

# Or run directly
node dist/mcp/server.js
```

Configure in Claude Desktop (`~/Library/Application Support/Claude/claude_desktop_config.json`):

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

### OpenClaw Integration

The Lux MCP server is registered with OpenClaw through the `mcporter` skill:

```bash
# Installation
mkdir -p ~/.mcporter
cp config/mcporter.json ~/.mcporter/mcporter.json

# Verify registration
mcporter list

# Test tool call
mcporter call lux.lux_search query="acme" type="all"
```

See [OpenClaw Integration Guide](./docs/OPENCLAW-INTEGRATION.md) for complete setup and usage.

## Usage Examples

### Example 1: Daily Knowledge Retrieval

```bash
# Morning routine: check recent communications
lux comm list --client acme-corp --limit 5

# Search for specific project discussions
lux search "authentication" --client acme-corp --type comm

# Read project documentation
lux client show acme-corp
lux project show website-redesign --client acme-corp
```

### Example 2: Research and Documentation

```bash
# Find architecture documentation
lux search "architecture" --type knowledge

# Search for methodologies
lux search "agile" --type knowledge

# Content-only search for implementation details
lux search "React hooks" --content --type knowledge

# Boolean search for related topics
lux search "authentication AND oauth" --type knowledge
```

### Example 3: Client Management

```bash
# List all clients
lux client list

# Search for specific client
lux search "acme"

# Get full client context
lux client show acme-corp

# List all projects for client
lux project list --client acme-corp

# View recent client communications
lux comm list --client acme-corp
```

### Example 4: Advanced Search Patterns

```bash
# Exact phrase matching
lux search '"design system"'

# Prefix search for variations
lux search "email*"  # Matches: email, emails, email-thread

# Boolean AND (all terms must match)
lux search "provider AND photos"

# Boolean OR (any term can match)
lux search "email OR slack OR meeting"

# Boolean NOT (exclude terms)
lux search "meeting NOT cancelled"

# Combine filters
lux search "authentication" --client acme-corp --type project --limit 5
```

### Example 5: MCP Integration Workflow

Using mcporter CLI:

```bash
# List available Lux tools
mcporter list lux --schema

# Search from command line
mcporter call lux.lux_search query="acme" type="all"

# Get client information
mcporter call lux.lux_get_client slug="acme-corp"

# List projects
mcporter call lux.lux_list_projects client_slug="acme-corp"

# Read a file
mcporter call lux.lux_get_file file_path="~/CORPUS/clients/acme-corp/CLIENT.md"

# Log a communication
mcporter call lux.lux_log_comm \
  client_slug="acme-corp" \
  type="email" \
  subject="Project Update" \
  date="2026-02-12"
```

### Example 6: Database Migrations

```bash
# Check migration status
lux migrate status

# Apply pending migrations
lux migrate up

# Rebuild index after migration
lux index rebuild
```

## MCP Tools

The MCP server provides 7 tools for AI integration:

| Tool | Description |
|------|-------------|
| **lux_search** | Search across all CORPUS entities with FTS5 full-text search |
| **lux_get_client** | Get detailed client information with projects and communications |
| **lux_list_projects** | List all projects for a specific client |
| **lux_log_comm** | Log a new communication and create markdown file |
| **lux_log_event** | Log an event to the audit trail |
| **lux_get_file** | Read and return CORPUS file content |
| **lux_rebuild_index** | Rebuild the entire CORPUS index |

See [docs/MCP-TOOLS.md](./docs/MCP-TOOLS.md) for detailed tool documentation.

## Project Structure

```
lux/
├── src/
│   ├── cli/              # Command-line interface
│   │   ├── index.ts      # Main CLI entry point
│   │   ├── comm.ts       # Communication logging commands
│   │   ├── search.ts     # Search command implementation
│   │   ├── hooks.ts      # Git hooks management
│   │   └── migrate.ts    # Database migration commands
│   ├── mcp/              # MCP server
│   │   ├── server.ts     # MCP stdio server with 7 tools
│   │   └── __tests__/    # MCP server tests
│   ├── db/               # Database layer
│   │   ├── schema.sql    # SQLite schema (legacy)
│   │   ├── migrations/   # Database migration files
│   │   ├── index.ts      # Database connection and queries
│   │   ├── queries.ts    # Prepared SQL statements
│   │   ├── types.ts      # TypeScript types
│   │   └── migrations.ts # Migration management
│   ├── scanner/          # CORPUS scanner
│   │   ├── index.ts      # Directory scanner and parser
│   │   ├── types.ts      # Scanner types
│   │   └── __tests__/    # Scanner tests
│   └── utils/            # Shared utilities
├── bin/
│   └── post-commit-hook.sh  # Git hook script
├── config/               # Configuration files
│   └── mcporter.json     # mcporter MCP client config
├── docs/                 # Documentation
│   ├── MCP-CONFIGURATION.md  # MCP server setup
│   ├── MCP-TOOLS.md          # Detailed tool documentation
│   ├── GIT-HOOKS.md          # Git hooks guide
│   ├── SEARCH.md             # Search documentation
│   └── SCANNER-API.md        # Scanner API reference
└── test-*.{sh,cjs}       # Integration tests
```

## Documentation

### User Guides
- **[USAGE.md](./USAGE.md)** - Comprehensive CLI and MCP usage guide
- **[docs/SEARCH.md](./docs/SEARCH.md)** - Search features and FTS5 query syntax
- **[docs/GIT-HOOKS.md](./docs/GIT-HOOKS.md)** - Git hooks setup and configuration
- **[docs/MCP-CONFIGURATION.md](./docs/MCP-CONFIGURATION.md)** - MCP server configuration for clients

### Technical References
- **[docs/MCP-TOOLS.md](./docs/MCP-TOOLS.md)** - Detailed MCP tools documentation
- **[docs/SCANNER-API.md](./docs/SCANNER-API.md)** - CORPUS scanner API reference
- **[config/](./config/)** - Configuration examples for MCP clients

## Configuration

### Default Paths

- **Database**: `~/.lux/lux.db`
- **CORPUS**: `~/CORPUS`

### Custom Paths

Override defaults with environment variables or CLI options:

```bash
# Using CLI options
lux --db /path/to/db --corpus /path/to/CORPUS index rebuild

# Using environment variables (for MCP server)
export LUX_DB_PATH=/path/to/db
export LUX_CORPUS_PATH=/path/to/CORPUS
npm run mcp
```

### Git Hook Configuration

Control hook behavior with environment variables:

```bash
# Skip all rebuilds (useful during bulk operations)
export LUX_SKIP_REBUILD=1

# Enable detailed logging
export LUX_LOG_FILE=~/.lux/hook.log

# Custom rebuild timeout (default: 300 seconds)
export LUX_REBUILD_TIMEOUT=600

# Use a different lux binary
export LUX_CLI=/usr/local/bin/lux
```

## Development

### Build and Test

```bash
# Watch mode for development
npm run dev

# Run all tests
npm test

# Run tests with UI
npm run test:ui

# Run tests with coverage
npm run test:coverage

# Full quality check (lint + format + build + test)
npm run check
```

### Linting and Formatting

```bash
# Check code style
npm run lint
npm run format:check

# Auto-fix issues
npm run lint:fix
npm run format
```

## Troubleshooting

### Search Returns No Results

If search returns no results or errors:

1. Check migration status: `lux migrate status`
2. Apply pending migrations: `lux migrate up`
3. Rebuild the index: `lux index rebuild`
4. Try legacy search: `lux search "query" --legacy`

### Database Locked Error

The database uses WAL mode. Ensure no other processes are accessing it:

```bash
# Check for lock files
ls -la ~/.lux/

# Force rebuild if needed
lux index rebuild
```

### Git Hook Not Working

Verify the hook is installed and executable:

```bash
# Check hook exists
ls -la ~/CORPUS/.git/hooks/post-commit

# Make it executable
chmod +x ~/CORPUS/.git/hooks/post-commit

# Enable debug logging
export LUX_LOG_FILE=~/.lux/hook.log
git commit -m "Test commit"
cat ~/.lux/hook.log
```

### Index Out of Date

Manually rebuild the index:

```bash
lux index rebuild

# Check status
lux index status
```

### MCP Server Issues

If the MCP server isn't working:

1. Verify the build: `npm run build`
2. Test server directly: `node dist/mcp/server.js`
3. Check absolute path in MCP client config
4. Ensure database exists: `lux index rebuild`
5. Check client logs for specific errors

## Contributing

### Running Tests

```bash
# Unit tests
npm test

# Integration tests
./test-hooks-integration.sh
./test-post-commit-hook.sh
./test-log-event.sh

# MCP tests
node test-get-file-simple.cjs
node test-list-projects.sh
```

### Code Quality

Before submitting changes:

```bash
# Run full quality check
npm run check

# This runs:
# - ESLint (lint)
# - Prettier (format:check)
# - TypeScript build (build)
# - Vitest tests (test)
```

## License

MIT

## Resources

- [MCP SDK Documentation](https://github.com/modelcontextprotocol/sdk)
- [MCP Specification](https://spec.modelcontextprotocol.io/)
- [SQLite FTS5 Documentation](https://www.sqlite.org/fts5.html)
- [Claude Desktop Configuration](https://docs.anthropic.com/claude/docs/model-context-protocol)