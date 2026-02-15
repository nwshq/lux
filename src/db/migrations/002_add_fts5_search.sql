-- Migration 002: Add FTS5 Full-Text Search
-- Creates FTS5 virtual tables for fast full-text search across all entities

-- FTS5 virtual table for clients
-- Indexes: slug, name, type, status, and metadata JSON
CREATE VIRTUAL TABLE IF NOT EXISTS clients_fts USING fts5(
    slug,
    name,
    type,
    status,
    metadata,
    content='clients',
    content_rowid='id'
);

-- Triggers to keep clients_fts in sync with clients table
CREATE TRIGGER IF NOT EXISTS clients_fts_insert AFTER INSERT ON clients BEGIN
    INSERT INTO clients_fts(rowid, slug, name, type, status, metadata)
    VALUES (new.id, new.slug, new.name, new.type, new.status, new.metadata);
END;

CREATE TRIGGER IF NOT EXISTS clients_fts_delete AFTER DELETE ON clients BEGIN
    INSERT INTO clients_fts(clients_fts, rowid, slug, name, type, status, metadata)
    VALUES ('delete', old.id, old.slug, old.name, old.type, old.status, old.metadata);
END;

CREATE TRIGGER IF NOT EXISTS clients_fts_update AFTER UPDATE ON clients BEGIN
    INSERT INTO clients_fts(clients_fts, rowid, slug, name, type, status, metadata)
    VALUES ('delete', old.id, old.slug, old.name, old.type, old.status, old.metadata);
    INSERT INTO clients_fts(rowid, slug, name, type, status, metadata)
    VALUES (new.id, new.slug, new.name, new.type, new.status, new.metadata);
END;

-- FTS5 virtual table for projects
CREATE VIRTUAL TABLE IF NOT EXISTS projects_fts USING fts5(
    slug,
    name,
    status,
    metadata,
    content='projects',
    content_rowid='id'
);

-- Triggers to keep projects_fts in sync with projects table
CREATE TRIGGER IF NOT EXISTS projects_fts_insert AFTER INSERT ON projects BEGIN
    INSERT INTO projects_fts(rowid, slug, name, status, metadata)
    VALUES (new.id, new.slug, new.name, new.status, new.metadata);
END;

CREATE TRIGGER IF NOT EXISTS projects_fts_delete AFTER DELETE ON projects BEGIN
    INSERT INTO projects_fts(projects_fts, rowid, slug, name, status, metadata)
    VALUES ('delete', old.id, old.slug, old.name, old.status, old.metadata);
END;

CREATE TRIGGER IF NOT EXISTS projects_fts_update AFTER UPDATE ON projects BEGIN
    INSERT INTO projects_fts(projects_fts, rowid, slug, name, status, metadata)
    VALUES ('delete', old.id, old.slug, old.name, old.status, old.metadata);
    INSERT INTO projects_fts(rowid, slug, name, status, metadata)
    VALUES (new.id, new.slug, new.name, new.status, new.metadata);
END;

-- FTS5 virtual table for communications
CREATE VIRTUAL TABLE IF NOT EXISTS communications_fts USING fts5(
    type,
    subject,
    date_range,
    participants,
    metadata,
    content='communications',
    content_rowid='id'
);

-- Triggers to keep communications_fts in sync with communications table
CREATE TRIGGER IF NOT EXISTS communications_fts_insert AFTER INSERT ON communications BEGIN
    INSERT INTO communications_fts(rowid, type, subject, date_range, participants, metadata)
    VALUES (new.id, new.type, new.subject, new.date_range, new.participants, new.metadata);
END;

CREATE TRIGGER IF NOT EXISTS communications_fts_delete AFTER DELETE ON communications BEGIN
    INSERT INTO communications_fts(communications_fts, rowid, type, subject, date_range, participants, metadata)
    VALUES ('delete', old.id, old.type, old.subject, old.date_range, old.participants, old.metadata);
END;

CREATE TRIGGER IF NOT EXISTS communications_fts_update AFTER UPDATE ON communications BEGIN
    INSERT INTO communications_fts(communications_fts, rowid, type, subject, date_range, participants, metadata)
    VALUES ('delete', old.id, old.type, old.subject, old.date_range, old.participants, old.metadata);
    INSERT INTO communications_fts(rowid, type, subject, date_range, participants, metadata)
    VALUES (new.id, new.type, new.subject, new.date_range, new.participants, new.metadata);
END;

-- FTS5 virtual table for knowledge entries
CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_entries_fts USING fts5(
    type,
    title,
    tags,
    metadata,
    content='knowledge_entries',
    content_rowid='id'
);

-- Triggers to keep knowledge_entries_fts in sync with knowledge_entries table
CREATE TRIGGER IF NOT EXISTS knowledge_entries_fts_insert AFTER INSERT ON knowledge_entries BEGIN
    INSERT INTO knowledge_entries_fts(rowid, type, title, tags, metadata)
    VALUES (new.id, new.type, new.title, new.tags, new.metadata);
END;

CREATE TRIGGER IF NOT EXISTS knowledge_entries_fts_delete AFTER DELETE ON knowledge_entries BEGIN
    INSERT INTO knowledge_entries_fts(knowledge_entries_fts, rowid, type, title, tags, metadata)
    VALUES ('delete', old.id, old.type, old.title, old.tags, old.metadata);
END;

CREATE TRIGGER IF NOT EXISTS knowledge_entries_fts_update AFTER UPDATE ON knowledge_entries BEGIN
    INSERT INTO knowledge_entries_fts(knowledge_entries_fts, rowid, type, title, tags, metadata)
    VALUES ('delete', old.id, old.type, old.title, old.tags, old.metadata);
    INSERT INTO knowledge_entries_fts(rowid, type, title, tags, metadata)
    VALUES (new.id, new.type, new.title, new.tags, new.metadata);
END;

-- Populate FTS5 tables with existing data
INSERT INTO clients_fts(rowid, slug, name, type, status, metadata)
SELECT id, slug, name, type, status, metadata FROM clients;

INSERT INTO projects_fts(rowid, slug, name, status, metadata)
SELECT id, slug, name, status, metadata FROM projects;

INSERT INTO communications_fts(rowid, type, subject, date_range, participants, metadata)
SELECT id, type, subject, date_range, participants, metadata FROM communications;

INSERT INTO knowledge_entries_fts(rowid, type, title, tags, metadata)
SELECT id, type, title, tags, metadata FROM knowledge_entries;
