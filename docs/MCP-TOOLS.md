# MCP Tools Documentation

This document provides detailed documentation for all MCP tools available in the Lux Knowledge Platform.

## Available Tools

1. **lux_search** - Search for entities across CORPUS using FTS5 full-text search
2. **lux_get_client** - Get detailed client information with metadata and file paths
3. **lux_list_projects** - List all projects for a specific client
4. **lux_log_comm** - Log a new communication and create markdown file
5. **lux_log_event** - Log an event to the audit trail
6. **lux_get_file** - Read and return CORPUS file content
7. **lux_rebuild_index** - Rebuild the entire CORPUS index

---

## lux_list_projects

List all projects for a specific client. This is a streamlined tool that returns only the project list without additional client context or communications data.

### Input Schema

```json
{
  "client_slug": "string (required)"
}
```

- **client_slug**: The client slug identifier (e.g., "acme", "sinai-chicago")

### Response Format

Returns a JSON array of project objects:

```json
[
  {
    "id": number,
    "client_id": number,
    "slug": string,
    "name": string,
    "status": string | null,
    "file_path": string,
    "metadata": string | null,
    "content": string | null,
    "created_at": number,
    "updated_at": number
  }
]
```

### Response Fields

Each project object contains:

- **id**: Internal database ID
- **client_id**: Reference to parent client ID
- **slug**: Project slug (unique within the client)
- **name**: Project display name
- **status**: Current project status (e.g., "active", "completed", "on-hold")
- **file_path**: Absolute path to the project's markdown file in CORPUS
- **metadata**: JSON string containing additional project metadata from frontmatter
- **content**: Full markdown content of the project file
- **created_at**: Unix timestamp when the project was created/indexed
- **updated_at**: Unix timestamp when the project was last updated

### Error Responses

If the client is not found, returns an error response:

```json
{
  "isError": true,
  "content": [
    {
      "type": "text",
      "text": "Client not found: {client_slug}"
    }
  ]
}
```

### Usage Examples

#### Basic Usage

```json
{
  "name": "lux_list_projects",
  "arguments": {
    "client_slug": "acme"
  }
}
```

#### Use Cases

1. **Project Discovery**: Quickly get a list of all projects for a client
2. **Project Navigation**: Find available projects before drilling into specific project details
3. **Status Overview**: Review status of all projects for planning purposes
4. **File Path Resolution**: Get file paths for all projects to read their content
5. **Lightweight Query**: Get project list without the overhead of communication data (unlike `lux_get_client`)

### Comparison with lux_get_client

| Feature | lux_list_projects | lux_get_client |
|---------|------------------|----------------|
| Returns client metadata | ❌ No | ✅ Yes |
| Returns project list | ✅ Yes | ✅ Yes |
| Returns communications | ❌ No | ✅ Yes (10 most recent) |
| Response size | Smaller | Larger |
| Use case | Quick project list | Full client context |

**When to use `lux_list_projects`:**
- You only need the project list
- You want a faster, lighter response
- You already have client context

**When to use `lux_get_client`:**
- You need full client information
- You want recent communications
- You're starting fresh without client context

### Implementation Details

- Located in: `src/mcp/server.ts` (lines 457-473)
- Database queries:
  - `db.getClient(client_slug)` - Validates client exists
  - `db.getProjectsByClient(client.id)` - Retrieves all projects for the client
- Database query location: `src/db/index.ts` (line 153)
- Prepared query definition: `src/db/queries.ts` (lines 104-106)

### SQL Query

The underlying SQL query is:

```sql
SELECT * FROM projects
WHERE client_id = ?
ORDER BY name
```

### Testing

Test the tool using the provided test script:

```bash
# Basic functionality test
node test-list-projects-mcp.cjs

# Manual test via stdio
echo '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"lux_list_projects","arguments":{"client_slug":"acme"}}}' | node dist/mcp/server.js
```

### Related Tools

- **lux_get_client**: Get full client information including projects and communications
- **lux_search**: Search for projects across all clients
- **lux_get_file**: Read the actual project file content using the file_path returned by this tool

