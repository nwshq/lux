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
  ModuleDependency,
  StructuralNode,
  StructuralEdge,
  EdgeEvidence,
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

  // Module dependency operations
  insertModuleDependency(dep: Omit<ModuleDependency, 'id' | 'created_at'>): void {
    this.getQueries().insertModuleDependency.run({
      source_module: dep.source_module,
      target_module: dep.target_module,
      reference_count: dep.reference_count,
      sample_files: dep.sample_files,
    });
  }

  getModuleDependencies(
    module: string,
    direction: 'source' | 'target' | 'both'
  ): ModuleDependency[] {
    const q = this.getQueries();
    if (direction === 'source') {
      return q.getModuleDependenciesBySource.all(module) as ModuleDependency[];
    }
    if (direction === 'target') {
      return q.getModuleDependenciesByTarget.all(module) as ModuleDependency[];
    }
    // 'both' — union of source and target, deduplicated by id
    const fromSource = q.getModuleDependenciesBySource.all(module) as ModuleDependency[];
    const fromTarget = q.getModuleDependenciesByTarget.all(module) as ModuleDependency[];
    const seen = new Set<number>();
    const result: ModuleDependency[] = [];
    for (const dep of [...fromSource, ...fromTarget]) {
      if (!seen.has(dep.id)) {
        seen.add(dep.id);
        result.push(dep);
      }
    }
    return result;
  }

  getAllModuleDependencies(): ModuleDependency[] {
    return this.getQueries().getAllModuleDependencies.all() as ModuleDependency[];
  }

  clearModuleDependencies(): void {
    this.getQueries().clearModuleDependencies.run();
  }

  getDistinctModules(): string[] {
    const rows = this.getQueries().getDistinctModules.all() as { module: string }[];
    return rows.map((r) => r.module);
  }

  // ---------------------------------------------------------------------------
  // Structural overlay operations
  // ---------------------------------------------------------------------------

  upsertStructuralNode(node: StructuralNode): void {
    this.getQueries().upsertStructuralNode.run({
      id: node.id,
      node_type: node.node_type,
      file_path: node.file_path ?? null,
      language_id: node.language_id ?? null,
      symbol_name: node.symbol_name ?? null,
      symbol_kind: node.symbol_kind ?? null,
      qualified_name: node.qualified_name ?? null,
      metadata: node.metadata ?? null,
      updated_at: node.updated_at,
    });
  }

  upsertStructuralEdge(edge: StructuralEdge): void {
    this.getQueries().upsertStructuralEdge.run({
      id: edge.id,
      source_node_id: edge.source_node_id,
      target_node_id: edge.target_node_id,
      edge_type: edge.edge_type,
      confidence: edge.confidence,
      confidence_class: edge.confidence_class,
      freshness_status: edge.freshness_status,
      source_commit: edge.source_commit ?? null,
      dirty_dependency_count: edge.dirty_dependency_count,
      provenance_summary: edge.provenance_summary ?? null,
      updated_at: edge.updated_at,
    });
  }

  /**
   * Replace all evidence for an edge atomically.
   * Deletes existing evidence then inserts the new set in a single transaction.
   */
  replaceEdgeEvidence(edgeId: string, evidence: EdgeEvidence[]): void {
    const q = this.getQueries();
    const replaceTransaction = this.db.transaction(() => {
      q.deleteEdgeEvidence.run(edgeId);
      for (const ev of evidence) {
        q.insertEdgeEvidence.run({
          id: ev.id,
          edge_id: ev.edge_id,
          resolver: ev.resolver,
          evidence_kind: ev.evidence_kind,
          file_path: ev.file_path ?? null,
          line: ev.line ?? null,
          note: ev.note ?? null,
          payload_json: ev.payload_json ?? null,
          recorded_at: ev.recorded_at,
        });
      }
    });
    replaceTransaction();
  }

  getStructuralNode(id: string): StructuralNode | null {
    return (this.getQueries().getStructuralNode.get(id) as StructuralNode | undefined) ?? null;
  }

  getStructuralNodesByFilePath(filePath: string): StructuralNode[] {
    return this.getQueries().getStructuralNodeByFilePath.all(filePath) as StructuralNode[];
  }

  getStructuralNodesByType(nodeType: string): StructuralNode[] {
    return this.getQueries().getStructuralNodesByType.all(nodeType) as StructuralNode[];
  }

  getStructuralEdgesForNode(nodeId: string): StructuralEdge[] {
    return this.getQueries().getStructuralEdgesForNode.all(nodeId, nodeId) as StructuralEdge[];
  }

  getEdgeEvidence(edgeId: string): EdgeEvidence[] {
    return this.getQueries().getEdgeEvidence.all(edgeId) as EdgeEvidence[];
  }

  /**
   * Mark edges that touch any of the given file paths as dirty-dependent.
   * Returns the total number of edges invalidated.
   */
  invalidateEdgesForFiles(filePaths: string[]): number {
    let total = 0;
    const q = this.getQueries();
    for (const filePath of filePaths) {
      const info = q.invalidateEdgesForFile.run(filePath);
      total += info.changes;
    }
    return total;
  }

  /**
   * Mark edges touching file paths as stale (commit baseline no longer valid).
   * Returns total edges marked stale.
   */
  markEdgesStaleForFiles(filePaths: string[]): number {
    let total = 0;
    const q = this.getQueries();
    for (const filePath of filePaths) {
      const info = q.markEdgesStaleForFile.run(filePath);
      total += info.changes;
    }
    return total;
  }

  /**
   * Mark all `fresh` edges whose source_commit differs from the given commit as stale.
   * Call this at the start of a rebuild when the HEAD commit has advanced.
   * Returns the number of edges marked stale.
   */
  markEdgesStaleByCommit(currentCommit: string): number {
    const info = this.getQueries().markEdgesStaleByCommit.run(currentCommit);
    return info.changes;
  }

  /**
   * Retrieve all edges for a node plus their evidence in one call.
   * Combines getStructuralEdgesForNode() and getEdgeEvidence() per edge.
   */
  getRelatedEdgesWithEvidence(nodeId: string): Array<{ edge: StructuralEdge; evidence: EdgeEvidence[] }> {
    const edges = this.getStructuralEdgesForNode(nodeId);
    return edges.map((edge) => ({
      edge,
      evidence: this.getEdgeEvidence(edge.id),
    }));
  }

  // ---------------------------------------------------------------------------
  // Capability-surface queries
  // ---------------------------------------------------------------------------

  /**
   * Return all capability-surface nodes, most recently updated first.
   */
  getCapabilitySurfaces(): StructuralNode[] {
    return this.getQueries().getCapabilitySurfaces.all() as StructuralNode[];
  }

  /**
   * Search capability-surface nodes whose canonical handle (symbol_name)
   * matches the given prefix pattern. Use `%` suffix for prefix search or
   * exact string for exact match.
   *
   * @param handlePattern - SQLite LIKE pattern (e.g. `"GET %"` or `"GET /api/invoices"`).
   */
  searchSurfacesByHandle(handlePattern: string): StructuralNode[] {
    return this.getQueries().searchSurfacesByHandle.all(handlePattern) as StructuralNode[];
  }

  /**
   * Retrieve a surface node plus all edges and evidence connected to it.
   * Returns null if the surface node does not exist.
   */
  getSurfaceCenteredContext(surfaceNodeId: string): {
    surface: StructuralNode;
    edges: Array<{ edge: StructuralEdge; evidence: EdgeEvidence[] }>;
  } | null {
    const surface = this.getStructuralNode(surfaceNodeId);
    if (!surface) return null;
    return {
      surface,
      edges: this.getRelatedEdgesWithEvidence(surfaceNodeId),
    };
  }

  // Utility operations
  clearAll() {
    const queries = this.getQueries();
    queries.clearEdgeEvidence.run();
    queries.clearStructuralEdges.run();
    queries.clearStructuralNodes.run();
    queries.clearModuleDependencies.run();
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
