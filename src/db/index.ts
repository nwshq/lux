import { LuxSqlite } from './sqlite-adapter.js';
import { mkdirSync } from 'fs';
import { dirname } from 'path';
import { PreparedQueries } from './queries.js';
import { MigrationRunner } from './migrations.js';
import type {
  KnowledgeEntry,
  Event,
  KnowledgeEntryInsert,
  EventInsert,
  DocumentSearchResult,
  ModuleDependency,
  StructuralNode,
  StructuralEdge,
  EdgeEvidence,
  OperationalBoundary,
  OperationalHandler,
  OperationalEdge,
  OperationalContract,
} from './types.js';

export class LuxDatabase {
  private db: LuxSqlite;
  private queries?: PreparedQueries;
  private migrations: MigrationRunner;

  constructor(dbPath: string, autoMigrate = true) {
    // Ensure database directory exists
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new LuxSqlite(dbPath);
    // journal_mode=delete: WASM SQLite has no WAL. Benchmarked faster than `memory`
    // (1.24x vs 1.43x the better-sqlite3/WAL baseline) and crash-safe (on-disk rollback
    // journal). synchronous=NORMAL preserves the batched-write throughput the app rebuild
    // and the ~818k-row vendor-pack merge depend on; the Lux DB is derived state, so the
    // small durability trade-off is recoverable by a rebuild (ADR-4 / ADR-2).
    this.db.pragma('journal_mode = delete');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('synchronous = NORMAL');

    // Initialize migration system
    this.migrations = new MigrationRunner(this.db);

    // Run migrations automatically unless disabled
    if (autoMigrate) {
      this.runMigrations();
      this.initQueries();
    }
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

  deleteIndexMetadata(key: string): void {
    this.getQueries().deleteIndexMetadata.run(key);
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
      origin: node.origin ?? 'local',
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

  /**
   * Run `fn` inside a single SQLite transaction and return its result. `fn` must
   * be synchronous (better-sqlite3 transactions cannot span an await). Batches the
   * many small overlay writes into one commit — the write path both the app
   * rebuild and the vendor-pack merge reuse (ADR-6 / ADR-2 / REQ-4).
   */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  /**
   * Merge a vendor pack's structural nodes and edges into this project's overlay
   * (ADR-2). The pack is a standalone overlay-shaped SQLite file, built once per
   * `composer.lock` (ADR-1); its tables mirror `structural_nodes` /
   * `structural_edges`. There is no attach-by-reference at query time (a single
   * `new Database` handle), so the merge is a transient merge-time ATTACH + bulk
   * `INSERT OR IGNORE … SELECT`, all in-engine (~818k rows never cross into JS).
   *
   * - Every imported node is stamped `origin='vendor-pack'` (ADR-3).
   * - `INSERT OR IGNORE` means a project (local) node/edge that already occupies
   *   an id WINS — the app's real code over the vendor copy (ADR-2).
   * - `edge_evidence` is NOT imported: vendor edges carry their provenance inline
   *   in `provenance_summary`, and importing per-edge evidence multiplies rows for
   *   marginal trace value.
   *
   * `clearOverlay()` wipes the overlay at the top of each rebuild, so this runs
   * every rebuild; one transaction under `synchronous=NORMAL` keeps it ~1.7s for
   * ~818k rows (REQ-4). ATTACH must happen OUTSIDE the transaction (SQLite forbids
   * ATTACH within a transaction); the write is committed before DETACH.
   *
   * @param packDbPath Absolute path to a built vendor pack DB.
   * @returns Net rows inserted (post-`OR IGNORE`).
   */
  importVendorPack(packDbPath: string): { nodes: number; edges: number } {
    this.getQueries(); // ensure the DB is initialized/migrated before we touch it
    // Transient one-shots (ATTACH / bulk INSERT / DETACH): use the auto-finalizing
    // `run()` so they never enter the finalize registry (the MCP DB is never closed).
    this.db.run('ATTACH DATABASE ? AS pack', packDbPath);
    try {
      let nodes = 0;
      let edges = 0;
      const importAll = this.db.transaction(() => {
        nodes = this.db.run(
          `INSERT OR IGNORE INTO structural_nodes
               (id, node_type, file_path, language_id, symbol_name, symbol_kind, qualified_name, metadata, origin, updated_at)
             SELECT id, node_type, file_path, language_id, symbol_name, symbol_kind, qualified_name, metadata, 'vendor-pack', updated_at
               FROM pack.structural_nodes`
        ).changes;
        edges = this.db.run(
          `INSERT OR IGNORE INTO structural_edges
               (id, source_node_id, target_node_id, edge_type, confidence, confidence_class, freshness_status, source_commit, dirty_dependency_count, provenance_summary, updated_at)
             SELECT id, source_node_id, target_node_id, edge_type, confidence, confidence_class, freshness_status, source_commit, dirty_dependency_count, provenance_summary, updated_at
               FROM pack.structural_edges`
        ).changes;
      });
      importAll();
      return { nodes, edges };
    } finally {
      this.db.run('DETACH DATABASE pack');
    }
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

  /**
   * Structural nodes of a type, EXCLUDING imported vendor-pack nodes (ADR-3 /
   * REQ-7). Overlay consumers that must not surface framework internals
   * (module-boundary analysis, retrieval, trust-state counts) use this instead
   * of {@link getStructuralNodesByType}.
   */
  getLocalStructuralNodesByType(nodeType: string): StructuralNode[] {
    return this.getQueries().getLocalStructuralNodesByType.all(nodeType) as StructuralNode[];
  }

  /** True when a node was imported from a vendor pack (not project-local). (ADR-3) */
  static isExternalNode(node: Pick<StructuralNode, 'origin'>): boolean {
    return (node.origin ?? 'local') !== 'local';
  }

  getStructuralEdgesForNode(nodeId: string): StructuralEdge[] {
    return this.getQueries().getStructuralEdgesForNode.all(nodeId, nodeId) as StructuralEdge[];
  }

  /**
   * Outgoing structural edges from a node (source_node_id = nodeId), ordered by
   * confidence. Backs the forward call-trace frontier expansion (ADR-5, REQ-8).
   */
  getOutgoingStructuralEdges(nodeId: string): StructuralEdge[] {
    return this.getQueries().getStructuralEdgesForSourceNode.all(nodeId) as StructuralEdge[];
  }

  /** `handled_by` edges from HTTP surfaces, for ownership classification (E1). */
  getHandlerEdgesForOwnership(): Array<{ id: string; target_node_id: string }> {
    return this.getQueries().getHandlerEdgesForOwnership.all() as Array<{
      id: string;
      target_node_id: string;
    }>;
  }

  /** Persist ownership labels on structural edges in one transaction (E1). */
  setEdgeOwnershipBatch(updates: Array<{ id: string; ownership: string }>): void {
    const stmt = this.getQueries().setEdgeOwnership;
    this.db.transaction((rows: Array<{ id: string; ownership: string }>) => {
      for (const r of rows) stmt.run(r.ownership, r.id);
    })(updates);
  }

  /** Ownership breakdown of HTTP handler edges, for `lux overlay ownership` (E1). */
  getOwnershipBreakdown(): Array<{ ownership: string | null; count: number }> {
    return this.getQueries().getOwnershipBreakdown.all() as Array<{
      ownership: string | null;
      count: number;
    }>;
  }

  /**
   * Resolve a user-supplied symbol (node id, PHP FQN, or leaf name) to candidate
   * structural symbol nodes for a trace start (ADR-5). Returns [] if none.
   */
  findStructuralSymbolNodes(term: string, limit = 10): StructuralNode[] {
    const leaf = term.includes('::') ? term.slice(term.lastIndexOf('::') + 2) : term;
    return this.getQueries().findStructuralSymbolNodes.all({
      term,
      suffix: `%\\${term}`,
      leaf,
      limit,
    }) as StructuralNode[];
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
  getRelatedEdgesWithEvidence(
    nodeId: string
  ): Array<{ edge: StructuralEdge; evidence: EdgeEvidence[] }> {
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

  // ---------------------------------------------------------------------------
  // Operational boundary queries
  // ---------------------------------------------------------------------------

  upsertOperationalBoundary(boundary: OperationalBoundary): void {
    this.getQueries().upsertOperationalBoundary.run({
      id: boundary.id,
      repo_root: boundary.repo_root,
      kind: boundary.kind,
      name: boundary.name,
      trust_tier: boundary.trust_tier,
      file_path: boundary.file_path ?? null,
    });
  }

  getOperationalBoundary(id: string): OperationalBoundary | null {
    return (
      (this.getQueries().getOperationalBoundary.get(id) as OperationalBoundary | undefined) ?? null
    );
  }

  getOperationalBoundariesByKind(kind: OperationalBoundary['kind']): OperationalBoundary[] {
    return this.getQueries().getOperationalBoundariesByKind.all(kind) as OperationalBoundary[];
  }

  getOperationalBoundariesByRepoRoot(repoRoot: string): OperationalBoundary[] {
    return this.getQueries().getOperationalBoundariesByRepoRoot.all(
      repoRoot
    ) as OperationalBoundary[];
  }

  upsertOperationalHandler(handler: OperationalHandler): void {
    this.getQueries().upsertOperationalHandler.run({
      id: handler.id,
      boundary_id: handler.boundary_id,
      symbol_id: handler.symbol_id,
      trust_tier: handler.trust_tier,
    });
  }

  getOperationalHandlersForBoundary(boundaryId: string): OperationalHandler[] {
    return this.getQueries().getOperationalHandlersForBoundary.all(
      boundaryId
    ) as OperationalHandler[];
  }

  upsertOperationalEdge(edge: OperationalEdge): void {
    this.getQueries().upsertOperationalEdge.run({
      id: edge.id,
      source_id: edge.source_id,
      target_id: edge.target_id,
      edge_type: edge.edge_type,
      transport: edge.transport ?? null,
      trust_tier: edge.trust_tier,
    });
  }

  getOperationalEdgesForSource(sourceId: string): OperationalEdge[] {
    return this.getQueries().getOperationalEdgesForSource.all(sourceId) as OperationalEdge[];
  }

  getOperationalEdgesForTarget(targetId: string): OperationalEdge[] {
    return this.getQueries().getOperationalEdgesForTarget.all(targetId) as OperationalEdge[];
  }

  upsertOperationalContract(contract: OperationalContract): void {
    this.getQueries().upsertOperationalContract.run({
      id: contract.id,
      boundary_id: contract.boundary_id,
      payload_schema: contract.payload_schema ?? null,
      trust_tier: contract.trust_tier,
    });
  }

  getOperationalContractsForBoundary(boundaryId: string): OperationalContract[] {
    return this.getQueries().getOperationalContractsForBoundary.all(
      boundaryId
    ) as OperationalContract[];
  }

  // Utility operations
  clearKnowledgeIndex(): void {
    const queries = this.getQueries();
    queries.clearKnowledgeEntries.run();
    queries.clearModuleDependencies.run();
  }

  clearOverlay(): void {
    const queries = this.getQueries();
    queries.clearEdgeEvidence.run();
    queries.clearStructuralEdges.run();
    queries.clearStructuralNodes.run();
    queries.clearOperationalContracts.run();
    queries.clearOperationalEdges.run();
    queries.clearOperationalHandlers.run();
    queries.clearOperationalBoundaries.run();
  }

  clearRebuildTrustState(): void {
    this.deleteIndexMetadata('overlay_trust_state');
  }

  clearAll() {
    const queries = this.getQueries();
    this.clearOverlay();
    this.clearKnowledgeIndex();
    queries.clearEvents.run();
  }

  getStats() {
    const queries = this.getQueries();
    const knowledge = queries.countKnowledgeEntries.get() as { count: number };
    const events = queries.countEvents.get() as { count: number };

    return {
      knowledge_entries: knowledge.count,
      events: events.count,
    };
  }

  close() {
    this.db.close();
  }
}