### Performance Notes

- This tool performs two database queries:
  1. One to validate the client exists
  2. One to retrieve all projects for that client
- Projects are ordered alphabetically by name
- All queries use prepared statements for optimal performance
- Returns full project content in the response (may be large for projects with extensive documentation)
- Faster than `lux_get_client` because it doesn't fetch communication data

### Future Enhancements

Potential improvements for future versions:

- Add filtering options (by status, date range)
- Add sorting options (by name, created_at, updated_at)
- Add option to exclude content field for faster responses
- Add pagination for clients with many projects
- Include project statistics (communication count, knowledge entry count)

---

## lux_get_client

Get detailed information about a specific client including metadata, file paths, associated projects, and recent communications.

### Input Schema

```json
{
  "slug": "string (required)"
}
```

- **slug**: The client slug identifier (e.g., "acme", "sinai-chicago")

### Response Format

Returns a JSON object containing:

```json
{
  "client": {
    "id": number,
    "slug": string,
    "name": string,
    "type": string | null,
    "status": string | null,
    "file_path": string,
    "metadata": string | null,
    "content": string | null,
    "created_at": number,
    "updated_at": number
  },
  "projects": [
    {
      "id": number,
      "client_id": number,
      "slug": string,
      "name": string,
      "status": string | null,
      "file_path": string,
      "metadata": string | null,
      "content": string | null,
      "created_at": number,
      "updated_at": number
    }
  ],
  "recent_communications": [
    {
      "id": number,
      "client_id": number,
      "project_id": number | null,
      "type": string,
      "subject": string | null,
      "date_range": string | null,
      "participants": string | null,
      "file_path": string,
      "metadata": string | null,
      "content": string | null,
      "created_at": number,
      "updated_at": number
    }
  ]
}
```

### Response Fields

#### Client Object

- **id**: Internal database ID
- **slug**: Client slug (unique identifier)
- **name**: Client display name
- **type**: Client type (e.g., "client-meta")
- **status**: Current status (e.g., "active", "inactive")
- **file_path**: Absolute path to the client's primary markdown file
- **metadata**: JSON string containing additional metadata
- **content**: Full markdown content of the client file
- **created_at**: Unix timestamp of creation
- **updated_at**: Unix timestamp of last update

#### Projects Array

Contains all projects associated with this client. Each project has:

- **id**: Internal database ID
- **client_id**: Reference to parent client
- **slug**: Project slug (unique within client)
- **name**: Project display name
- **status**: Current status
- **file_path**: Absolute path to the project's markdown file
- **metadata**: JSON string containing additional metadata
- **content**: Full markdown content of the project file
- **created_at**: Unix timestamp of creation
- **updated_at**: Unix timestamp of last update

#### Recent Communications Array

Contains up to 10 most recent communications for this client, ordered by date descending. Each communication has:

- **id**: Internal database ID
- **client_id**: Reference to parent client
- **project_id**: Reference to project (if applicable)
- **type**: Communication type (e.g., "email", "slack", "meeting", "call")
- **subject**: Communication subject/title
- **date_range**: Date string (YYYY-MM-DD format)
- **participants**: JSON array string of participant names/emails
- **file_path**: Absolute path to the communication markdown file
- **metadata**: JSON string containing additional metadata
- **content**: Full markdown content of the communication
- **created_at**: Unix timestamp of creation
- **updated_at**: Unix timestamp of last update

### Error Responses

If the client is not found, returns an error response:

```json
{
  "isError": true,
  "content": [
    {
      "type": "text",
      "text": "Client not found: {slug}"
    }
  ]
}
```

### Usage Examples

#### Basic Usage

```json
{
  "name": "lux_get_client",
  "arguments": {
    "slug": "acme"
  }
}
```

#### Use Cases

1. **Retrieve Client Overview**: Get all information about a client for context in conversations
2. **File Path Resolution**: Get the absolute file path to read client documentation
3. **Project Discovery**: List all projects for a client to determine what work is being done
4. **Recent Activity**: Check recent communications to understand latest interactions
5. **Navigation**: Use file paths to navigate CORPUS structure programmatically

