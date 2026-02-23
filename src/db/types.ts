// Database entity types

export interface Client {
  id: number;
  slug: string;
  name: string;
  type?: string;
  status?: string;
  file_path: string;
  metadata?: string; // JSON string
  content?: string; // Markdown content
  created_at: number;
  updated_at: number;
}

export interface Project {
  id: number;
  client_id: number;
  slug: string;
  name: string;
  status?: string;
  file_path: string;
  metadata?: string; // JSON string
  content?: string; // Markdown content
  created_at: number;
  updated_at: number;
}

export interface Communication {
  id: number;
  client_id: number;
  project_id?: number;
  type: string;
  subject?: string;
  date_range?: string;
  participants?: string; // JSON array
  file_path: string;
  metadata?: string; // JSON string
  content?: string; // Markdown content
  created_at: number;
  updated_at: number;
}

export interface KnowledgeEntry {
  id: number;
  client_id?: number;
  project_id?: number;
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
  client_id?: number;
  project_id?: number;
  event_type: string;
  summary?: string;
  payload?: string; // JSON string
}

// Input types for insertions (without auto-generated fields)
export interface ClientInsert {
  slug: string;
  name: string;
  type?: string;
  status?: string;
  file_path: string;
  metadata?: Record<string, unknown>;
  content?: string;
}

export interface ProjectInsert {
  client_id: number;
  slug: string;
  name: string;
  status?: string;
  file_path: string;
  metadata?: Record<string, unknown>;
  content?: string;
}

export interface CommunicationInsert {
  client_id: number;
  project_id?: number;
  type: string;
  subject?: string;
  date_range?: string;
  participants?: string[];
  file_path: string;
  metadata?: Record<string, unknown>;
  content?: string;
}

export interface KnowledgeEntryInsert {
  client_id?: number;
  project_id?: number;
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
  client_id?: number;
  project_id?: number;
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

/** Unified search result from querying across all FTS5 tables. */
export interface DocumentSearchResult {
  file_path: string;
  title: string;
  content?: string;
  rank: number;
}
