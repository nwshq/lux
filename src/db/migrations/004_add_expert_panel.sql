-- Migration 004: Add Expert Panel
-- Creates tables for expert registry and session tracking

-- Experts table
CREATE TABLE IF NOT EXISTS experts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    mount_path TEXT NOT NULL,         -- relative to CORPUS root
    model TEXT NOT NULL DEFAULT 'claude-sonnet-4-20250514',
    claude_md_path TEXT,              -- path to expert's claude.md
    memory_path TEXT,                 -- path to expert's memory.md
    status TEXT NOT NULL DEFAULT 'active',
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_experts_slug ON experts(slug);
CREATE INDEX IF NOT EXISTS idx_experts_status ON experts(status);

-- Expert sessions table
CREATE TABLE IF NOT EXISTS expert_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    expert_id INTEGER NOT NULL,
    session_ref TEXT NOT NULL,        -- external session identifier
    spawned_at INTEGER NOT NULL DEFAULT (unixepoch()),
    last_active_at INTEGER NOT NULL DEFAULT (unixepoch()),
    status TEXT NOT NULL DEFAULT 'warm',
    FOREIGN KEY (expert_id) REFERENCES experts(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_expert_sessions_expert ON expert_sessions(expert_id);
CREATE INDEX IF NOT EXISTS idx_expert_sessions_status ON expert_sessions(status);