### Implementation Details

- Located in: `src/mcp/server.ts` (lines 425-455)
- Database queries:
  - `db.getClient(slug)` - Retrieves client by slug
  - `db.getProjectsByClient(client.id)` - Retrieves all projects
  - `db.getCommunicationsByClient(client.id)` - Retrieves all communications (limited to first 10)

### Testing

Test the tool using the provided test scripts:

```bash
# Basic functionality test
node test-get-client-mcp.cjs

# Error handling test
node test-get-client-error.cjs
```

Or manually via stdio:

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"lux_get_client","arguments":{"slug":"acme"}}}' | node dist/mcp/server.js
```

### Related Tools

- **lux_search**: Search for clients across CORPUS
- **lux_list_projects**: List projects for a client (similar but returns only project list)
- **lux_get_file**: Read the actual file content from the file_path returned by this tool

### Performance Notes

- This tool performs three database queries (one for client, one for projects, one for communications)
- Communications are limited to the 10 most recent to keep response size manageable
- All queries use prepared statements for optimal performance
- File content is included in the response, which may be large for clients with extensive documentation

### Future Enhancements

Potential improvements for future versions:

- Add pagination for communications (currently hardcoded to 10)
- Add option to exclude content field for faster responses
- Add filtering options for projects by status
- Include knowledge entries related to the client
- Add summary statistics (total communications, total knowledge entries, etc.)

---

## lux_log_event

Log an event to the audit trail for tracking system activity. This tool creates audit log entries that track operations, activities, and events across the Lux Knowledge Platform.

### Input Schema

```json
{
  "source": "string (required)",
  "event_type": "string (required)",
  "summary": "string (required)",
  "client_slug": "string (optional)",
  "project_slug": "string (optional)",
  "payload": "object (optional)"
}
```

#### Required Parameters

- **source**: Event source identifier (e.g., "mcp", "cli", "scanner", "user", "system")
- **event_type**: Type of event being logged (e.g., "search", "comm_logged", "index_rebuild", "user_action")
- **summary**: Brief description of what happened

#### Optional Parameters

- **client_slug**: Client slug to associate this event with a specific client
- **project_slug**: Project slug to associate this event with a specific project (requires client_slug)
- **payload**: Additional structured data as a JSON object (any valid JSON structure)

### Response Format

Returns a simple success confirmation:

```json
{
  "success": true
}
```

The event is immediately persisted to the database with:
- Auto-generated timestamp (Unix epoch)
- Auto-generated event ID
- Resolved client_id (if client_slug provided and valid)
- Resolved project_id (if project_slug provided and valid)
- Serialized payload (if provided)

### Use Cases

1. **Activity Tracking**: Log user actions and system operations for audit purposes
2. **Debugging**: Track events during development and troubleshooting
3. **Analytics**: Capture events for later analysis and reporting
4. **Integration Logging**: Log events from external systems or integrations
5. **Workflow Tracking**: Record steps in multi-step processes

### Common Event Types

While `event_type` is freeform, common conventions include:

- **search**: Search queries executed
- **comm_logged**: New communication logged
- **index_rebuild**: Full index rebuild completed
- **file_created**: New file created in CORPUS
- **file_updated**: Existing file modified
- **client_created**: New client added
- **project_created**: New project added
- **user_action**: Manual user actions
- **system_event**: Automated system events
- **error**: Error conditions

### Common Sources

While `source` is freeform, common conventions include:

- **mcp**: Events from the MCP server
- **cli**: Events from CLI commands
- **scanner**: Events from the CORPUS scanner
- **user**: Direct user actions
- **system**: Automated system events
- **test**: Test-related events

### Usage Examples

#### Example 1: Basic Event Logging

```json
{
  "name": "lux_log_event",
  "arguments": {
    "source": "mcp",
    "event_type": "user_action",
    "summary": "User requested client information"
  }
}
```

#### Example 2: Event with Client Context

```json
{
  "name": "lux_log_event",
  "arguments": {
    "source": "mcp",
    "event_type": "search",
    "summary": "Search query executed for client",
    "client_slug": "acme"
  }
}
```

#### Example 3: Event with Client and Project Context

```json
{
  "name": "lux_log_event",
  "arguments": {
    "source": "cli",
    "event_type": "file_updated",
    "summary": "Project documentation updated",
    "client_slug": "acme",
    "project_slug": "lux-knowledge-platform"
  }
}
```

#### Example 4: Event with Custom Payload

```json
{
  "name": "lux_log_event",
  "arguments": {
    "source": "mcp",
    "event_type": "search",
    "summary": "FTS5 search executed",
    "payload": {
      "query": "authentication",
      "type": "all",
      "results_count": 15,
      "duration_ms": 42
    }
  }
}
```

#### Example 5: Integration Event

```json
{
  "name": "lux_log_event",
  "arguments": {
    "source": "github",
    "event_type": "webhook_received",
    "summary": "Pull request opened",
    "client_slug": "acme",
    "project_slug": "lux-knowledge-platform",
    "payload": {
      "pr_number": 123,
      "author": "johndoe",
      "title": "Add new feature"
    }
  }
}
```

### Implementation Details

- Located in: `src/mcp/server.ts` (lines 574-611)
- Database method: `db.insertEvent(event)` (src/db/index.ts, lines 202-213)
- Database query: `src/db/queries.ts` (lines 157-160)
- Schema: `src/db/migrations/001_initial_schema.sql` (lines 82-100)

### Database Schema

Events are stored in the `events` table:

```sql
CREATE TABLE events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp INTEGER NOT NULL DEFAULT (unixepoch()),
    source TEXT NOT NULL,
    source_id TEXT,
    client_id INTEGER,
    project_id INTEGER,
    event_type TEXT NOT NULL,
    summary TEXT,
    payload TEXT, -- JSON blob
    FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE SET NULL,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL
);
```

### Behavior Notes

- **Graceful Degradation**: If client_slug or project_slug is invalid, the event is still logged but without those associations
- **No Validation**: Event type and source are freeform strings (no predefined enum)
- **Automatic Timestamps**: Timestamp is automatically set to current Unix epoch time
- **Payload Serialization**: Payload objects are automatically serialized to JSON strings
- **Foreign Key Handling**: If referenced clients/projects are deleted, the event remains but with NULL foreign keys

### Testing

Test the tool using the provided test script:

```bash
# Comprehensive test suite
./test-log-event.sh
```

Or manually via stdio:

```bash
# Basic event
echo '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"lux_log_event","arguments":{"source":"test","event_type":"unit_test","summary":"Testing lux_log_event"}}}' | node dist/mcp/server.js

