# Database Migrations

This directory contains database schema migrations for the Lux Knowledge Platform.

## Overview

The migration system uses a simple version-based approach where each migration file represents a schema change. Migrations are applied sequentially and tracked in the `schema_version` table.

## File Naming Convention

Migration files must follow this naming pattern:

```
XXX_description.sql
```

Where:
- `XXX` is a zero-padded 3-digit version number (e.g., `001`, `002`, `003`)
- `description` is a brief snake_case description of the migration
- File extension must be `.sql`

Examples:
- `001_initial_schema.sql`
- `002_add_tags_table.sql`
- `003_add_user_preferences.sql`

## Creating a Migration

1. Check the current schema version:
   ```bash
   lux migrate status
   ```

2. Create a new migration file with the next version number:
   ```bash
   # If current version is 1, create 002_*.sql
   # If current version is 2, create 003_*.sql
   ```

3. Write your SQL migration:
   ```sql
   -- Migration XXX: Brief description
   -- Longer explanation of what this migration does

   -- Your SQL statements here
   CREATE TABLE ...;
   ALTER TABLE ...;
   CREATE INDEX ...;
   ```

4. Rebuild the project to copy the migration to the dist folder:
   ```bash
   npm run build
   ```

5. Apply the migration:
   ```bash
   lux migrate up
   ```

## Migration Commands

### Check Migration Status
```bash
lux migrate status
```

Shows:
- Current database version
- Latest available migration version
- List of applied migrations
- List of pending migrations

### Apply Pending Migrations
```bash
lux migrate up
```

Applies all pending migrations in order.

### Create Migration Template
```bash
lux migrate create <name>
```

Displays instructions for creating a new migration file.

## Auto-Migration

By default, the `LuxDatabase` class automatically runs pending migrations when initialized. This ensures the database schema is always up to date.

To disable auto-migration (useful for migration commands):
```typescript
const db = new LuxDatabase(dbPath, false); // false disables auto-migration
```

## Migration Guidelines

### DO:
- Use `IF NOT EXISTS` for `CREATE TABLE` statements
- Use `IF EXISTS` for `DROP TABLE` statements
- Keep migrations small and focused on a single change
- Test migrations on a backup database first
- Include comments explaining the purpose of the migration

### DON'T:
- Don't modify existing migration files after they've been applied
- Don't skip version numbers
- Don't include data migrations in schema migrations (separate them if needed)
- Don't use database-specific features unless necessary

## Migration Workflow

1. **Development**: Create and test migrations locally
2. **Testing**: Verify migrations work on a test database
3. **Deployment**: Migrations run automatically on application start
4. **Rollback**: If needed, create a new migration to reverse changes (no down migrations)

## Schema Version Table

The `schema_version` table tracks applied migrations:

```sql
CREATE TABLE schema_version (
    version INTEGER PRIMARY KEY,
    applied_at INTEGER NOT NULL DEFAULT (unixepoch())
);
```

Each row represents an applied migration with:
- `version`: Migration version number
- `applied_at`: Unix timestamp when migration was applied

## Troubleshooting

### Migration fails with "no such table" error
- Ensure migrations are applied in order
- Check that previous migrations completed successfully
- Verify the database file is not corrupted

### Migration shows as pending but file doesn't exist
- Run `npm run build` to copy migrations to dist folder
- Check that the migration file exists in `src/db/migrations/`

### Database is at wrong version
- Run `lux migrate status` to see actual vs expected version
- Check the `schema_version` table directly: `SELECT * FROM schema_version;`
- Verify all migration files are present in the correct order
