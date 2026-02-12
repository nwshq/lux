# Implementation Payload: Lux Knowledge Platform

**Source Exploration:** `CORPUS/explorations/lux-knowledge-platform.md`  
**Client:** NWSHQ (Internal)

---

## Overview

TypeScript MCP server and CLI for CORPUS semantic search and knowledge retrieval. File-first architecture — markdown files remain source of truth, SQLite index provides fast lookups.

---

## Core Principles

1. **File-First** — Content never duplicated to database. Index stores paths and metadata only.
2. **MCP-Native** — Primary interface is MCP tools for AI consumption.
3. **CORPUS Conventions** — Follows existing directory structure.
4. **Git-Aware** — Index rebuilds on git changes (hooks).

---

## Stack

- **Language:** TypeScript / Node.js
- **Database:** SQLite (single file, portable)
- **MCP:** @modelcontextprotocol/sdk
- **CLI:** Commander.js
- **Search:** SQLite FTS5 (metadata), direct file access (content)

---

## Entities (Index Only)

| Entity | Purpose |
|--------|---------|
| Client | Registry of clients (slug, name, type, file path) |
| Project | Registry of projects per client |
| Communication | Metadata for communication files |
| KnowledgeEntry | Metadata for knowledge files |
| Event | Audit trail from ecosystem |

---

## MCP Tools

| Tool | Description |
|------|-------------|
| `lux_search` | Search clients, projects, comms, knowledge |
| `lux_get_client` | Get client metadata + file paths |
| `lux_list_projects` | List projects for a client |
| `lux_log_comm` | Log a communication (creates file + index) |
| `lux_log_event` | Log an event (audit trail) |
| `lux_get_file` | Get content of a CORPUS file |

---

## CLI Commands

```bash
lux client list
lux client show <slug>
lux project list --client=<slug>
lux comm log --client=<slug> --type=email ...
lux search <query>
lux index rebuild
lux hooks install
```

---

## Files Reference

| File | Purpose |
|------|---------|
| `TASKS.md` | Detailed task breakdown (8 phases) |
| `NOTES.md` | Implementation notes, decisions |

---

## Directory Structure

```
lux/
├── src/
│   ├── cli/           # Commander.js CLI
│   ├── mcp/           # MCP server
│   ├── db/            # SQLite schema + queries
│   ├── scanner/       # CORPUS file scanner
│   └── index.ts
├── data/
│   └── lux.db         # SQLite index
├── package.json
└── tsconfig.json
```
