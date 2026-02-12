# Tasks: Lux Knowledge Platform

**Target:** `/path/to/lux`

---

## Phase 1: Project Scaffold

### 1.1 Initialize Project
- [ ] Set up TypeScript project with strict mode
- [ ] Configure package.json with dependencies
- [ ] Set up ESLint + Prettier
- [ ] Create directory structure (src/cli, src/mcp, src/db, src/scanner)

### 1.2 Dependencies
- [ ] Install @modelcontextprotocol/sdk
- [ ] Install better-sqlite3
- [ ] Install commander (CLI)
- [ ] Install glob (file scanning)

---

## Phase 2: Database Schema

### 2.1 SQLite Schema
- [ ] Create schema.sql with tables:
  - clients (id, slug, name, type, status, file_path, metadata, timestamps)
  - projects (id, client_id, slug, name, status, file_path, metadata, timestamps)
  - communications (id, client_id, project_id, type, subject, date_range, file_path, metadata, timestamps)
  - knowledge_entries (id, client_id, project_id, type, title, file_path, tags, timestamps)
  - events (id, timestamp, source, source_id, client_id, project_id, event_type, summary, payload)

### 2.2 Database Module
- [ ] Create db/index.ts with connection management
- [ ] Create db/queries.ts with prepared statements
- [ ] Add migration support (simple version table)

---

## Phase 3: CORPUS Scanner

### 3.1 Scanner Implementation
- [ ] Create scanner/index.ts
- [ ] Parse CORPUS directory structure:
  - `knowledge/10_clients/{slug}/` → Client
  - `knowledge/10_clients/{slug}/projects/{slug}/` → Project (if exists)
  - `knowledge/10_clients/{slug}/{project}/` → Project (legacy)
  - `knowledge/10_clients/{slug}/communications/*.md` → Communication
  - `knowledge/**/*.md` → KnowledgeEntry (with type detection)

### 3.2 Frontmatter Extraction
- [ ] Parse YAML frontmatter from markdown files
- [ ] Extract: type, date, participants, tags, status

### 3.3 Index Population
- [ ] `scanner.scan(corpusPath)` → returns entities
- [ ] `scanner.index(entities)` → writes to SQLite

---

## Phase 4: CLI Foundation

### 4.1 CLI Setup
- [ ] Create cli/index.ts with Commander
- [ ] Add global options: --db, --corpus

### 4.2 Client Commands
- [ ] `lux client list` — list all clients
- [ ] `lux client show <slug>` — show client details + file paths

### 4.3 Project Commands
- [ ] `lux project list --client=<slug>` — list projects
- [ ] `lux project show <slug>` — show project details

### 4.4 Index Commands
- [ ] `lux index rebuild` — full rescan + reindex
- [ ] `lux index status` — show index stats

---

## Phase 5: Communication Logging

### 5.1 Log Command
- [ ] `lux comm log --client=<slug> [--project=<slug>] --type=<type> --subject=<subject>`
- [ ] Options: --file (content file), --participants, --date

### 5.2 File Creation
- [ ] Generate filename: `YYYY-MM-DD_slug_subject.md`
- [ ] Create frontmatter from options
- [ ] Write to `communications/` directory
- [ ] Add to index

### 5.3 List Command
- [ ] `lux comm list --client=<slug>` — list communications
- [ ] Options: --project, --type, --since, --until

---

## Phase 6: Search

### 6.1 Metadata Search
- [ ] `lux search <query>` — search clients, projects, comms by metadata
- [ ] Options: --client, --type (client|project|comm|knowledge)
- [ ] Return: entity type, slug, title, file_path

### 6.2 FTS5 Setup <!-- assignee: future -->
- [ ] Add FTS5 virtual table for full-text search
- [ ] Index file content on scan
- [ ] `lux search --content <query>` — search file content

---

## Phase 7: MCP Server

### 7.1 Server Setup
- [ ] Create mcp/server.ts with MCP SDK
- [ ] Configure stdio transport
- [ ] Register tools

### 7.2 Tools Implementation
- [ ] `lux_search` — wrapper around search
- [ ] `lux_get_client` — get client metadata + file paths
- [ ] `lux_list_projects` — list projects for client
- [ ] `lux_log_comm` — log communication (creates file + index)
- [ ] `lux_log_event` — log event to audit trail
- [ ] `lux_get_file` — return content of a CORPUS file

### 7.3 mcporter Configuration
- [ ] Create MCP server config for mcporter
- [ ] Test with `mcporter call lux.lux_search ...`

---

## Phase 8: Git Hooks

### 8.1 Hook Installation
- [ ] `lux hooks install` — install post-commit hook to CORPUS repo
- [ ] Hook script: `lux index rebuild --quiet`

### 8.2 Hook Script
- [ ] Create bin/post-commit-hook.sh
- [ ] Handle: commit detection, rebuild trigger, error handling

---

## Post-Implementation

- [ ] Add tests for scanner
- [ ] Add tests for MCP tools
- [ ] Documentation: README with usage examples
- [ ] mcporter registration in OpenClaw config
