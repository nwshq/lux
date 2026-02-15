-- Migration 003: Add content field to FTS5 tables
-- Adds full markdown content to FTS5 indexes for comprehensive full-text search

-- Drop existing FTS5 tables and triggers to recreate with content field
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

DROP TRIGGER IF EXISTS knowledge_entries_fts_insert;
DROP TRIGGER IF EXISTS knowledge_entries_fts_delete;
DROP TRIGGER IF EXISTS knowledge_entries_fts_update;
DROP TABLE IF EXISTS knowledge_entries_fts;

-- Add content column to base tables
ALTER TABLE clients ADD COLUMN content TEXT;
ALTER TABLE projects ADD COLUMN content TEXT;
ALTER TABLE communications ADD COLUMN content TEXT;
ALTER TABLE knowledge_entries ADD COLUMN content TEXT;

-- Recreate FTS5 virtual table for clients with content field
CREATE VIRTUAL TABLE clients_fts USING fts5(
    slug,
    name,
    type,
    status,
    metadata,
    content,
    content='clients',
    content_rowid='id'
);

-- Recreate triggers for clients
CREATE TRIGGER clients_fts_insert AFTER INSERT ON clients BEGIN
    INSERT INTO clients_fts(rowid, slug, name, type, status, metadata, content)
    VALUES (new.id, new.slug, new.name, new.type, new.status, new.metadata, new.content);
END;

CREATE TRIGGER clients_fts_delete AFTER DELETE ON clients BEGIN
    INSERT INTO clients_fts(clients_fts, rowid, slug, name, type, status, metadata, content)
    VALUES ('delete', old.id, old.slug, old.name, old.type, old.status, old.metadata, old.content);
END;

CREATE TRIGGER clients_fts_update AFTER UPDATE ON clients BEGIN
    INSERT INTO clients_fts(clients_fts, rowid, slug, name, type, status, metadata, content)
    VALUES ('delete', old.id, old.slug, old.name, old.type, old.status, old.metadata, old.content);
    INSERT INTO clients_fts(rowid, slug, name, type, status, metadata, content)
    VALUES (new.id, new.slug, new.name, new.type, new.status, new.metadata, new.content);
END;

-- Recreate FTS5 virtual table for projects with content field
CREATE VIRTUAL TABLE projects_fts USING fts5(
    slug,
    name,
    status,
    metadata,
    content,
    content='projects',
    content_rowid='id'
);

-- Recreate triggers for projects
CREATE TRIGGER projects_fts_insert AFTER INSERT ON projects BEGIN
    INSERT INTO projects_fts(rowid, slug, name, status, metadata, content)
    VALUES (new.id, new.slug, new.name, new.status, new.metadata, new.content);
END;

CREATE TRIGGER projects_fts_delete AFTER DELETE ON projects BEGIN
    INSERT INTO projects_fts(projects_fts, rowid, slug, name, status, metadata, content)
    VALUES ('delete', old.id, old.slug, old.name, old.status, old.metadata, old.content);
END;

CREATE TRIGGER projects_fts_update AFTER UPDATE ON projects BEGIN
    INSERT INTO projects_fts(projects_fts, rowid, slug, name, status, metadata, content)
    VALUES ('delete', old.id, old.slug, old.name, old.status, old.metadata, old.content);
    INSERT INTO projects_fts(rowid, slug, name, status, metadata, content)
    VALUES (new.id, new.slug, new.name, new.status, new.metadata, new.content);
END;

-- Recreate FTS5 virtual table for communications with content field
CREATE VIRTUAL TABLE communications_fts USING fts5(
    type,
    subject,
    date_range,
    participants,
    metadata,
    content,
    content='communications',
    content_rowid='id'
);

-- Recreate triggers for communications
CREATE TRIGGER communications_fts_insert AFTER INSERT ON communications BEGIN
    INSERT INTO communications_fts(rowid, type, subject, date_range, participants, metadata, content)
    VALUES (new.id, new.type, new.subject, new.date_range, new.participants, new.metadata, new.content);
END;

CREATE TRIGGER communications_fts_delete AFTER DELETE ON communications BEGIN
    INSERT INTO communications_fts(communications_fts, rowid, type, subject, date_range, participants, metadata, content)
    VALUES ('delete', old.id, old.type, old.subject, old.date_range, old.participants, old.metadata, old.content);
END;

CREATE TRIGGER communications_fts_update AFTER UPDATE ON communications BEGIN
    INSERT INTO communications_fts(communications_fts, rowid, type, subject, date_range, participants, metadata, content)
    VALUES ('delete', old.id, old.type, old.subject, old.date_range, old.participants, old.metadata, old.content);
    INSERT INTO communications_fts(rowid, type, subject, date_range, participants, metadata, content)
    VALUES (new.id, new.type, new.subject, new.date_range, new.participants, new.metadata, new.content);
END;

-- Recreate FTS5 virtual table for knowledge entries with content field
CREATE VIRTUAL TABLE knowledge_entries_fts USING fts5(
    type,
    title,
    tags,
    metadata,
    content,
    content='knowledge_entries',
    content_rowid='id'
);

-- Recreate triggers for knowledge entries
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

-- Populate FTS5 tables with existing data (content will be NULL initially, filled on next scan)
INSERT INTO clients_fts(rowid, slug, name, type, status, metadata, content)
SELECT id, slug, name, type, status, metadata, content FROM clients;

INSERT INTO projects_fts(rowid, slug, name, status, metadata, content)
SELECT id, slug, name, status, metadata, content FROM projects;

INSERT INTO communications_fts(rowid, type, subject, date_range, participants, metadata, content)
SELECT id, type, subject, date_range, participants, metadata, content FROM communications;

INSERT INTO knowledge_entries_fts(rowid, type, title, tags, metadata, content)
SELECT id, type, title, tags, metadata, content FROM knowledge_entries;
