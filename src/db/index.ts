import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { dirname } from 'path';
import { PreparedQueries } from './queries.js';
import { MigrationRunner } from './migrations.js';
import type {
  Client,
  Project,
  Communication,
  KnowledgeEntry,
  Event,
  Expert,
  ExpertSession,
  ClientInsert,
  ProjectInsert,
  CommunicationInsert,
  KnowledgeEntryInsert,
  EventInsert,
  ExpertInsert,
  ExpertSessionInsert,
} from './types.js';

export class LuxDatabase {
  private db: Database.Database;
  private queries?: PreparedQueries;
  private migrations: MigrationRunner;

  constructor(dbPath: string, autoMigrate = true) {
    // Ensure database directory exists
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');

    // Initialize migration system
    this.migrations = new MigrationRunner(this.db);

    // Run migrations automatically unless disabled
    if (autoMigrate) {
      this.runMigrations();
      this.initQueries();
    }
  }

  /**
   * Wrap database errors with more helpful messages
   */
  private wrapDbError(error: unknown, operation: string, context?: string): Error {
    if (error instanceof Error) {
      const message = error.message;

      // Handle specific SQLite error codes
      if (message.includes('UNIQUE constraint failed')) {
        const match = message.match(/UNIQUE constraint failed: (\w+)\.(\w+)/);
        if (match) {
          const [, table, column] = match;
          return new Error(
            `Duplicate ${table.slice(0, -1)} detected: ${column} already exists. ${context || ''}`
          );
        }
        return new Error(`Duplicate entry detected during ${operation}. ${context || ''}`);
      }

      if (message.includes('FOREIGN KEY constraint failed')) {
        return new Error(
          `Invalid relationship during ${operation}: Referenced parent entity does not exist. ${context || ''}`
        );
      }

      if (message.includes('NOT NULL constraint failed')) {
        const match = message.match(/NOT NULL constraint failed: (\w+)\.(\w+)/);
        if (match) {
          const [, table, column] = match;
          return new Error(
            `Missing required field during ${operation}: ${column} is required for ${table}. ${context || ''}`
          );
        }
        return new Error(`Missing required field during ${operation}. ${context || ''}`);
      }

      if (message.includes('CHECK constraint failed')) {
        return new Error(
          `Validation failed during ${operation}: Data does not meet database constraints. ${context || ''}`
        );
      }

      // Return original error with added context
      return new Error(`${operation} failed: ${message}. ${context || ''}`);
    }

    return new Error(`${operation} failed: ${String(error)}. ${context || ''}`);
  }

  /**
   * Initialize prepared queries. Must be called after migrations.
   */
  private initQueries() {
    if (!this.queries) {
      this.queries = new PreparedQueries(this.db);
    }
  }

  /**
   * Get prepared queries, ensuring they are initialized.
   */
  private getQueries(): PreparedQueries {
    if (!this.queries) {
      this.initQueries();
    }
    return this.queries!;
  }

  /**
   * Run all pending database migrations.
   */
  runMigrations(): number {
    return this.migrations.runMigrations();
  }

  /**
   * Get migration status information.
   */
  getMigrationStatus() {
    return this.migrations.getStatus();
  }

  /**
   * Check if the database schema is up to date.
   */
  isSchemaUpToDate(): boolean {
    return this.migrations.isUpToDate();
  }

  // Client operations
  insertClient(client: ClientInsert): number {
    try {
      const result = this.getQueries().insertClient.run({
        ...client,
        metadata: client.metadata ? JSON.stringify(client.metadata) : null,
      });
      return result.lastInsertRowid as number;
    } catch (error) {
      throw this.wrapDbError(error, 'insertClient', `Client slug: ${client.slug}`);
    }
  }

  getClient(slug: string): Client | undefined {
    return this.getQueries().getClient.get(slug) as Client | undefined;
  }

  getAllClients(): Client[] {
    return this.getQueries().getAllClients.all() as Client[];
  }

