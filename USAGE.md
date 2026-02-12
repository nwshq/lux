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
lux index rebuild
lux index rebuild --corpus /path/to/CORPUS

# Quiet mode (for git hooks)
lux index rebuild --quiet
```

Check index statistics:
```bash
lux index status
```

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

Search across all entities:
```bash
lux search "acme"
lux search "redesign" --client acme-corp
lux search "meeting" --type comm
lux search "architecture" --type knowledge --limit 5
```

### Git Hooks

Install auto-indexing hook:
```bash
lux hooks install
lux hooks install --corpus /path/to/CORPUS
```

Uninstall hook:
```bash
lux hooks uninstall
```

## MCP Server

### Running the Server

Start the MCP server on stdio:
```bash
npm run mcp
# or
node dist/mcp/server.js
```

### MCP Tools

The MCP server provides the following tools:

#### lux_search
Search for entities in CORPUS.

```json
{
  "query": "acme",
  "type": "all",
  "client": "acme-corp",
  "limit": 20
}
```

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
Rebuild the entire index.

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
