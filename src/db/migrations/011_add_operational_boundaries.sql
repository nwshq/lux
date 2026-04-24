-- Operational boundary intelligence (Tranche 1).
-- Additive ontology tables for non-HTTP operational boundaries and their links.

CREATE TABLE IF NOT EXISTS operational_boundaries (
  id TEXT PRIMARY KEY,
  repo_root TEXT NOT NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  trust_tier INTEGER NOT NULL,
  file_path TEXT
);

CREATE INDEX IF NOT EXISTS idx_operational_boundaries_repo_root
  ON operational_boundaries(repo_root);
CREATE INDEX IF NOT EXISTS idx_operational_boundaries_kind
  ON operational_boundaries(kind);
CREATE INDEX IF NOT EXISTS idx_operational_boundaries_file_path
  ON operational_boundaries(file_path);

CREATE TABLE IF NOT EXISTS operational_handlers (
  id TEXT PRIMARY KEY,
  boundary_id TEXT NOT NULL,
  symbol_id TEXT NOT NULL,
  trust_tier INTEGER NOT NULL,
  FOREIGN KEY (boundary_id) REFERENCES operational_boundaries(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_operational_handlers_boundary_id
  ON operational_handlers(boundary_id);
CREATE INDEX IF NOT EXISTS idx_operational_handlers_symbol_id
  ON operational_handlers(symbol_id);

CREATE TABLE IF NOT EXISTS operational_edges (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  edge_type TEXT NOT NULL,
  transport TEXT,
  trust_tier INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_operational_edges_source_id
  ON operational_edges(source_id);
CREATE INDEX IF NOT EXISTS idx_operational_edges_target_id
  ON operational_edges(target_id);
CREATE INDEX IF NOT EXISTS idx_operational_edges_type
  ON operational_edges(edge_type);

CREATE TABLE IF NOT EXISTS operational_contracts (
  id TEXT PRIMARY KEY,
  boundary_id TEXT NOT NULL,
  payload_schema TEXT,
  trust_tier INTEGER NOT NULL,
  FOREIGN KEY (boundary_id) REFERENCES operational_boundaries(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_operational_contracts_boundary_id
  ON operational_contracts(boundary_id);
