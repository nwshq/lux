# Lux Knowledge Platform - Usage Guide

## Installation

```bash
# Install dependencies
npm install

# Build the project
npm run build

# Link for local development
npm link
```

## CLI Commands

### Index Management

Rebuild the index by scanning CORPUS:
```bash
# Canonical path: rebuild content index + structural overlay
lux index rebuild
lux index rebuild --corpus /path/to/CORPUS

# Quiet mode
lux index rebuild --quiet

# Fallback path: content index only, no structural overlay materialization
lux index rebuild --content-only
```

Incrementally update the index from git changes:
```bash
lux index sync
```

Inspect overlay trust state:
```bash
lux overlay status
lux overlay status --json
lux overlay check
```

Check index statistics:
```bash
lux index status
```

#### Overlay trust modes

Lux now reports one operator-facing trust mode for the structural overlay:

- `overlay-complete` - canonical rebuild state, structural overlay present and trusted
- `degraded-overlay` - overlay exists, but trust is reduced or stale, usually after structural sync drift
- `content-only` - fallback content index with no canonical structural overlay

Use `lux overlay check` as a gate in benchmarks, CI, or validation scripts when you need canonical structural truth.

### Client Commands

List all clients:
```bash
lux client list
```

Show client details:
```bash
lux client show <client-slug>
```

### Project Commands

List projects for a client:
```bash
lux project list --client <client-slug>
```

Show project details:
```bash
lux project show <project-slug> --client <client-slug>
```

### Communication Commands

Log a new communication:
```bash
lux comm log \
  --client acme-corp \
  --type email \
  --subject "Q1 Planning Discussion" \
  --date 2026-02-12 \
  --participants "john@example.com,jane@example.com" \
  --content "Discussion about Q1 priorities..."
```

With project:
```bash
lux comm log \
  --client acme-corp \
  --project website-redesign \
  --type meeting \
  --subject "Design Review" \
  --date 2026-02-12
```

List communications:
```bash
lux comm list --client acme-corp
lux comm list --client acme-corp --project website-redesign
lux comm list --client acme-corp --type email --limit 10
```

### Search

Search comprehensively across all entities using **FTS5 full-text search** (clients, projects, communications, knowledge):

```bash
# Basic search (fast FTS5 token-based matching)
lux search "email"

# Phrase search (exact phrase matching)
lux search '"sinai chicago"'

# Prefix search (wildcard matching)
lux search "prov*"
lux search "email*"

# Boolean operators
lux search "provider AND photos"
lux search "email OR slack"
lux search "meeting NOT cancelled"

# Filter by client
lux search "redesign" --client acme-corp

# Filter by entity type
lux search "meeting" --type comm
lux search "architecture" --type knowledge

# Limit results
lux search "email" --limit 5

# Search by date
lux search "2026-02-12"

# Search by participant
lux search "john smith"

# Search only file content (not metadata)
lux search "implementation details" --content
lux search "React components" --content --type project

# Legacy substring search (for backward compatibility)
lux search "email" --legacy
```

**FTS5 Features:**
- ⚡ **Fast**: Uses inverted indexes for near-instantaneous search
- 🎯 **Smart ranking**: Results ordered by relevance
- 🔍 **Advanced queries**: Phrase search, prefix matching, boolean operators
- 📊 **Scales**: Consistent performance even with 10,000+ entities

**Search scope**: The search command searches across:
- Client/project names, slugs, types, and status
- Communication subjects, types, dates, and participants
- Knowledge entry titles, types, and tags
- All metadata JSON fields (frontmatter)
- File content (markdown body) - use `--content` flag to search only content

See [docs/SEARCH.md](./docs/SEARCH.md) for comprehensive search documentation.

### Git Hooks

The git post-commit hook automatically rebuilds the Lux index when CORPUS content changes.

#### Installation

Install the hook in your CORPUS repository:
```bash
lux hooks install
lux hooks install --corpus /path/to/CORPUS
```

Uninstall the hook:
```bash
lux hooks uninstall
```

#### Smart Rebuild Detection

The hook intelligently determines when to rebuild:

**✅ Triggers rebuild when:**
- Files in `knowledge/` are modified
- Files in `explorations/` are modified
- Files in `implementation-payloads/` are modified

**⏭️ Skips rebuild when:**
- Only non-CORPUS files changed (e.g., `.gitignore`, scripts)
- Commit message contains `[skip lux]`, `[lux skip]`, or `[no index]`
- Environment variable `LUX_SKIP_REBUILD=1` is set
- Lux CLI is not available

#### Error Handling

The hook is designed to **never fail your git commit**, even if:
- Lux CLI is not found or not executable
- Index rebuild encounters an error
- Database is locked or corrupted

All errors are logged and the commit proceeds successfully.

#### Configuration

Control hook behavior with environment variables:

