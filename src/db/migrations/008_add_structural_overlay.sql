-- Structural overlay: cross-language association nodes, edges, and evidence.
-- These tables hold Lux-owned relational truth on top of language-local semantics.

CREATE TABLE IF NOT EXISTS structural_nodes (
  id TEXT PRIMARY KEY,
  node_type TEXT NOT NULL,
  file_path TEXT,
  language_id TEXT,
  symbol_name TEXT,
  symbol_kind TEXT,
  qualified_name TEXT,
  metadata TEXT,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_structural_nodes_type ON structural_nodes(node_type);
CREATE INDEX IF NOT EXISTS idx_structural_nodes_file_path ON structural_nodes(file_path);
CREATE INDEX IF NOT EXISTS idx_structural_nodes_language_id ON structural_nodes(language_id);

CREATE TABLE IF NOT EXISTS structural_edges (
  id TEXT PRIMARY KEY,
  source_node_id TEXT NOT NULL,
  target_node_id TEXT NOT NULL,
  edge_type TEXT NOT NULL,
  confidence REAL NOT NULL,
  confidence_class TEXT NOT NULL,
  freshness_status TEXT NOT NULL DEFAULT 'unknown',
  source_commit TEXT,
  dirty_dependency_count INTEGER NOT NULL DEFAULT 0,
  provenance_summary TEXT,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_structural_edges_source ON structural_edges(source_node_id);
CREATE INDEX IF NOT EXISTS idx_structural_edges_target ON structural_edges(target_node_id);
CREATE INDEX IF NOT EXISTS idx_structural_edges_type ON structural_edges(edge_type);
CREATE INDEX IF NOT EXISTS idx_structural_edges_confidence_class ON structural_edges(confidence_class);
CREATE INDEX IF NOT EXISTS idx_structural_edges_freshness ON structural_edges(freshness_status);

CREATE TABLE IF NOT EXISTS edge_evidence (
  id TEXT PRIMARY KEY,
  edge_id TEXT NOT NULL,
  resolver TEXT NOT NULL,
  evidence_kind TEXT NOT NULL,
  file_path TEXT,
  line INTEGER,
  note TEXT,
  payload_json TEXT,
  recorded_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_edge_evidence_edge_id ON edge_evidence(edge_id);
CREATE INDEX IF NOT EXISTS idx_edge_evidence_resolver ON edge_evidence(resolver);
CREATE INDEX IF NOT EXISTS idx_edge_evidence_file_path ON edge_evidence(file_path);