  updateClient(slug: string, updates: Partial<ClientInsert>) {
    const fields: string[] = [];
    const values: Record<string, unknown> = { slug };

    if (updates.name !== undefined) {
      fields.push('name = @name');
      values.name = updates.name;
    }
    if (updates.type !== undefined) {
      fields.push('type = @type');
      values.type = updates.type;
    }
    if (updates.status !== undefined) {
      fields.push('status = @status');
      values.status = updates.status;
    }
    if (updates.file_path !== undefined) {
      fields.push('file_path = @file_path');
      values.file_path = updates.file_path;
    }
    if (updates.metadata !== undefined) {
      fields.push('metadata = @metadata');
      values.metadata = JSON.stringify(updates.metadata);
    }

    if (fields.length === 0) return;

    fields.push('updated_at = unixepoch()');
    const stmt = this.db.prepare(`
      UPDATE clients SET ${fields.join(', ')} WHERE slug = @slug
    `);
    stmt.run(values);
  }

  deleteClient(slug: string) {
    this.getQueries().deleteClient.run(slug);
  }

  // Project operations
  insertProject(project: ProjectInsert): number {
    try {
      const result = this.getQueries().insertProject.run({
        ...project,
        metadata: project.metadata ? JSON.stringify(project.metadata) : null,
      });
      return result.lastInsertRowid as number;
    } catch (error) {
      throw this.wrapDbError(
        error,
        'insertProject',
        `Project slug: ${project.slug}, Client ID: ${project.client_id}`
      );
    }
  }

  getProject(clientSlug: string, projectSlug: string): Project | undefined {
    return this.getQueries().getProject.get(clientSlug, projectSlug) as Project | undefined;
  }

  getProjectBySlug(
    projectSlug: string
  ): (Project & { client_slug: string; client_name: string }) | undefined {
    return this.getQueries().getProjectBySlug.get(projectSlug) as
      | (Project & { client_slug: string; client_name: string })
      | undefined;
  }

  getProjectsByClient(clientId: number): Project[] {
    return this.getQueries().getProjectsByClient.all(clientId) as Project[];
  }

  // Communication operations
  insertCommunication(comm: CommunicationInsert): number {
    try {
      const result = this.getQueries().insertCommunication.run({
        ...comm,
        participants: comm.participants ? JSON.stringify(comm.participants) : null,
        metadata: comm.metadata ? JSON.stringify(comm.metadata) : null,
      });
      return result.lastInsertRowid as number;
    } catch (error) {
      throw this.wrapDbError(
        error,
        'insertCommunication',
        `Client ID: ${comm.client_id}, Type: ${comm.type}`
      );
    }
  }

  getCommunicationsByClient(clientId: number): Communication[] {
    return this.getQueries().getCommunicationsByClient.all(clientId) as Communication[];
  }

  getCommunicationsByProject(projectId: number): Communication[] {
    return this.getQueries().getCommunicationsByProject.all(projectId) as Communication[];
  }

  // Knowledge entry operations
  insertKnowledgeEntry(entry: KnowledgeEntryInsert): number {
    const result = this.getQueries().insertKnowledgeEntry.run({
      ...entry,
      tags: entry.tags ? JSON.stringify(entry.tags) : null,
      metadata: entry.metadata ? JSON.stringify(entry.metadata) : null,
    });
    return result.lastInsertRowid as number;
  }

  getKnowledgeEntriesByType(type: string): KnowledgeEntry[] {
    return this.getQueries().getKnowledgeEntriesByType.all(type) as KnowledgeEntry[];
  }

  getKnowledgeEntryByPath(filePath: string): KnowledgeEntry | undefined {
    return this.getQueries().getKnowledgeEntryByPath.get(filePath) as KnowledgeEntry | undefined;
  }

  getKnowledgeEntriesByClient(clientId: number): KnowledgeEntry[] {
    return this.getQueries().getKnowledgeEntriesByClient.all(clientId) as KnowledgeEntry[];
  }

