import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { dirname } from 'path';
import { PreparedQueries } from './queries.js';
import { MigrationRunner } from './migrations.js';
import type {
  KnowledgeEntry,
  Event,
  Expert,
  ExpertSession,
  KnowledgeEntryInsert,
  EventInsert,
  ExpertInsert,
  ExpertSessionInsert,
  DocumentSearchResult,
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

  // Knowledge entry operations
  insertKnowledgeEntry(entry: KnowledgeEntryInsert): number {
    const result = this.getQueries().insertKnowledgeEntry.run({
      type: entry.type,
      title: entry.title,
      file_path: entry.file_path,
      tags: entry.tags ? JSON.stringify(entry.tags) : null,
      metadata: entry.metadata ? JSON.stringify(entry.metadata) : null,
      content: entry.content ?? null,
    });
    return result.lastInsertRowid as number;
  }

  getKnowledgeEntriesByType(type: string): KnowledgeEntry[] {
    return this.getQueries().getKnowledgeEntriesByType.all(type) as KnowledgeEntry[];
  }

  getAllKnowledgeEntries(): KnowledgeEntry[] {
    return this.getQueries().getAllKnowledgeEntries.all() as KnowledgeEntry[];
  }

  getKnowledgeEntryByPath(filePath: string): KnowledgeEntry | undefined {
    return this.getQueries().getKnowledgeEntryByPath.get(filePath) as KnowledgeEntry | undefined;
  }

  // Event operations
  insertEvent(event: EventInsert): number {
    const result = this.getQueries().insertEvent.run({
      source: event.source,
      source_id: event.source_id ?? null,
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
   * Search knowledge entries using FTS5 full-text search.
   * @param query - FTS5 query
   * @returns Array of matching knowledge entries ordered by relevance
   */
  searchKnowledgeEntries(query: string): KnowledgeEntry[] {
    return this.getQueries().searchKnowledgeEntriesFts.all(query) as KnowledgeEntry[];
  }

  /**
   * Search knowledge entries' content field only using FTS5 full-text search.
   * @param query - FTS5 query
   * @returns Array of matching knowledge entries ordered by relevance
   */
  searchKnowledgeEntriesContent(query: string): KnowledgeEntry[] {
    return this.getQueries().searchKnowledgeEntriesContentFts.all(query) as KnowledgeEntry[];
  }

  /**
   * Search across all FTS5 tables and return unified results.
   * Queries knowledge entries and normalizes results into a common shape.
   * Silently skips any FTS5 table that is unavailable.
   */
  searchAllDocuments(query: string): DocumentSearchResult[] {
    const results: DocumentSearchResult[] = [];

    try {
      for (const entry of this.searchKnowledgeEntries(query)) {
        results.push({
          file_path: entry.file_path,
          title: entry.title,
          content: entry.content ?? undefined,
          rank: 0,
        });
      }
    } catch {
      // FTS5 not available for knowledge entries
    }

    return results;
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
      throw this.wrapDbError(error, 'insertExpertSession', `Expert ID: ${session.expert_id}`);
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
    return this.getQueries().getActiveSessionForExpert.get(expertId) as ExpertSession | undefined;
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

  // Knowledge entry deletion by path
  deleteKnowledgeEntryByPath(filePath: string): void {
    this.getQueries().deleteKnowledgeEntryByPath.run(filePath);
  }

  deleteKnowledgeEntry(id: number): void {
    this.getQueries().deleteKnowledgeEntry.run(id);
  }

  // Index metadata operations
  getIndexMetadata(key: string): string | undefined {
    const result = this.getQueries().getIndexMetadata.get(key) as { value: string } | undefined;
    return result?.value;
  }

  setIndexMetadata(key: string, value: string): void {
    this.getQueries().setIndexMetadata.run({ key, value });
  }

  // Utility operations
  clearAll() {
    const queries = this.getQueries();
    queries.clearExpertSessions.run();
    queries.clearExperts.run();
    queries.clearEvents.run();
    queries.clearKnowledgeEntries.run();
  }

  getStats() {
    const queries = this.getQueries();
    const knowledge = queries.countKnowledgeEntries.get() as { count: number };
    const events = queries.countEvents.get() as { count: number };
    const experts = queries.countExperts.get() as { count: number };

    return {
      knowledge_entries: knowledge.count,
      events: events.count,
      experts: experts.count,
    };
  }

  close() {
    this.db.close();
  }
}