```bash
# Skip all rebuilds (useful during bulk operations)
export LUX_SKIP_REBUILD=1

# Enable detailed logging
export LUX_LOG_FILE=~/.lux/hook.log

# Use a different lux binary
export LUX_CLI=/usr/local/bin/lux
```

#### Example Workflows

**Skip rebuild for a single commit:**
```bash
git commit -m "Update README [skip lux]"
```

**Skip rebuilds during bulk changes:**
```bash
export LUX_SKIP_REBUILD=1
# ... make multiple commits ...
unset LUX_SKIP_REBUILD
lux index rebuild  # Manual canonical rebuild when done
```

**Debug hook issues:**
```bash
export LUX_LOG_FILE=~/.lux/hook.log
git commit -m "Test commit"
cat ~/.lux/hook.log
```

## MCP Server

### Running the Server

Start the MCP server on stdio:
```bash
npm run mcp
# or
node dist/mcp/server.js
```

For detailed configuration instructions, see [docs/MCP-CONFIGURATION.md](./docs/MCP-CONFIGURATION.md).

### MCP Tools

The MCP server provides the following tools:

#### lux_search
Search for entities in CORPUS using **FTS5 full-text search** (with automatic fallback to legacy search if FTS5 is unavailable).

Supports the same FTS5 query syntax as the CLI:
- Phrase search: `"exact phrase"`
- Prefix matching: `prov*`
- Boolean operators: `term1 AND term2`, `term1 OR term2`, `term1 NOT term2`

```json
{
  "query": "acme",
  "type": "all",
  "client": "acme-corp",
  "limit": 20
}
```

**Note**: Ensure database migrations are up to date (`lux migrate status`) for FTS5 functionality.

#### lux_get_client
Get detailed client information.

```json
{
  "slug": "acme-corp"
}
```

#### lux_list_projects
List projects for a client.

```json
{
  "client_slug": "acme-corp"
}
```

#### lux_log_comm
Log a new communication.

```json
{
  "client_slug": "acme-corp",
  "project_slug": "website-redesign",
  "type": "email",
  "subject": "Design Review",
  "date": "2026-02-12",
  "participants": ["john@example.com"],
  "content": "Discussion notes..."
}
```

#### lux_log_event
Log an event to the audit trail.

```json
{
  "source": "mcp",
  "event_type": "search",
  "summary": "Searched for acme",
  "client_slug": "acme-corp"
}
```

#### lux_get_file
Read a CORPUS file.

```json
{
  "file_path": "/Users/user/CORPUS/knowledge/10_clients/acme-corp/README.md"
}
```

#### lux_rebuild_index
Rebuild the entire index using the canonical overlay-complete path.

```json
{}
```

## Configuration

### Default Paths

- **Database**: `~/.lux/lux.db`
- **CORPUS**: `~/CORPUS`

### Custom Paths

Override defaults with CLI options:
```bash
lux --db /path/to/db --corpus /path/to/CORPUS index rebuild
```

## Examples

### Initial Setup

```bash
# 1. Build the project
npm run build

# 2. Link for global usage
npm link

# 3. Index your CORPUS
lux index rebuild

# 4. Verify the index
lux index status

# 5. Install git hook for auto-indexing
lux hooks install
```

### Daily Usage

```bash
# Search for a client
lux search "acme"

# View client details
lux client show acme-corp

# Log a communication
lux comm log \
  --client acme-corp \
  --type email \
  --subject "Weekly Update" \
  --date $(date +%Y-%m-%d)

# List recent communications
lux comm list --client acme-corp --limit 5
```

### MCP Integration

Configure your MCP client (e.g., Claude Desktop) to use the Lux server:

```json
{
  "mcpServers": {
    "lux": {
      "command": "node",
      "args": ["/path/to/lux/dist/mcp/server.js"]
    }
  }
}
```

## Database Migrations

Lux uses a migration system to manage database schema changes. Migrations are automatically run when the database is opened, but you can manage them manually:

Check migration status:
```bash
lux migrate status
```

Apply pending migrations:
```bash
lux migrate up
```

**Important**: After upgrading Lux, run `lux migrate status` to check for pending migrations. The FTS5 search feature requires migration 002.

## Troubleshooting

### Database locked error
The database uses WAL mode. Ensure no other processes are accessing it.

### Hook not working
Verify the hook is executable:
```bash
ls -la ~/CORPUS/.git/hooks/post-commit
```

### Index out of date
Manually rebuild:
```bash
lux index rebuild
```

### Search not working
If search returns no results or errors:
1. Check migration status: `lux migrate status`
2. Apply pending migrations: `lux migrate up`
3. Try legacy search: `lux search "query" --legacy`

## Development

Watch mode for development:
```bash
npm run dev
```

Lint and format:
```bash
npm run lint
npm run format
```
