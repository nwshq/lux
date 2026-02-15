# Content Indexing Implementation

## Overview

As of migration 003, the Lux Knowledge Platform now indexes the full markdown content of all scanned files into the FTS5 (Full-Text Search) tables. This enables comprehensive full-text search across the actual content of files, not just metadata.

## What Changed

### 1. Database Schema (Migration 003)

Added `content` column to all entity tables and their corresponding FTS5 virtual tables:

- `clients` table and `clients_fts`
- `projects` table and `projects_fts`
- `communications` table and `communications_fts`
- `knowledge_entries` table and `knowledge_entries_fts`

The migration:
- Drops and recreates all FTS5 tables with the new content column
- Updates all triggers to include content in FTS5 synchronization
- Adds content column to base tables
- Re-populates FTS5 tables (content will be NULL until next scan)

### 2. Type System Updates

Updated TypeScript types to include optional `content` field:

**Database types** (`src/db/types.ts`):
- `Client`, `Project`, `Communication`, `KnowledgeEntry` interfaces
- `ClientInsert`, `ProjectInsert`, `CommunicationInsert`, `KnowledgeEntryInsert` interfaces

**Scanner types** (`src/scanner/types.ts`):
- `ScannedClient`, `ScannedProject`, `ScannedCommunication`, `ScannedKnowledge` interfaces

### 3. Scanner Implementation

**Content Capture** (`src/scanner/index.ts`):
- Modified `scan()` method to capture content from `parseMarkdownFile()`
- Content (markdown body without frontmatter) is now included in all scanned entities
- Content is captured for:
  - Client README/AGENTS/CLAUDE files
  - Project README/AGENTS/CLAUDE files
  - Communication markdown files
  - Knowledge entry markdown files

**Index Method** (`src/scanner/index.ts`):
- Updated `index()` method to pass content to database insert operations
- Content flows from scanner → database → FTS5 indexes automatically via triggers

### 4. Database Queries

**Insert Queries** (`src/db/queries.ts`):
- Updated all `INSERT` statements to include content column:
  - `insertClient`
  - `insertProject`
  - `insertCommunication`
  - `insertKnowledgeEntry`

**Search Queries** (unchanged):
- Existing FTS5 search queries automatically include content field
- No changes needed to search functionality

## Usage

### Indexing Content

Content is automatically indexed when running:

```bash
lux index rebuild
```

After applying migration 003, run a full rebuild to populate content:

```bash
# Check migration status
lux migrate status

# Apply migration if needed
lux migrate up

# Rebuild index to populate content
lux index rebuild
```

### Searching Content

Content search works automatically with existing search commands:

```bash
# Search across all content
lux search "innovation strategy"

# Search within specific entity types
lux search "React components" --type project
lux search "sprint planning" --type knowledge

# Use FTS5 advanced features
lux search '"web development"'  # Phrase search
lux search "deliver*"            # Prefix search
lux search "Q1 AND milestone"   # Boolean operators
```

## Search Capabilities

With content indexing, you can now search for:

1. **Metadata + Content**: Traditional metadata fields plus full document content
2. **Deep Keywords**: Words and phrases anywhere in the document body
3. **Implementation Details**: Code snippets, technical details in documentation
4. **Discussion Context**: Full conversation history in communications
5. **Architecture Details**: Technical specifications in knowledge entries

## Performance

- **Index Size**: Increases based on content size (typically 2-5x larger)
- **Search Speed**: FTS5 maintains near-instant search even with content indexed
- **Disk Space**: Monitor database size if indexing large documents
- **Scan Time**: Minimal impact (content already read during frontmatter parsing)

## Migration Path

For existing installations:

1. **Before Migration**: Search only covers metadata fields
2. **After Migration**:
   - Content column exists but is NULL for old data
   - FTS5 tables include content field
3. **After Rebuild**: Full content search available

## Technical Details

### Content Storage

- Content is stored as TEXT in SQLite
- FTS5 tokenizes content for inverted index
- Original content preserved for potential future display
- No content truncation or summarization

### FTS5 Integration

- Content indexed alongside metadata in same FTS5 table
- Triggers automatically sync content changes to FTS5
- All FTS5 features work with content: ranking, highlights, snippets

### Content Source

Content comes from `gray-matter` parsing:
- `parsed.content` contains markdown body (without frontmatter)
- Frontmatter still stored separately in `metadata` JSON field
- Both searchable via FTS5

## Testing

The implementation includes comprehensive test coverage:

- Content insertion for all entity types
- FTS5 content search functionality
- Phrase search with content
- Prefix search with content
- Content storage verification

See test output in implementation logs for validation.

## Future Enhancements

Potential improvements for content indexing:

1. **Content Excerpts**: Return matched snippets in search results
2. **Highlight Matching**: Show context around matched terms
3. **Content Display**: CLI command to view full content
4. **Content Updates**: Track content changes over time
5. **Selective Indexing**: Option to exclude large files from content index
6. **Content Statistics**: Report on indexed content size

## Migration Details

**Migration File**: `src/db/migrations/003_add_content_to_fts5.sql`

**Key Operations**:
1. Drop existing FTS5 tables and triggers
2. Add content column to base tables
3. Recreate FTS5 tables with content field
4. Recreate triggers with content synchronization
5. Populate FTS5 tables (content NULL initially)

**Backwards Compatibility**:
- Existing data preserved
- Content populated on next scan
- Search works with NULL content (just searches other fields)

## Related Documentation

- [SEARCH.md](./SEARCH.md) - Full-text search usage guide
- [SEARCH-IMPLEMENTATION.md](./SEARCH-IMPLEMENTATION.md) - FTS5 implementation details
- [SCANNER-API.md](./SCANNER-API.md) - Scanner architecture
