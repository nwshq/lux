import type Database from 'better-sqlite3';

/**
 * Prepared statements for the Lux Knowledge Platform database.
 * These statements are initialized once and reused for better performance.
 */
export class PreparedQueries {
  // Client queries
  readonly insertClient: Database.Statement;
  readonly getClient: Database.Statement;
  readonly getAllClients: Database.Statement;
  readonly deleteClient: Database.Statement;

  // Project queries
  readonly insertProject: Database.Statement;
  readonly getProject: Database.Statement;
  readonly getProjectBySlug: Database.Statement;
  readonly getProjectsByClient: Database.Statement;
  readonly deleteProject: Database.Statement;

  // Communication queries
  readonly insertCommunication: Database.Statement;
  readonly getCommunicationsByClient: Database.Statement;
  readonly getCommunicationsByProject: Database.Statement;
  readonly deleteCommunication: Database.Statement;

  // Knowledge entry queries
  readonly insertKnowledgeEntry: Database.Statement;
  readonly getKnowledgeEntriesByType: Database.Statement;
  readonly getAllKnowledgeEntries: Database.Statement;
  readonly getKnowledgeEntryByPath: Database.Statement;
  readonly getKnowledgeEntriesByClient: Database.Statement;
  readonly getKnowledgeEntriesByProject: Database.Statement;
  readonly deleteKnowledgeEntry: Database.Statement;

  // Event queries
  readonly insertEvent: Database.Statement;
  readonly getRecentEvents: Database.Statement;
  readonly getEventsByClient: Database.Statement;
  readonly getEventsByProject: Database.Statement;

  // Stats queries
  readonly countClients: Database.Statement;
  readonly countProjects: Database.Statement;
  readonly countCommunications: Database.Statement;
  readonly countKnowledgeEntries: Database.Statement;
  readonly countEvents: Database.Statement;

  // Clear queries
  readonly clearEvents: Database.Statement;
  readonly clearKnowledgeEntries: Database.Statement;
  readonly clearCommunications: Database.Statement;
  readonly clearProjects: Database.Statement;
  readonly clearClients: Database.Statement;

  // FTS5 search queries
  readonly searchClientsFts: Database.Statement;
  readonly searchProjectsFts: Database.Statement;
  readonly searchCommunicationsFts: Database.Statement;
  readonly searchKnowledgeEntriesFts: Database.Statement;

  // FTS5 content-only search queries
  readonly searchClientsContentFts: Database.Statement;
  readonly searchProjectsContentFts: Database.Statement;
  readonly searchCommunicationsContentFts: Database.Statement;
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
    // Client queries
    this.insertClient = db.prepare(`
      INSERT INTO clients (slug, name, type, status, file_path, metadata, content)
      VALUES (@slug, @name, @type, @status, @file_path, @metadata, @content)
    `);

    this.getClient = db.prepare(`
      SELECT * FROM clients WHERE slug = ?
    `);

    this.getAllClients = db.prepare(`
      SELECT * FROM clients ORDER BY name
    `);

    this.deleteClient = db.prepare(`
      DELETE FROM clients WHERE slug = ?
    `);

    // Project queries
    this.insertProject = db.prepare(`
      INSERT INTO projects (client_id, slug, name, status, file_path, metadata, content)
      VALUES (@client_id, @slug, @name, @status, @file_path, @metadata, @content)
    `);

    this.getProject = db.prepare(`
      SELECT p.* FROM projects p
      JOIN clients c ON p.client_id = c.id
      WHERE c.slug = ? AND p.slug = ?
    `);

    this.getProjectBySlug = db.prepare(`
      SELECT p.*, c.slug as client_slug, c.name as client_name FROM projects p
      JOIN clients c ON p.client_id = c.id
      WHERE p.slug = ?
    `);

    this.getProjectsByClient = db.prepare(`
      SELECT * FROM projects WHERE client_id = ? ORDER BY name
    `);

    this.deleteProject = db.prepare(`
      DELETE FROM projects WHERE id = ?
    `);

    // Communication queries
    this.insertCommunication = db.prepare(`
      INSERT INTO communications (client_id, project_id, type, subject, date_range, participants, file_path, metadata, content)
      VALUES (@client_id, @project_id, @type, @subject, @date_range, @participants, @file_path, @metadata, @content)
    `);

    this.getCommunicationsByClient = db.prepare(`
      SELECT * FROM communications WHERE client_id = ? ORDER BY date_range DESC
    `);

    this.getCommunicationsByProject = db.prepare(`
      SELECT * FROM communications WHERE project_id = ? ORDER BY date_range DESC
    `);

    this.deleteCommunication = db.prepare(`
      DELETE FROM communications WHERE id = ?
    `);