# Event with payload
echo '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"lux_log_event","arguments":{"source":"test","event_type":"custom","summary":"Test with payload","payload":{"key":"value"}}}}' | node dist/mcp/server.js
```

### Querying Events

Events can be queried using the database directly:

```javascript
const db = new LuxDatabase(dbPath);

// Get recent events
const recent = db.getRecentEvents(50); // Last 50 events

// Query events by type, source, client, etc. using raw SQL
// (Additional query methods can be added to LuxDatabase as needed)
```

### Related Tools

- **lux_log_comm**: Similar logging functionality but specifically for communications (creates files)
- **lux_rebuild_index**: Logs an event automatically when index is rebuilt
- **lux_search**: Logs search events automatically

### Performance Notes

- Single database INSERT operation
- Uses prepared statements for optimal performance
- Minimal overhead (typically < 1ms)
- Events table is indexed on timestamp, event_type, client_id, and project_id
- Payload serialization is lightweight (JSON.stringify)

### Future Enhancements

Potential improvements for future versions:

- Add `lux_query_events` tool to search/filter events from MCP
- Add event severity levels (info, warning, error)
- Add event categories/tags for better organization
- Add automatic event retention policies (archive old events)
- Add event correlation IDs for tracking related events
- Add event aggregation and statistics tools
- Add webhooks/notifications for specific event types

---

## lux_get_file

Read and return the content of a CORPUS file by its absolute or relative file path. This tool provides direct file access for reading markdown files, configuration files, or any other text-based content within the CORPUS directory structure.

### Input Schema

```json
{
  "file_path": "string (required)"
}
```

#### Required Parameters

- **file_path**: Absolute or relative path to the file to read

### Response Format

Returns the raw file content as text:

```json
{
  "content": [
    {
      "type": "text",
      "text": "... file content ..."
    }
  ]
}
```

The response contains the complete, unmodified file content including:
- YAML frontmatter (if present)
- Markdown content
- Any other text content

### Error Response Format

If the file cannot be read (doesn't exist, permission denied, etc.), returns an error:

```json
{
  "isError": true,
  "content": [
    {
      "type": "text",
      "text": "Error reading file: Error: ENOENT: no such file or directory, open '/path/to/file'"
    }
  ]
}
```

### Use Cases

1. **Read Client/Project Files**: Get full content of CLIENT.md or PROJECT.md files
2. **Read Communication Logs**: Access complete communication history with frontmatter
3. **Read Knowledge Entries**: Retrieve documentation, specs, or methodology files
4. **Follow-up on Search Results**: After using `lux_search`, read the actual content of found files
5. **Verify File Content**: Check file content before modifying or processing
6. **Debug File Issues**: Inspect files during troubleshooting

### Usage Examples

#### Example 1: Read Client File

```json
{
  "name": "lux_get_file",
  "arguments": {
    "file_path": "/Users/username/CORPUS/clients/acme/CLIENT.md"
  }
}
```

Response:
```
---
type: client-meta
status: active
---

