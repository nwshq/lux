// Database entity types

export interface KnowledgeEntry {
  id: number;
  type: string;
  title: string;
  file_path: string;
  tags?: string; // JSON array
  metadata?: string; // JSON string
  content?: string; // Markdown content
  created_at: number;
  updated_at: number;
}

export interface Event {
  id: number;
  timestamp: number;
  source: string;
  source_id?: string;
  event_type: string;
  summary?: string;
  payload?: string; // JSON string
}

// Input types for insertions (without auto-generated fields)
export interface KnowledgeEntryInsert {
  type: string;
  title: string;
  file_path: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
  content?: string;
}

export interface EventInsert {
  source: string;
  source_id?: string;
  event_type: string;
  summary?: string;
  payload?: Record<string, unknown>;
}

export interface Expert {
  id: number;
  slug: string;
  name: string;
  mount_path: string;
  model: string;
  claude_md_path?: string;
  memory_path?: string;
  status: string;
  created_at: number;
  updated_at: number;
}

export interface ExpertInsert {
  slug: string;
  name: string;
  mount_path: string;
  model?: string;
  claude_md_path?: string;
  memory_path?: string;
  status?: string;
}

export interface ExpertSession {
  id: number;
  expert_id: number;
  session_ref: string;
  spawned_at: number;
  last_active_at: number;
  status: string;
}

export interface ExpertSessionInsert {
  expert_id: number;
  session_ref: string;
  status?: string;
}

/** Index metadata key-value pair for tracking index state. */
export interface IndexMetadata {
  key: string;
  value: string;
  updated_at: number;
}

export interface ModuleDependency {
  id: number;
  source_module: string;
  target_module: string;
  reference_count: number;
  sample_files: string | null;
  created_at: number;
}

/** Unified search result from querying across all FTS5 tables. */
export interface DocumentSearchResult {
  file_path: string;
  title: string;
  content?: string;
  rank: number;
}