  getKnowledgeEntriesByProject(projectId: number): KnowledgeEntry[] {
    return this.getQueries().getKnowledgeEntriesByProject.all(projectId) as KnowledgeEntry[];
  }

  // Event operations
  insertEvent(event: EventInsert): number {
    const result = this.getQueries().insertEvent.run({
      source: event.source,
      source_id: event.source_id ?? null,
      client_id: event.client_id ?? null,
      project_id: event.project_id ?? null,
      event_type: event.event_type,
      summary: event.summary ?? null,
      payload: event.payload ? JSON.stringify(event.payload) : null,
    });
    return result.lastInsertRowid as number;
  }

  getRecentEvents(limit = 100): Event[] {
    return this.getQueries().getRecentEvents.all(limit) as Event[];
  }

  // FTS5 Search operations
  /**
   * Search clients using FTS5 full-text search.
   * @param query - FTS5 query (supports phrase search, AND/OR/NOT operators, prefix matching with *)
   * @returns Array of matching clients ordered by relevance
   *
   * @example
   * // Simple search
   * db.searchClients('acme');
   *
   * // Phrase search
   * db.searchClients('"sinai chicago"');
   *
   * // Prefix matching
   * db.searchClients('prov*');
   *
   * // Boolean operators
   * db.searchClients('active AND client');
   */
  searchClients(query: string): Client[] {
    return this.getQueries().searchClientsFts.all(query) as Client[];
  }

  /**
   * Search projects using FTS5 full-text search.
   * @param query - FTS5 query
   * @returns Array of matching projects with client info, ordered by relevance
   */
  searchProjects(query: string): (Project & { client_slug: string; client_name: string })[] {
    return this.getQueries().searchProjectsFts.all(query) as (Project & {
      client_slug: string;
      client_name: string;
    })[];
  }

  /**
   * Search communications using FTS5 full-text search.
   * @param query - FTS5 query
   * @returns Array of matching communications ordered by relevance
   */
  searchCommunications(query: string): Communication[] {
    return this.getQueries().searchCommunicationsFts.all(query) as Communication[];
  }

  /**
   * Search knowledge entries using FTS5 full-text search.
   * @param query - FTS5 query
   * @returns Array of matching knowledge entries ordered by relevance
   */
  searchKnowledgeEntries(query: string): KnowledgeEntry[] {
    return this.getQueries().searchKnowledgeEntriesFts.all(query) as KnowledgeEntry[];
  }

  // Content-only search operations
  /**
   * Search clients' content field only using FTS5 full-text search.
   * @param query - FTS5 query (supports phrase search, AND/OR/NOT operators, prefix matching with *)
   * @returns Array of matching clients ordered by relevance
   */
  searchClientsContent(query: string): Client[] {
    return this.getQueries().searchClientsContentFts.all(query) as Client[];
  }

  /**
   * Search projects' content field only using FTS5 full-text search.
   * @param query - FTS5 query
   * @returns Array of matching projects with client info, ordered by relevance
   */
  searchProjectsContent(query: string): (Project & { client_slug: string; client_name: string })[] {
    return this.getQueries().searchProjectsContentFts.all(query) as (Project & {
      client_slug: string;
      client_name: string;
    })[];
  }

  /**
   * Search communications' content field only using FTS5 full-text search.
   * @param query - FTS5 query
   * @returns Array of matching communications ordered by relevance
   */
  searchCommunicationsContent(query: string): Communication[] {
    return this.getQueries().searchCommunicationsContentFts.all(query) as Communication[];
  }

  /**
   * Search knowledge entries' content field only using FTS5 full-text search.
   * @param query - FTS5 query
   * @returns Array of matching knowledge entries ordered by relevance
   */
  searchKnowledgeEntriesContent(query: string): KnowledgeEntry[] {
    return this.getQueries().searchKnowledgeEntriesContentFts.all(query) as KnowledgeEntry[];
  }