# acme

acme is a client specializing in...
```

#### Example 2: Read Project File

```json
{
  "name": "lux_get_file",
  "arguments": {
    "file_path": "/Users/username/CORPUS/clients/acme/lux-knowledge-platform/PROJECT.md"
  }
}
```

#### Example 3: Read Communication File

```json
{
  "name": "lux_get_file",
  "arguments": {
    "file_path": "/Users/username/CORPUS/clients/acme/lux-knowledge-platform/communications/2025-01-20_email_project-kickoff.md"
  }
}
```

Response includes frontmatter with metadata:
```
---
type: email
subject: Project Kickoff
date: 2025-01-20
participants:
  - john@example.com
  - jane@example.com
---

# Project Kickoff Email

Discussion about...
```

#### Example 4: Read Knowledge Entry

```json
{
  "name": "lux_get_file",
  "arguments": {
    "file_path": "/Users/username/CORPUS/knowledge/methodology/agile-development.md"
  }
}
```

#### Example 5: Workflow - Search Then Read

Typical workflow combining search and file reading:

1. Search for relevant files:
```json
{
  "name": "lux_search",
  "arguments": {
    "query": "authentication implementation",
    "type": "knowledge"
  }
}
```

2. Get the file path from search results
3. Read the full content:
```json
{
  "name": "lux_get_file",
  "arguments": {
    "file_path": "/Users/username/CORPUS/knowledge/architecture/auth-system.md"
  }
}
```

### Implementation Details

- Located in: `src/mcp/server.ts` (lines 613-627)
- Uses Node.js `fs.readFileSync()` for synchronous file reading
- Reads file with UTF-8 encoding
- Returns raw content without any processing or transformation
- Error handling catches and returns filesystem errors

### File Path Resolution

The tool accepts both absolute and relative paths:

- **Absolute paths**: `/Users/username/CORPUS/clients/acme/CLIENT.md`
- **Relative paths**: Resolved relative to the process working directory

For reliability, it's recommended to use absolute paths, especially when:
- Files are obtained from search results (which return absolute paths)
- Files are from database queries (which store absolute paths)

### Supported File Types

While primarily designed for markdown files, `lux_get_file` can read any text-based file:

- `.md` - Markdown files (primary use case)
- `.txt` - Plain text files
- `.json` - JSON configuration files
- `.yaml` / `.yml` - YAML configuration files
- Any other UTF-8 text file

**Note**: Binary files will result in garbled output and should be avoided.

### Error Handling

The tool gracefully handles various error conditions:

- **File not found**: Returns clear ENOENT error message
- **Permission denied**: Returns EACCES error with file path
- **Invalid path**: Returns appropriate filesystem error
- **Directory instead of file**: Returns EISDIR error
- **Encoding issues**: May return garbled content for non-UTF-8 files

All errors are returned with `isError: true` flag in the response.

### Testing

Test the tool using the provided test scripts:

```bash
# Simple test with temporary file
node test-get-file-simple.cjs

