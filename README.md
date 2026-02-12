# Lux Knowledge Platform

TypeScript MCP server and CLI for CORPUS semantic search and knowledge retrieval.

## Features

- **CORPUS Scanner**: Automatically indexes clients, projects, communications, and knowledge entries
- **Metadata Search**: Fast search across all indexed entities
- **MCP Server**: Native Model Context Protocol interface for AI integration
- **CLI Tools**: Human-friendly commands for querying and managing CORPUS
- **Communication Logging**: Track emails, meetings, Slack conversations with structured frontmatter
- **Git Integration**: Auto-rebuild index on CORPUS commits via git hooks
- **SQLite Database**: Portable, single-file index with full-text search capability

## Stack

- TypeScript / Node.js
- MCP SDK (@modelcontextprotocol/sdk)
- SQLite (better-sqlite3)
- Commander.js (CLI)
- gray-matter (frontmatter parsing)

## Quick Start

```bash
# Install dependencies
npm install

# Build the project
npm run build

# Link for global CLI usage
npm link

# Index your CORPUS
lux index rebuild

# Search for entities
lux search "acme"

# View client details
lux client show acme-corp
```

## Documentation

- [USAGE.md](./USAGE.md) - Detailed CLI and MCP usage guide
- [docs/TASKS.md](./docs/TASKS.md) - Implementation task list
- [docs/NOTES.md](./docs/NOTES.md) - Architecture decisions and notes

## Project Structure

```
lux/
├── src/
│   ├── cli/           # Command-line interface
│   │   ├── index.ts   # Main CLI entry point
│   │   ├── comm.ts    # Communication logging commands
│   │   ├── search.ts  # Search command
│   │   └── hooks.ts   # Git hooks management
│   ├── mcp/           # MCP server
│   │   └── server.ts  # MCP stdio server with tools
│   ├── db/            # Database layer
│   │   ├── schema.sql # SQLite schema
│   │   ├── index.ts   # Database connection and queries
│   │   └── types.ts   # TypeScript types
│   └── scanner/       # CORPUS scanner
│       ├── index.ts   # Directory scanner and parser
│       └── types.ts   # Scanner types
├── bin/
│   └── post-commit-hook.sh  # Git hook script
└── docs/              # Documentation

