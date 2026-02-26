-- Migration 005: Drop unused entity tables (clients, projects, communications)
-- These tables were part of the original schema but are never populated.
-- Also removes orphaned client_id/project_id FK columns from knowledge_entries and events.

-- 1. Drop FTS5 triggers and virtual tables for clients, projects, communications
DROP TRIGGER IF EXISTS clients_fts_insert;
DROP TRIGGER IF EXISTS clients_fts_delete;
DROP TRIGGER IF EXISTS clients_fts_update;
DROP TABLE IF EXISTS clients_fts;

DROP TRIGGER IF EXISTS projects_fts_insert;
DROP TRIGGER IF EXISTS projects_fts_delete;
DROP TRIGGER IF EXISTS projects_fts_update;
DROP TABLE IF EXISTS projects_fts;

DROP TRIGGER IF EXISTS communications_fts_insert;
DROP TRIGGER IF EXISTS communications_fts_delete;
DROP TRIGGER IF EXISTS communications_fts_update;
DROP TABLE IF EXISTS communications_fts;

-- 2. Drop entity tables (order matters for FK constraints)
DROP TABLE IF EXISTS communications;
DROP TABLE IF EXISTS projects;
DROP TABLE IF EXISTS clients;

-- 3. Recreate knowledge_entries without client_id/project_id columns
--    SQLite cannot DROP COLUMN when FK constraints are involved, so we recreate.

-- Drop existing knowledge_entries FTS triggers and table first
DROP TRIGGER IF EXISTS knowledge_entries_fts_insert;
DROP TRIGGER IF EXISTS knowledge_entries_fts_delete;
DROP TRIGGER IF EXISTS knowledge_entries_fts_update;
DROP TABLE IF EXISTS knowledge_entries_fts;

CREATE TABLE knowledge_entries_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    file_path TEXT NOT NULL UNIQUE,
    tags TEXT,
    metadata TEXT,
    content TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

INSERT INTO knowledge_entries_new (id, type, title, file_path, tags, metadata, content, created_at, updated_at)
SELECT id, type, title, file_path, tags, metadata, content, created_at, updated_at
FROM knowledge_entries;

DROP TABLE knowledge_entries;
ALTER TABLE knowledge_entries_new RENAME TO knowledge_entries;

-- Recreate indexes for knowledge_entries
CREATE INDEX idx_knowledge_type ON knowledge_entries(type);
CREATE INDEX idx_knowledge_path ON knowledge_entries(file_path);

-- Recreate FTS5 table and triggers for knowledge_entries
CREATE VIRTUAL TABLE knowledge_entries_fts USING fts5(
    type,
    title,
    tags,
    metadata,
    content,
    content='knowledge_entries',
    content_rowid='id'
);

CREATE TRIGGER knowledge_entries_fts_insert AFTER INSERT ON knowledge_entries BEGIN
    INSERT INTO knowledge_entries_fts(rowid, type, title, tags, metadata, content)
    VALUES (new.id, new.type, new.title, new.tags, new.metadata, new.content);
END;

CREATE TRIGGER knowledge_entries_fts_delete AFTER DELETE ON knowledge_entries BEGIN
    INSERT INTO knowledge_entries_fts(knowledge_entries_fts, rowid, type, title, tags, metadata, content)
    VALUES ('delete', old.id, old.type, old.title, old.tags, old.metadata, old.content);
END;

CREATE TRIGGER knowledge_entries_fts_update AFTER UPDATE ON knowledge_entries BEGIN
    INSERT INTO knowledge_entries_fts(knowledge_entries_fts, rowid, type, title, tags, metadata, content)
    VALUES ('delete', old.id, old.type, old.title, old.tags, old.metadata, old.content);
    INSERT INTO knowledge_entries_fts(rowid, type, title, tags, metadata, content)
    VALUES (new.id, new.type, new.title, new.tags, new.metadata, new.content);
END;

-- Populate FTS5 from existing data
INSERT INTO knowledge_entries_fts(rowid, type, title, tags, metadata, content)
SELECT id, type, title, tags, metadata, content FROM knowledge_entries;

-- 4. Recreate events without client_id/project_id columns

CREATE TABLE events_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp INTEGER NOT NULL DEFAULT (unixepoch()),
    source TEXT NOT NULL,
    source_id TEXT,
    event_type TEXT NOT NULL,
    summary TEXT,
    payload TEXT
);

INSERT INTO events_new (id, timestamp, source, source_id, event_type, summary, payload)
SELECT id, timestamp, source, source_id, event_type, summary, payload
FROM events;

DROP TABLE events;
ALTER TABLE events_new RENAME TO events;

-- Recreate indexes for events
CREATE INDEX idx_events_timestamp ON events(timestamp);
CREATE INDEX idx_events_type ON events(event_type);
