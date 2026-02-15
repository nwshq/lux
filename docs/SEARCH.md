# Lux Search Documentation

## Overview

The `lux search` command provides comprehensive full-text search capabilities powered by SQLite FTS5 across all indexed entities in the Lux Knowledge Platform: clients, projects, communications, and knowledge entries.

### FTS5 Full-Text Search

Starting with version 0.1.0, Lux uses SQLite's FTS5 (Full-Text Search) engine for fast, sophisticated search capabilities:

- **Fast performance**: FTS5 uses inverted indexes for near-instantaneous search
- **Relevance ranking**: Results are automatically ordered by relevance
- **Advanced query syntax**: Supports phrase search, prefix matching, and boolean operators
- **Automatic synchronization**: FTS5 indexes stay in sync with your data via database triggers

## Usage

```bash
lux search <query> [options]
```

### Arguments

- `<query>` - Search term (case-insensitive)

### Options

- `--client <slug>` - Filter results by client slug
- `--type <type>` - Filter by entity type: `client`, `project`, `comm`, `knowledge`, or `all` (default)
- `--limit <n>` - Maximum number of results to display (default: 20)
- `--legacy` - Use legacy substring search instead of FTS5 (for backward compatibility)

## Search Scope

### What Gets Searched

The search command performs a comprehensive search across the following fields:

#### Clients
- Slug
- Name
- Type
- Status
- Metadata (JSON fields)

#### Projects
- Slug
- Name
- Status
- Metadata (JSON fields)

#### Communications
- Subject
- Type (email, meeting, slack, etc.)
- Date range
- Participants (JSON array)
- Metadata (JSON fields)

#### Knowledge Entries
- Title
- Type (methodology, spec, architecture, exploration, implementation-payload, general)
- Tags (JSON array)
- Metadata (JSON fields)

### Search Behavior

#### FTS5 Mode (Default)

- **Token-based matching**: Searches for complete tokens/words (e.g., "email" matches "email-thread" but not "emails")
- **Prefix matching**: Use `*` wildcard for prefix search (e.g., "email*" matches "email", "emails", "email-thread")
- **Phrase search**: Use quotes for exact phrase matching (e.g., `"sinai chicago"`)
- **Boolean operators**: Use `AND`, `OR`, `NOT` for complex queries (e.g., `email AND provider`)
- **Relevance ranking**: Results are ordered by relevance score
- **Fast performance**: Optimized for large datasets using inverted indexes

#### Legacy Mode (--legacy flag)

- **Case-insensitive**: All searches are case-insensitive
- **Substring matching**: Partial matches are supported (e.g., "provider" matches "provider-photos")
- **Slower on large datasets**: Scans all records in memory

#### Common to Both Modes

- **Metadata search**: Searches within JSON metadata fields for all entity types
- **Event logging**: All searches are logged to the events table for auditing

## Examples

### Basic Search

Search across all entities:
```bash
lux search email
```

### Advanced FTS5 Queries

#### Phrase Search

Search for exact phrases using quotes:
```bash
lux search '"sinai chicago"'
```

#### Prefix Search

Use `*` wildcard for prefix matching:
```bash
lux search "email*"
lux search "prov*"
```

#### Boolean Operators

Combine terms with AND, OR, NOT:
```bash
# Both terms must be present
lux search "provider AND photos"

# Either term can be present
lux search "email OR slack"

# Exclude terms
lux search "provider NOT photos"
```

#### Column-Specific Search

Search within specific fields:
```bash
# Search only in the title field of knowledge entries
lux search "type:methodology" --type knowledge

# Search only in subject field of communications
lux search "subject:meeting" --type comm
```

### Search by Entity Type

Search only communications:
```bash
lux search meeting --type comm
```

Search only clients:
```bash
lux search acme --type client
```

Search only projects:
```bash
lux search website --type project
```

Search only knowledge entries:
```bash
lux search architecture --type knowledge
```

### Client-Filtered Search

Search within a specific client:
```bash
lux search provider --client sinai-chicago
```

### Date Search

Find communications by date:
```bash
lux search 2026-02-12
```

### Participant Search

Find communications by participant name:
```bash
lux search "jacob santos"
```

### Limited Results

Limit the number of results:
```bash
lux search email --limit 5
```

## Output Format

Search results are displayed in the following format:

```
Search results for "<query>" (N):

[<entity-type>] <title>
  Slug: <slug>          # (if applicable)
  Context: <context>    # (status, date, or type)
  Path: <file-path>
```

### Example Output

```
Search results for "email" (3):

[communication] [email] Test Communication
  Context: 2026-02-12
  Path: /Users/.../communications/2026-02-12_email_test-communication.md

[communication] [email-thread] Provider Photos Project
  Context: 2026-01-19
  Path: /Users/.../communications/2026-01-19_provider-photos-project.md

[client] Email Marketing Corp
  Slug: email-marketing
  Path: /Users/.../10_clients/email-marketing/AGENTS.md
```

## No Results

When no results are found, the command displays:
```
No results found for: <query>
```

## Event Logging

All search operations are logged to the events table with the following information:
- Query string
- Entity type filter
- Client filter (if used)
- Number of results returned
- Total number of matches found
- Timestamp

You can view recent search activity with:
```bash
sqlite3 ~/.lux/lux.db "SELECT * FROM events WHERE event_type = 'search' ORDER BY timestamp DESC LIMIT 10"
```

## Performance Considerations

### FTS5 Mode (Default)

- **Extremely fast**: Uses inverted indexes for near-instantaneous search even on large datasets
- **Scales well**: Performance remains consistent with 10,000+ entities
- **Low memory usage**: Only matching results are loaded into memory
- **Automatic indexing**: Indexes are updated automatically via database triggers

### Legacy Mode (--legacy)

- Search is performed in-memory on indexed data
- For very large CORPUS directories (>10,000 entities), searches may take a few seconds
- Results are limited by the `--limit` option to prevent overwhelming output
- Metadata JSON parsing is performed on-demand during search

## Migration

If you're upgrading from a previous version without FTS5 support:

1. Run migrations to add FTS5 tables:
   ```bash
   lux migrate up
   ```

2. The migration will automatically:
   - Create FTS5 virtual tables for all entity types
   - Populate them with existing data
   - Set up triggers to keep them synchronized

3. Verify the migration:
   ```bash
   lux migrate status
   ```

4. Test FTS5 search:
   ```bash
   lux search "test query"
   ```

5. If you encounter issues, use the legacy mode:
   ```bash
   lux search "test query" --legacy
   ```

## Integration with MCP

The search functionality is also available through the MCP server via the `lux_search` tool:

```typescript
{
  name: "lux_search",
  arguments: {
    query: "email",
    type: "comm",
    limit: 10
  }
}
```

See the MCP server documentation for more details on programmatic access.

## Tips

1. **Use type filters** for faster, more targeted searches
2. **Client filtering** is useful when working on a specific client's context
3. **Date searches** are particularly effective for finding recent communications
4. **Metadata searches** allow finding entities by any frontmatter field
5. **Combine with other CLI commands** by piping file paths to other tools

## Related Commands

- `lux client show <slug>` - View detailed client information
- `lux project show <slug>` - View detailed project information
- `lux comm list` - List all communications
- `lux index rebuild` - Rebuild the search index
- `lux index status` - View index statistics
