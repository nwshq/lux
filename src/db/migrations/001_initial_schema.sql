-- Migration 001: Initial Schema
-- Creates all base tables for the Lux Knowledge Platform

-- Clients table
CREATE TABLE IF NOT EXISTS clients (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    type TEXT,
    status TEXT,
    file_path TEXT NOT NULL,
    metadata TEXT, -- JSON blob for additional frontmatter data
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_clients_slug ON clients(slug);
CREATE INDEX IF NOT EXISTS idx_clients_status ON clients(status);

-- Projects table
CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id INTEGER NOT NULL,
    slug TEXT NOT NULL,
    name TEXT NOT NULL,
    status TEXT,
    file_path TEXT NOT NULL,
    metadata TEXT, -- JSON blob
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
    FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE,
    UNIQUE(client_id, slug)
);

CREATE INDEX IF NOT EXISTS idx_projects_client ON projects(client_id);
CREATE INDEX IF NOT EXISTS idx_projects_slug ON projects(slug);
CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status);

-- Communications table
CREATE TABLE IF NOT EXISTS communications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id INTEGER NOT NULL,
    project_id INTEGER, -- nullable, not all communications are project-specific
    type TEXT NOT NULL, -- email, slack, meeting, call, etc.
    subject TEXT,
    date_range TEXT, -- ISO date or date range
    participants TEXT, -- JSON array
    file_path TEXT NOT NULL,
    metadata TEXT, -- JSON blob
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
    FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_communications_client ON communications(client_id);
CREATE INDEX IF NOT EXISTS idx_communications_project ON communications(project_id);
CREATE INDEX IF NOT EXISTS idx_communications_type ON communications(type);
CREATE INDEX IF NOT EXISTS idx_communications_date ON communications(date_range);

-- Knowledge entries table
CREATE TABLE IF NOT EXISTS knowledge_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id INTEGER, -- nullable, some knowledge is general
    project_id INTEGER, -- nullable
    type TEXT NOT NULL, -- methodology, spec, exploration, etc.
    title TEXT NOT NULL,
    file_path TEXT NOT NULL UNIQUE,
    tags TEXT, -- JSON array
    metadata TEXT, -- JSON blob
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
    FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE SET NULL,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_knowledge_type ON knowledge_entries(type);
CREATE INDEX IF NOT EXISTS idx_knowledge_client ON knowledge_entries(client_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_project ON knowledge_entries(project_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_path ON knowledge_entries(file_path);

-- Events table (audit log)
CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp INTEGER NOT NULL DEFAULT (unixepoch()),
    source TEXT NOT NULL, -- 'scanner', 'cli', 'mcp', etc.
    source_id TEXT, -- optional identifier from source
    client_id INTEGER,
    project_id INTEGER,
    event_type TEXT NOT NULL, -- 'index_rebuild', 'comm_logged', 'search', etc.
    summary TEXT,
    payload TEXT, -- JSON blob
    FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE SET NULL,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(event_type);
CREATE INDEX IF NOT EXISTS idx_events_client ON events(client_id);
CREATE INDEX IF NOT EXISTS idx_events_project ON events(project_id);