    // Knowledge entry queries
    this.insertKnowledgeEntry = db.prepare(`
      INSERT INTO knowledge_entries (client_id, project_id, type, title, file_path, tags, metadata, content)
      VALUES (@client_id, @project_id, @type, @title, @file_path, @tags, @metadata, @content)
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

    this.getKnowledgeEntriesByClient = db.prepare(`
      SELECT * FROM knowledge_entries WHERE client_id = ? ORDER BY type, title
    `);

    this.getKnowledgeEntriesByProject = db.prepare(`
      SELECT * FROM knowledge_entries WHERE project_id = ? ORDER BY type, title
    `);

    this.deleteKnowledgeEntry = db.prepare(`
      DELETE FROM knowledge_entries WHERE id = ?
    `);

    // Event queries
    this.insertEvent = db.prepare(`
      INSERT INTO events (source, source_id, client_id, project_id, event_type, summary, payload)
      VALUES (@source, @source_id, @client_id, @project_id, @event_type, @summary, @payload)
    `);

    this.getRecentEvents = db.prepare(`
      SELECT * FROM events ORDER BY timestamp DESC LIMIT ?
    `);

    this.getEventsByClient = db.prepare(`
      SELECT * FROM events WHERE client_id = ? ORDER BY timestamp DESC
    `);

    this.getEventsByProject = db.prepare(`
      SELECT * FROM events WHERE project_id = ? ORDER BY timestamp DESC
    `);

    // Stats queries
    this.countClients = db.prepare(`
      SELECT COUNT(*) as count FROM clients
    `);

    this.countProjects = db.prepare(`
      SELECT COUNT(*) as count FROM projects
    `);

    this.countCommunications = db.prepare(`
      SELECT COUNT(*) as count FROM communications
    `);

    this.countKnowledgeEntries = db.prepare(`
      SELECT COUNT(*) as count FROM knowledge_entries
    `);

    this.countEvents = db.prepare(`
      SELECT COUNT(*) as count FROM events
    `);

    // Clear queries (used by clearAll)
    this.clearEvents = db.prepare(`DELETE FROM events`);
    this.clearKnowledgeEntries = db.prepare(`DELETE FROM knowledge_entries`);
    this.clearCommunications = db.prepare(`DELETE FROM communications`);
    this.clearProjects = db.prepare(`DELETE FROM projects`);
    this.clearClients = db.prepare(`DELETE FROM clients`);

    // FTS5 search queries
    // Search clients using FTS5 - returns full client records
    this.searchClientsFts = db.prepare(`
      SELECT c.* FROM clients c
      JOIN clients_fts ON c.id = clients_fts.rowid
      WHERE clients_fts MATCH ?
      ORDER BY rank
    `);

    // Search projects using FTS5 - returns full project records with client info
    this.searchProjectsFts = db.prepare(`
      SELECT p.*, c.slug as client_slug, c.name as client_name FROM projects p
      JOIN projects_fts ON p.id = projects_fts.rowid
      JOIN clients c ON p.client_id = c.id
      WHERE projects_fts MATCH ?
      ORDER BY rank
    `);

    // Search communications using FTS5 - returns full communication records
    this.searchCommunicationsFts = db.prepare(`
      SELECT comm.* FROM communications comm
      JOIN communications_fts ON comm.id = communications_fts.rowid
      WHERE communications_fts MATCH ?
      ORDER BY rank
    `);

    // Search knowledge entries using FTS5 - returns full knowledge entry records
    this.searchKnowledgeEntriesFts = db.prepare(`
      SELECT k.* FROM knowledge_entries k
      JOIN knowledge_entries_fts ON k.id = knowledge_entries_fts.rowid
      WHERE knowledge_entries_fts MATCH ?
      ORDER BY rank
    `);

    // Content-only search queries - search only the content field
    this.searchClientsContentFts = db.prepare(`
      SELECT c.* FROM clients c
      JOIN clients_fts ON c.id = clients_fts.rowid
      WHERE clients_fts MATCH 'content:' || ?
      ORDER BY rank
    `);

    this.searchProjectsContentFts = db.prepare(`
      SELECT p.*, c.slug as client_slug, c.name as client_name FROM projects p
      JOIN projects_fts ON p.id = projects_fts.rowid
      JOIN clients c ON p.client_id = c.id
      WHERE projects_fts MATCH 'content:' || ?
      ORDER BY rank
    `);

    this.searchCommunicationsContentFts = db.prepare(`
      SELECT comm.* FROM communications comm
      JOIN communications_fts ON comm.id = communications_fts.rowid
      WHERE communications_fts MATCH 'content:' || ?
      ORDER BY rank
    `);

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
