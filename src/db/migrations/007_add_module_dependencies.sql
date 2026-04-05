CREATE TABLE IF NOT EXISTS module_dependencies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_module TEXT NOT NULL,
    target_module TEXT NOT NULL,
    reference_count INTEGER NOT NULL DEFAULT 0,
    sample_files TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    UNIQUE(source_module, target_module)
);

CREATE INDEX IF NOT EXISTS idx_moddeps_source ON module_dependencies(source_module);
CREATE INDEX IF NOT EXISTS idx_moddeps_target ON module_dependencies(target_module);
