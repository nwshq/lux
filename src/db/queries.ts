import type Database from 'better-sqlite3';

/**
 * Prepared statements for the Lux Knowledge Platform database.
 * These statements are initialized once and reused for better performance.
 */
export class PreparedQueries {
  // Knowledge entry queries
  readonly insertKnowledgeEntry: Database.Statement;
  readonly getKnowledgeEntriesByType: Database.Statement;
  readonly getAllKnowledgeEntries: Database.Statement;
  readonly getKnowledgeEntryByPath: Database.Statement;
  readonly deleteKnowledgeEntry: Database.Statement;

  // Event queries
  readonly insertEvent: Database.Statement;
  readonly getRecentEvents: Database.Statement;

  // Stats queries
  readonly countKnowledgeEntries: Database.Statement;
  readonly countEvents: Database.Statement;

  // Clear queries
  readonly clearEvents: Database.Statement;
  readonly clearKnowledgeEntries: Database.Statement;

  // FTS5 search queries
  readonly searchKnowledgeEntriesFts: Database.Statement;

  // FTS5 content-only search queries
  readonly searchKnowledgeEntriesContentFts: Database.Statement;

  // Expert queries
  readonly insertExpert: Database.Statement;
  readonly getExpert: Database.Statement;
  readonly getAllExperts: Database.Statement;
  readonly getExpertsByStatus: Database.Statement;
  readonly updateExpert: Database.Statement;
  readonly deleteExpert: Database.Statement;
  readonly countExperts: Database.Statement;
  readonly clearExperts: Database.Statement;

  // Expert session queries
  readonly insertExpertSession: Database.Statement;
  readonly getExpertSession: Database.Statement;
  readonly getSessionsByExpert: Database.Statement;
  readonly getSessionsByStatus: Database.Statement;
  readonly getActiveSessionForExpert: Database.Statement;
  readonly updateSessionLastActive: Database.Statement;
  readonly updateSessionStatus: Database.Statement;
  readonly deleteExpertSession: Database.Statement;
  readonly deleteSessionsByExpert: Database.Statement;
  readonly clearExpertSessions: Database.Statement;

  constructor(db: Database.Database) {
    // Knowledge entry queries
    this.insertKnowledgeEntry = db.prepare(`
      INSERT INTO knowledge_entries (type, title, file_path, tags, metadata, content)
      VALUES (@type, @title, @file_path, @tags, @metadata, @content)
    `);

    this.getKnowledgeEntriesByType = db.prepare(`
      SELECT * FROM knowledge_entries WHERE type = ?
    `);

    this.getAllKnowledgeEntries = db.prepare(`
      SELECT * FROM knowledge_entries
    `);

    this.getKnowledgeEntryByPath = db.prepare(`
      SELECT * FROM knowledge_entries WHERE file_path = ?
    `);

    this.deleteKnowledgeEntry = db.prepare(`
      DELETE FROM knowledge_entries WHERE id = ?
    `);

    // Event queries
    this.insertEvent = db.prepare(`
      INSERT INTO events (source, source_id, event_type, summary, payload)
      VALUES (@source, @source_id, @event_type, @summary, @payload)
    `);

    this.getRecentEvents = db.prepare(`
      SELECT * FROM events ORDER BY timestamp DESC LIMIT ?
    `);

    // Stats queries
    this.countKnowledgeEntries = db.prepare(`
      SELECT COUNT(*) as count FROM knowledge_entries
    `);

    this.countEvents = db.prepare(`
      SELECT COUNT(*) as count FROM events
    `);

    // Clear queries (used by clearAll)
    this.clearEvents = db.prepare(`DELETE FROM events`);
    this.clearKnowledgeEntries = db.prepare(`DELETE FROM knowledge_entries`);

    // FTS5 search queries
    // Search knowledge entries using FTS5 - returns full knowledge entry records
    this.searchKnowledgeEntriesFts = db.prepare(`
      SELECT k.* FROM knowledge_entries k
      JOIN knowledge_entries_fts ON k.id = knowledge_entries_fts.rowid
      WHERE knowledge_entries_fts MATCH ?
      ORDER BY rank
    `);

    // Content-only search queries - search only the content field
    this.searchKnowledgeEntriesContentFts = db.prepare(`
      SELECT k.* FROM knowledge_entries k
      JOIN knowledge_entries_fts ON k.id = knowledge_entries_fts.rowid
      WHERE knowledge_entries_fts MATCH 'content:' || ?
      ORDER BY rank
    `);

    // Expert queries
    this.insertExpert = db.prepare(`
      INSERT INTO experts (slug, name, mount_path, model, claude_md_path, memory_path, status)
      VALUES (@slug, @name, @mount_path, @model, @claude_md_path, @memory_path, @status)
    `);

    this.getExpert = db.prepare(`
      SELECT * FROM experts WHERE slug = ?
    `);

    this.getAllExperts = db.prepare(`
      SELECT * FROM experts ORDER BY name
    `);

    this.getExpertsByStatus = db.prepare(`
      SELECT * FROM experts WHERE status = ? ORDER BY name
    `);

    this.updateExpert = db.prepare(`
      UPDATE experts SET
        name = COALESCE(@name, name),
        mount_path = COALESCE(@mount_path, mount_path),
        model = COALESCE(@model, model),
        claude_md_path = COALESCE(@claude_md_path, claude_md_path),
        memory_path = COALESCE(@memory_path, memory_path),
        status = COALESCE(@status, status),
        updated_at = unixepoch()
      WHERE slug = @slug
    `);

    this.deleteExpert = db.prepare(`
      DELETE FROM experts WHERE slug = ?
    `);

    this.countExperts = db.prepare(`
      SELECT COUNT(*) as count FROM experts
    `);

    this.clearExperts = db.prepare(`DELETE FROM experts`);

    // Expert session queries
    this.insertExpertSession = db.prepare(`
      INSERT INTO expert_sessions (expert_id, session_ref, status)
      VALUES (@expert_id, @session_ref, @status)
    `);

    this.getExpertSession = db.prepare(`
      SELECT * FROM expert_sessions WHERE id = ?
    `);

    this.getSessionsByExpert = db.prepare(`
      SELECT * FROM expert_sessions WHERE expert_id = ? ORDER BY last_active_at DESC
    `);

    this.getSessionsByStatus = db.prepare(`
      SELECT es.*, e.slug as expert_slug, e.name as expert_name
      FROM expert_sessions es
      JOIN experts e ON es.expert_id = e.id
      WHERE es.status = ?
      ORDER BY es.last_active_at DESC
    `);

    this.getActiveSessionForExpert = db.prepare(`
      SELECT * FROM expert_sessions
      WHERE expert_id = ? AND status = 'warm'
      ORDER BY last_active_at DESC
      LIMIT 1
    `);

    this.updateSessionLastActive = db.prepare(`
      UPDATE expert_sessions SET last_active_at = unixepoch() WHERE id = ?
    `);

    this.updateSessionStatus = db.prepare(`
      UPDATE expert_sessions SET status = @status, last_active_at = unixepoch() WHERE id = @id
    `);

    this.deleteExpertSession = db.prepare(`
      DELETE FROM expert_sessions WHERE id = ?
    `);

    this.deleteSessionsByExpert = db.prepare(`
      DELETE FROM expert_sessions WHERE expert_id = ?
    `);

    this.clearExpertSessions = db.prepare(`DELETE FROM expert_sessions`);
  }
}