  // Expert operations
  insertExpert(expert: ExpertInsert): number {
    try {
      const result = this.getQueries().insertExpert.run({
        slug: expert.slug,
        name: expert.name,
        mount_path: expert.mount_path,
        model: expert.model ?? 'claude-sonnet-4-20250514',
        claude_md_path: expert.claude_md_path ?? null,
        memory_path: expert.memory_path ?? null,
        status: expert.status ?? 'active',
      });
      return result.lastInsertRowid as number;
    } catch (error) {
      throw this.wrapDbError(error, 'insertExpert', `Expert slug: ${expert.slug}`);
    }
  }

  getExpert(slug: string): Expert | undefined {
    return this.getQueries().getExpert.get(slug) as Expert | undefined;
  }

  getAllExperts(): Expert[] {
    return this.getQueries().getAllExperts.all() as Expert[];
  }

  getExpertsByStatus(status: string): Expert[] {
    return this.getQueries().getExpertsByStatus.all(status) as Expert[];
  }

  updateExpert(slug: string, updates: Partial<ExpertInsert>) {
    this.getQueries().updateExpert.run({
      slug,
      name: updates.name ?? null,
      mount_path: updates.mount_path ?? null,
      model: updates.model ?? null,
      claude_md_path: updates.claude_md_path ?? null,
      memory_path: updates.memory_path ?? null,
      status: updates.status ?? null,
    });
  }

  deleteExpert(slug: string) {
    this.getQueries().deleteExpert.run(slug);
  }

  // Expert session operations
  insertExpertSession(session: ExpertSessionInsert): number {
    try {
      const result = this.getQueries().insertExpertSession.run({
        expert_id: session.expert_id,
        session_ref: session.session_ref,
        status: session.status ?? 'warm',
      });
      return result.lastInsertRowid as number;
    } catch (error) {
      throw this.wrapDbError(
        error,
        'insertExpertSession',
        `Expert ID: ${session.expert_id}`
      );
    }
  }

  getExpertSession(id: number): ExpertSession | undefined {
    return this.getQueries().getExpertSession.get(id) as ExpertSession | undefined;
  }

  getSessionsByExpert(expertId: number): ExpertSession[] {
    return this.getQueries().getSessionsByExpert.all(expertId) as ExpertSession[];
  }

  getSessionsByStatus(
    status: string
  ): (ExpertSession & { expert_slug: string; expert_name: string })[] {
    return this.getQueries().getSessionsByStatus.all(status) as (ExpertSession & {
      expert_slug: string;
      expert_name: string;
    })[];
  }

  getActiveSessionForExpert(expertId: number): ExpertSession | undefined {
    return this.getQueries().getActiveSessionForExpert.get(expertId) as
      | ExpertSession
      | undefined;
  }

  touchExpertSession(id: number) {
    this.getQueries().updateSessionLastActive.run(id);
  }

  updateExpertSessionStatus(id: number, status: string) {
    this.getQueries().updateSessionStatus.run({ id, status });
  }

  deleteExpertSession(id: number) {
    this.getQueries().deleteExpertSession.run(id);
  }

  deleteSessionsByExpert(expertId: number) {
    this.getQueries().deleteSessionsByExpert.run(expertId);
  }

  // Utility operations
  clearAll() {
    const queries = this.getQueries();
    queries.clearExpertSessions.run();
    queries.clearExperts.run();
    queries.clearEvents.run();
    queries.clearKnowledgeEntries.run();
    queries.clearCommunications.run();
    queries.clearProjects.run();
    queries.clearClients.run();
  }

  getStats() {
    const queries = this.getQueries();
    const clients = queries.countClients.get() as { count: number };
    const projects = queries.countProjects.get() as { count: number };
    const communications = queries.countCommunications.get() as { count: number };
    const knowledge = queries.countKnowledgeEntries.get() as { count: number };
    const events = queries.countEvents.get() as { count: number };
    const experts = queries.countExperts.get() as { count: number };

    return {
      clients: clients.count,
      projects: projects.count,
      communications: communications.count,
      knowledge_entries: knowledge.count,
      events: events.count,
      experts: experts.count,
    };
  }

  close() {
    this.db.close();
  }
}