# Comprehensive test with CORPUS files (requires CORPUS setup)
node test-get-file-mcp.cjs
```

Or manually via stdio:

```bash
# Read a file
echo '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"lux_get_file","arguments":{"file_path":"/path/to/file.md"}}}' | node dist/mcp/server.js

# Test error handling (non-existent file)
echo '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"lux_get_file","arguments":{"file_path":"/non/existent/file.md"}}}' | node dist/mcp/server.js
```

### Security Considerations

**Path Traversal**: The tool does not restrict file access to the CORPUS directory. It can read any file the process has permission to access. In production deployments, consider:

1. Adding path validation to restrict access to CORPUS directory
2. Implementing path sanitization to prevent `../` attacks
3. Running the MCP server with restricted filesystem permissions
4. Adding access logging for audit purposes

Example path validation (not yet implemented):

```typescript
const normalizedPath = path.resolve(file_path);
const corpusPath = path.resolve(DEFAULT_CORPUS_PATH);

if (!normalizedPath.startsWith(corpusPath)) {
  throw new Error('Access denied: Path outside CORPUS directory');
}
```

### Related Tools

- **lux_search**: Find files by content/metadata before reading them
- **lux_get_client**: Get client details including file_path, then use lux_get_file to read
- **lux_list_projects**: Get project details including file_path, then use lux_get_file to read
- **lux_log_comm**: Creates communication files that can later be read with lux_get_file

### Common Patterns

#### Pattern 1: Search + Read

```typescript
// 1. Search for relevant files
const searchResults = await mcp.call('lux_search', {
  query: 'authentication',
  type: 'knowledge'
});

// 2. Read the most relevant file
const fileContent = await mcp.call('lux_get_file', {
  file_path: searchResults[0].path
});
```

#### Pattern 2: Get Client + Read File

```typescript
// 1. Get client information
const clientInfo = await mcp.call('lux_get_client', {
  slug: 'acme'
});

// 2. Read the client file
const fileContent = await mcp.call('lux_get_file', {
  file_path: clientInfo.client.file_path
});
```

#### Pattern 3: List Projects + Read Multiple

```typescript
// 1. List all projects
const projects = await mcp.call('lux_list_projects', {
  client_slug: 'acme'
});

// 2. Read all project files
const projectContents = await Promise.all(
  projects.map(p => mcp.call('lux_get_file', {
    file_path: p.file_path
  }))
);
```

### Performance Notes

- **Synchronous I/O**: Uses `readFileSync()` for simplicity and reliability
- **No Caching**: Each call reads from disk (future enhancement opportunity)
- **File Size**: Large files (>10MB) may cause delays; consider file size limits
- **Concurrent Reads**: Multiple parallel reads are safe (filesystem handles concurrency)
- **Memory Usage**: Entire file is loaded into memory; be cautious with very large files

### Future Enhancements

Potential improvements for future versions:

- Add path restriction to CORPUS directory for security
- Add file size limit validation (e.g., max 10MB)
- Add optional streaming for large files
- Add optional content filtering (e.g., return only frontmatter)
- Add file metadata in response (size, modified date, etc.)
- Add content caching with TTL for frequently accessed files
- Add support for reading multiple files in one call
- Add optional markdown-to-HTML rendering
- Add optional frontmatter parsing and extraction
- Add access logging for audit trail integration