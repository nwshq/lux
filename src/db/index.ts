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
  EdgeFreshnessCounts,
} from './types.js';

/** A kernel HTTP `handled_by` route joined against the client's nodes/routes (cross-area, #62). */
export interface CrossAreaKernelRow {
  route: string; // surface:http:METHOD:/path
  kernel_handler: string; // symbol:php:<FQCN>
  client_node: string | null; // client node id matching the handler FQCN (present → client implements it)
  client_handler: string | null; // client's own handler for the same route (present → client overrides it)
}

/** A client's own HTTP `handled_by` route (for the client-local sweep). */
export interface CrossAreaClientRoute {
  route: string;
  handler: string;
}

export class LuxDatabase {
  private db: LuxSqlite;
  private queries?: PreparedQueries;
  private migrations: MigrationRunner;

  constructor(dbPath: string, autoMigrate = true) {
    // Ensure database directory exists
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new LuxSqlite(dbPath);
    // journal_mode=delete: WASM SQLite has no WAL. Benchmarked faster than `memory`
    // (1.24x vs 1.43x the better-sqlite3/WAL baseline). synchronous=NORMAL keeps the
    // batched-write throughput the app rebuild and the ~818k-row vendor-pack merge depend
    // on; under a rollback journal that trades a narrow power-loss / OS-crash corruption
    // window (a plain process crash still rolls back cleanly on reopen) — acceptable
    // because the Lux DB is derived state, fully recoverable by `lux index rebuild`
    // (ADR-4 / ADR-2).
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

  /** The highest applied migration version (the schema_version the fingerprint pins to). */
  getAppliedSchemaVersion(): number {
    const row = this.db.get('SELECT MAX(version) AS v FROM schema_version') as { v: number | null };
    return row?.v ?? 0;
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
      try {
        this.db.run('DETACH DATABASE pack');
      } catch {
        // best-effort: a failed merge can leave the transaction open (DETACH-in-transaction
        // is illegal), so don't let DETACH mask the original error — the pack detaches when
        // the handle closes anyway.
      }
    }
  }

  /**
   * Run `fn` with a sibling area's `.lux` index ATTACHed read-side as `kernel` (cross-area
   * ownership, #62). Mirrors importVendorPack's ATTACH-outside-transaction / DETACH-in-finally,
   * but performs NO writes on `kernel.*` — read-only is by discipline (node-sqlite3-wasm has no
   * URI read-only open mode). Guards schema parity (client vs kernel `schema_version`) before `fn`.
   */
  attachKernel<T>(kernelDbPath: string, fn: () => T): T {
    this.db.run('ATTACH DATABASE ? AS kernel', kernelDbPath); // outside any transaction
    try {
      const parity = this.db.get(
        `SELECT (SELECT MAX(version) FROM main.schema_version)   AS client,
                (SELECT MAX(version) FROM kernel.schema_version) AS kernel`
      ) as { client: number; kernel: number };
      if (parity.client !== parity.kernel) {
        throw new Error(
          `Cross-area overlay: kernel index schema v${parity.kernel} != client schema v${parity.client}; re-index one.`
        );
      }
      // Engine-enforce the read-only invariant for the attach window: any INSERT/UPDATE/DELETE
      // on kernel.* (or main.*) inside fn now hard-errors, rather than relying on discipline.
      this.db.run('PRAGMA query_only = ON');
      return fn();
    } finally {
      try {
        this.db.run('PRAGMA query_only = OFF');
      } catch {
        // best-effort
      }
      try {
        this.db.run('DETACH DATABASE kernel');
      } catch {
        // best-effort: a failed fn can leave state that makes DETACH throw; don't mask the real error.
      }
    }
  }

  /**
   * Read-side rows for the cross-area ownership map (#62): every kernel HTTP `handled_by`
   * route (the classification is by the handler FQCN's namespace, so no join to
   * `kernel.structural_nodes` is needed), plus the client's own routes for the client-local
   * sweep. Runs under {@link attachKernel} (read-only, no writes on `kernel.*`).
   */
  crossAreaOwnership(kernelDbPath: string): {
    kernelRows: CrossAreaKernelRow[];
    clientRoutes: CrossAreaClientRoute[];
  } {
    return this.attachKernel(kernelDbPath, () => {
      // One row per kernel route (GROUP BY dedups a route with >1 handled_by edge; MIN makes
      // the chosen handler deterministic). client_handler is a deterministic correlated subquery
      // (ORDER BY … LIMIT 1) rather than a LEFT JOIN, so a client with >1 handler for a route
      // cannot fan the kernel row out or pick a handler non-deterministically.
      const kernelRows = this.db.all(
        `SELECT ke.route,
                ke.kernel_handler,
                cn.id AS client_node,
                (SELECT ce.target_node_id FROM main.structural_edges ce
                  WHERE ce.source_node_id = ke.route AND ce.edge_type = 'handled_by'
                  ORDER BY ce.target_node_id LIMIT 1) AS client_handler
           FROM (SELECT source_node_id AS route, MIN(target_node_id) AS kernel_handler
                   FROM kernel.structural_edges
                  WHERE edge_type = 'handled_by' AND source_node_id LIKE 'surface:http:%'
                  GROUP BY source_node_id) ke
           LEFT JOIN main.structural_nodes cn ON cn.id = ke.kernel_handler`
      ) as CrossAreaKernelRow[];
      const clientRoutes = this.db.all(
        `SELECT source_node_id AS route, MIN(target_node_id) AS handler
           FROM main.structural_edges
          WHERE edge_type = 'handled_by' AND source_node_id LIKE 'surface:http:%'
          GROUP BY source_node_id`
      ) as CrossAreaClientRoute[];
      return { kernelRows, clientRoutes };
    });
  }

  /**
   * Run `fn` with a sibling `.lux` index ATTACHed read-only under `alias` (Phase 4 baseline diff,
   * Decision 9). Mirrors attachKernel: ATTACH outside any transaction, schema-parity guard,
   * `PRAGMA query_only = ON` window (engine-enforced read-only for both DBs), DETACH in `finally`.
   * The alias is validated as a SQL identifier (it cannot be a bound parameter in `ATTACH … AS`).
   */
  attachSibling<T>(dbPath: string, alias: string, fn: () => T): T {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias)) {
      throw new Error(`attachSibling: unsafe alias ${JSON.stringify(alias)}`);
    }
    this.db.run(`ATTACH DATABASE ? AS ${alias}`, dbPath); // outside any transaction
    try {
      const parity = this.db.get(
        `SELECT (SELECT MAX(version) FROM main.schema_version)    AS main,
                (SELECT MAX(version) FROM ${alias}.schema_version) AS sibling`
      ) as { main: number; sibling: number };
      if (parity.main !== parity.sibling) {
        throw new Error(
          `attachSibling(${alias}): schema v${parity.sibling} != main v${parity.main}; ` +
            `re-index the baseline at the current schema (cache key is (base SHA, schema_version)).`
        );
      }
      this.db.run('PRAGMA query_only = ON');
      return fn();
    } finally {
      try {
        this.db.run('PRAGMA query_only = OFF');
      } catch {
        /* best-effort */
      }
      try {
        this.db.run(`DETACH DATABASE ${alias}`);
      } catch {
        /* best-effort */
      }
    }
  }

  /**
   * Structural diff of the primary (head) overlay against a baseline `.lux` ATTACHed read-only
   * (Phase 4). Returns surfaces added/removed by id, plus the raw new edges (present at head,
   * absent in baseline) with source/target file paths — module resolution happens in the caller
   * (which has corpusPath + boundary patterns). Runs entirely in-engine under attachSibling.
   */
  baselineStructuralDiff(baselineDbPath: string): {
    surfacesRemoved: string[];
    surfacesAdded: string[];
    newEdges: Array<{
      source: string;
      target: string;
      edgeType: string;
      sourceFile: string;
      targetFile: string;
    }>;
  } {
    return this.attachSibling(baselineDbPath, 'baseline', () => {
      const surfacesRemoved = (
        this.db.all(
          `SELECT b.id FROM baseline.structural_nodes b
             LEFT JOIN main.structural_nodes h ON h.id = b.id
            WHERE (b.node_type = 'capability-surface' OR b.id LIKE 'surface:http:%')
              AND h.id IS NULL`
        ) as Array<{ id: string }>
      ).map((r) => r.id);
      const surfacesAdded = (
        this.db.all(
          `SELECT h.id FROM main.structural_nodes h
             LEFT JOIN baseline.structural_nodes b ON b.id = h.id
            WHERE (h.node_type = 'capability-surface' OR h.id LIKE 'surface:http:%')
              AND b.id IS NULL`
        ) as Array<{ id: string }>
      ).map((r) => r.id);
      const newEdges = this.db.all(
        `SELECT he.source_node_id AS source, he.target_node_id AS target, he.edge_type AS edgeType,
                sn.file_path AS sourceFile, tn.file_path AS targetFile
           FROM main.structural_edges he
           LEFT JOIN baseline.structural_edges be
             ON be.source_node_id = he.source_node_id
            AND be.target_node_id = he.target_node_id
            AND be.edge_type = he.edge_type
           LEFT JOIN main.structural_nodes sn ON sn.id = he.source_node_id
           LEFT JOIN main.structural_nodes tn ON tn.id = he.target_node_id
          WHERE be.id IS NULL AND sn.file_path IS NOT NULL AND tn.file_path IS NOT NULL`
      ) as Array<{
        source: string;
        target: string;
        edgeType: string;
        sourceFile: string;
        targetFile: string;
      }>;
      return { surfacesRemoved, surfacesAdded, newEdges };
    });
  }

  // ── delta touch-set + reverse walk: dynamic-IN queries over indexed columns (Decision 3 /
  //    Phase 2a). A variadic IN(...) can't be a fixed prepared statement — use the one-shot
  //    db.all path with generated placeholders + chunking (mirrors crossAreaOwnership). ──

  /** Well under SQLite's variable limit (999 legacy / 32766 modern) — chunk large branch diffs. */
  private static readonly DELTA_IN_CHUNK = 500;

  private static deltaPlaceholders(n: number): string {
    return new Array(n).fill('?').join(',');
  }

  /**
   * Run a placeholder-`IN` SELECT across chunked values, unioning the rows with a cross-chunk
   * DISTINCT (a per-chunk `JOIN … DISTINCT` only dedups within one chunk). The dedup key defaults
   * to `row.id`; callers whose row identity is composite (e.g. boundary × symbol) pass their own
   * key so a legitimately repeated row is not over-deduped. A row with no key (falsy) is not
   * deduped.
   */
  private deltaChunkedIn<T>(
    values: string[],
    sql: (placeholders: string) => string,
    key?: (row: T) => string
  ): T[] {
    const out: T[] = [];
    const seen = new Set<string>();
    const keyOf = key ?? ((r: T) => (r as { id?: string }).id ?? '');
    for (let i = 0; i < values.length; i += LuxDatabase.DELTA_IN_CHUNK) {
      const chunk = values.slice(i, i + LuxDatabase.DELTA_IN_CHUNK);
      if (chunk.length === 0) continue;
      const rows = this.db.all(sql(LuxDatabase.deltaPlaceholders(chunk.length)), chunk) as T[];
      for (const r of rows) {
        const k = keyOf(r);
        if (k) {
          if (seen.has(k)) continue;
          seen.add(k);
        }
        out.push(r);
      }
    }
    return out;
  }

  /** structural_nodes (files + symbols declared in changed files) for the given rel paths. */
  getStructuralNodesForFilePaths(relPaths: string[]): StructuralNode[] {
    return this.deltaChunkedIn<StructuralNode>(
      relPaths,
      (ph) => `SELECT * FROM structural_nodes WHERE file_path IN (${ph})`
    );
  }

  /** DISTINCT structural_edges whose recorded evidence cites any changed file (invalidation set). */
  getEvidenceEdgesForFilePaths(relPaths: string[]): StructuralEdge[] {
    return this.deltaChunkedIn<StructuralEdge>(
      relPaths,
      (ph) =>
        `SELECT DISTINCT e.* FROM edge_evidence ev
           JOIN structural_edges e ON e.id = ev.edge_id
          WHERE ev.file_path IN (${ph})`
    );
  }

  /** operational_boundaries declared in any changed file. */
  getOperationalBoundariesForFilePaths(relPaths: string[]): OperationalBoundary[] {
    return this.deltaChunkedIn<OperationalBoundary>(
      relPaths,
      (ph) => `SELECT * FROM operational_boundaries WHERE file_path IN (${ph})`
    );
  }

  /**
   * operational_boundaries reachable from the given symbols via operational_handlers.symbol_id
   * (Phase 2b — the operational graph is separate from structural_edges; this is the only bridge).
   * Carries the matched symbol_id so callers can attribute the reach + async-boundary annotation.
   */
  getOperationalBoundariesForSymbols(
    symbolIds: string[]
  ): Array<OperationalBoundary & { symbol_id: string }> {
    return this.deltaChunkedIn<OperationalBoundary & { symbol_id: string }>(
      symbolIds,
      (ph) =>
        `SELECT DISTINCT b.id, b.repo_root, b.kind, b.name, b.trust_tier, b.file_path, h.symbol_id
           FROM operational_handlers h
           JOIN operational_boundaries b ON b.id = h.boundary_id
          WHERE h.symbol_id IN (${ph})`,
      (r) => `${r.id}::${r.symbol_id}` // identity is (boundary, symbol) — keep every pairing
    );
  }

  /**
   * Single-index ownership labels (E1) for `handled_by` edges targeting any touched handler
   * symbol. `ownership` is the column added by migration 013 (NULL unless a first-party pass ran).
   */
  getHandlerOwnershipForSymbols(
    symbolIds: string[]
  ): Array<{ route: string; handler: string; ownership: string | null }> {
    return this.deltaChunkedIn<{ route: string; handler: string; ownership: string | null }>(
      symbolIds,
      (ph) =>
        `SELECT source_node_id AS route, target_node_id AS handler, ownership
           FROM structural_edges
          WHERE edge_type = 'handled_by' AND target_node_id IN (${ph})`
    );
  }

  /** Incoming structural edges (target_node_id = nodeId), confidence-ordered — the reverse walk
   *  frontier (Phase 2a). Wraps the existing prepared `getStructuralEdgesForTargetNode`
   *  (`queries.ts:300-302`), which had no public wrapper.
   *
   *  With `bound`, the frontier is filtered and capped IN SQL: only the given edge types and
   *  confidence classes, `ORDER BY confidence DESC LIMIT bound.limit`. This stops a hub node from
   *  materializing its whole in-degree into JS before the caller's fanout cap. The filter lives in
   *  SQL (not JS-after) so the LIMIT applies to the *qualifying* set — a burst of higher-confidence
   *  non-matching edges can never crowd the real reverse edges out of the window. Callers pass
   *  `maxFanout + 1` so their `length > maxFanout` truncation test still fires. */
  getIncomingStructuralEdges(
    nodeId: string,
    bound?: { edgeTypes: readonly string[]; confidenceClasses: readonly string[]; limit: number }
  ): StructuralEdge[] {
    if (!bound) {
      return this.getQueries().getStructuralEdgesForTargetNode.all(nodeId) as StructuralEdge[];
    }
    if (bound.edgeTypes.length === 0 || bound.confidenceClasses.length === 0) return [];
    const etPh = LuxDatabase.deltaPlaceholders(bound.edgeTypes.length);
    const ccPh = LuxDatabase.deltaPlaceholders(bound.confidenceClasses.length);
    return this.db.all(
      `SELECT * FROM structural_edges
         WHERE target_node_id = ?
           AND edge_type IN (${etPh})
           AND confidence_class IN (${ccPh})
         ORDER BY confidence DESC
         LIMIT ?`,
      [nodeId, ...bound.edgeTypes, ...bound.confidenceClasses, bound.limit]
    ) as StructuralEdge[];
  }

  /** Explicitly initialize the read-query layer — Decision 14: `autoMigrate=false` skips it.
   *  ⚠️ Must be called only AFTER `isSchemaUpToDate()` confirms the schema is current: the wrapped
   *  `initQueries()` constructs `PreparedQueries`, which eagerly `db.prepare(...)`s ~65 statements
   *  against current-schema tables/columns; on a stale index (missing migration 011/013 objects)
   *  those prepares throw. `openDeltaDatabase` (spec 10 Part B) enforces this ordering. */
  initReadQueries(): void {
    this.initQueries();
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
   * Mark stale every `fresh` edge whose recorded EVIDENCE cites any of the given changed paths —
   * the write-side sibling of getEvidenceEdgesForFilePaths (db/index.ts:607-616), reusing the same
   * chunked IN over idx_edge_evidence_file_path. Closes the node-path-only gap (Decision 3): a
   * handled_by edge whose endpoints are untouched but whose evidence line sits in a changed routes
   * file is invalidated here. Returns the number of edges newly marked stale.
   */
  markEdgesStaleByEvidencePaths(filePaths: string[]): number {
    if (filePaths.length === 0) return 0;
    let total = 0;
    for (let i = 0; i < filePaths.length; i += LuxDatabase.DELTA_IN_CHUNK) {
      const chunk = filePaths.slice(i, i + LuxDatabase.DELTA_IN_CHUNK);
      if (chunk.length === 0) continue;
      const ph = LuxDatabase.deltaPlaceholders(chunk.length);
      const info = this.db.run(
        `UPDATE structural_edges SET freshness_status = 'stale', updated_at = unixepoch()
          WHERE freshness_status = 'fresh'
            AND id IN (SELECT DISTINCT ev.edge_id FROM edge_evidence ev
                        WHERE ev.file_path IN (${ph}))`,
        chunk
      );
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

  /** Repo-relative files touched by any `stale` structural edge (node-path OR evidence dimension).
   *  Read-only. The base-honesty dimension `lux delta` consults so a pointer advanced past an
   *  unrepaired overlay does not read as "nothing changed" (OQ4 / Decision 11). */
  getFilePathsWithStaleEdges(): string[] {
    return (this.getQueries().getStaleOverlayFilePaths.all() as Array<{ file_path: string }>).map(
      (r) => r.file_path
    );
  }

  /** Maintained freshness status for a set of structural-edge ids (read-only). Backs the
   *  stale-aware consumer annotations (Decision 4 / SC-4): a consumer holds the ids of the edges
   *  backing its result and asks what the marks already say — it never mutates freshness. Chunked
   *  over the same DELTA_IN_CHUNK machinery as the delta touch-set queries. */
  getEdgeFreshnessByIds(edgeIds: string[]): Array<Pick<StructuralEdge, 'id' | 'freshness_status'>> {
    return this.deltaChunkedIn<Pick<StructuralEdge, 'id' | 'freshness_status'>>(
      edgeIds,
      (ph) => `SELECT id, freshness_status FROM structural_edges WHERE id IN (${ph})`
    );
  }

  /** Aggregate structural-edge counts by maintained freshness status. Rides
   *  idx_structural_edges_freshness (008:38). Reports the four first-class buckets
   *  (fresh / dirty-dependent / stale / unknown — the schema-008 default); `other`
   *  catches any TRULY unrecognized status (expected 0 — a regression sentinel).
   *  `unknown` is a legitimate state (vendor-pack edges default to it), so it is
   *  classified explicitly and never folded into the `other` sentinel. */
  countEdgesByFreshness(): EdgeFreshnessCounts {
    const rows = this.getQueries().getEdgeFreshnessCounts.all() as Array<{
      status: string;
      n: number;
    }>;
    const counts: EdgeFreshnessCounts = {
      fresh: 0,
      'dirty-dependent': 0,
      stale: 0,
      unknown: 0,
      other: 0,
    };
    for (const row of rows) {
      if (
        row.status === 'fresh' ||
        row.status === 'dirty-dependent' ||
        row.status === 'stale' ||
        row.status === 'unknown'
      ) {
        counts[row.status] = row.n;
      } else {
        counts.other += row.n;
      }
    }
    return counts;
  }

  // ── Scoped overlay-refresh helpers (Phase 3a / spec 13 Part A) ────────────────
  //    All on the shipped deltaChunkedIn / deltaPlaceholders / this.db.run layer. Evidence rows
  //    are removed with the edges (no FK cascade on edge_evidence in the schema).

  /** Delete structural_nodes (file/symbol/surface) declared in any of the given rel paths. */
  deleteStructuralNodesForFiles(relPaths: string[]): number {
    let total = 0;
    for (let i = 0; i < relPaths.length; i += LuxDatabase.DELTA_IN_CHUNK) {
      const chunk = relPaths.slice(i, i + LuxDatabase.DELTA_IN_CHUNK);
      if (chunk.length === 0) continue;
      const ph = LuxDatabase.deltaPlaceholders(chunk.length);
      total += this.db.run(
        `DELETE FROM structural_nodes WHERE file_path IN (${ph})`,
        chunk
      ).changes;
    }
    return total;
  }

  /** Delete edges whose SOURCE node is in nodeIds (R's outbound edges) + their evidence. With
   *  `keepLsp`, edges whose id ends ':lsp' (typed-receiver) are preserved so the caller can mark
   *  them stale when the LSP tier is skipped (Decision 8). */
  deleteEdgesBySourceNodes(nodeIds: string[], opts?: { keepLsp?: boolean }): number {
    const guard = opts?.keepLsp ? " AND id NOT LIKE '%:lsp'" : '';
    let total = 0;
    for (let i = 0; i < nodeIds.length; i += LuxDatabase.DELTA_IN_CHUNK) {
      const chunk = nodeIds.slice(i, i + LuxDatabase.DELTA_IN_CHUNK);
      if (chunk.length === 0) continue;
      const ph = LuxDatabase.deltaPlaceholders(chunk.length);
      this.db.run(
        `DELETE FROM edge_evidence WHERE edge_id IN
           (SELECT id FROM structural_edges WHERE source_node_id IN (${ph})${guard})`,
        chunk
      );
      total += this.db.run(
        `DELETE FROM structural_edges WHERE source_node_id IN (${ph})${guard}`,
        chunk
      ).changes;
    }
    return total;
  }

  /** Delete edges whose recorded EVIDENCE cites any of relPaths (source-side cross-file edges) +
   *  their evidence. An inbound edge C→A (A∈R, C∉R) cites C, so it is NOT matched — inbound edges
   *  from outside R are preserved (Decision 5). `keepLsp` as above. */
  deleteEdgesByEvidencePaths(relPaths: string[], opts?: { keepLsp?: boolean }): number {
    const guard = opts?.keepLsp ? " AND se.id NOT LIKE '%:lsp'" : '';
    let total = 0;
    for (let i = 0; i < relPaths.length; i += LuxDatabase.DELTA_IN_CHUNK) {
      const chunk = relPaths.slice(i, i + LuxDatabase.DELTA_IN_CHUNK);
      if (chunk.length === 0) continue;
      const ph = LuxDatabase.deltaPlaceholders(chunk.length);
      const edgeIds = (
        this.db.all(
          `SELECT DISTINCT se.id AS id FROM structural_edges se
             JOIN edge_evidence ev ON ev.edge_id = se.id
            WHERE ev.file_path IN (${ph})${guard}`,
          chunk
        ) as Array<{ id: string }>
      ).map((r) => r.id);
      total += this.deleteEdgesByIds(edgeIds);
    }
    return total;
  }

  /** Delete a set of edges by id + their evidence. */
  private deleteEdgesByIds(edgeIds: string[]): number {
    let total = 0;
    for (let i = 0; i < edgeIds.length; i += LuxDatabase.DELTA_IN_CHUNK) {
      const chunk = edgeIds.slice(i, i + LuxDatabase.DELTA_IN_CHUNK);
      if (chunk.length === 0) continue;
      const ph = LuxDatabase.deltaPlaceholders(chunk.length);
      this.db.run(`DELETE FROM edge_evidence WHERE edge_id IN (${ph})`, chunk);
      total += this.db.run(`DELETE FROM structural_edges WHERE id IN (${ph})`, chunk).changes;
    }
    return total;
  }

  /** Mark stale the ':lsp' (typed-receiver) edges whose source node is in nodeIds — the residual
   *  when the LSP tier is skipped under budget (Decision 8 / spec 14's LSP-skipped fixture).
   *
   *  Promotes both `fresh` and `dirty-dependent`: the scoped refresh's step-1 fence transiently
   *  marks R's edges `dirty-dependent` before this runs, so a `fresh`-only guard would leave the
   *  kept :lsp residual `dirty-dependent` and out of `residualStaleEdges` (SC-9). A skipped :lsp
   *  edge of a changed file is definitively stale until the LSP tier re-verifies it. */
  markEdgesStaleLspBySourceNodes(nodeIds: string[]): number {
    let total = 0;
    for (let i = 0; i < nodeIds.length; i += LuxDatabase.DELTA_IN_CHUNK) {
      const chunk = nodeIds.slice(i, i + LuxDatabase.DELTA_IN_CHUNK);
      if (chunk.length === 0) continue;
      const ph = LuxDatabase.deltaPlaceholders(chunk.length);
      total += this.db.run(
        `UPDATE structural_edges SET freshness_status = 'stale', updated_at = unixepoch()
          WHERE freshness_status IN ('fresh', 'dirty-dependent')
            AND id LIKE '%:lsp' AND source_node_id IN (${ph})`,
        chunk
      ).changes;
    }
    return total;
  }

  /** Mark stale surviving edges whose TARGET is one of the given (removed) node ids — the
   *  orphaned-inbound residual (Decision 5): an unchanged caller's edge into a symbol that
   *  vanished on re-derivation. Never deleted — the claim about the caller is real.
   *
   *  Promotes both `fresh` and `dirty-dependent`: the scoped refresh's step-1 fence
   *  (invalidateEdgesForFiles is source-OR-target) transiently marks these inbound edges
   *  `dirty-dependent` before the clear, so a `fresh`-only guard could never reach the orphan.
   *  After a settle, any surviving edge into a removed symbol is definitively stale regardless of
   *  the transient fence state (an already-`stale` edge is left untouched). */
  markEdgesStaleByTargetNodes(nodeIds: string[]): number {
    let total = 0;
    for (let i = 0; i < nodeIds.length; i += LuxDatabase.DELTA_IN_CHUNK) {
      const chunk = nodeIds.slice(i, i + LuxDatabase.DELTA_IN_CHUNK);
      if (chunk.length === 0) continue;
      const ph = LuxDatabase.deltaPlaceholders(chunk.length);
      total += this.db.run(
        `UPDATE structural_edges SET freshness_status = 'stale', updated_at = unixepoch()
          WHERE freshness_status IN ('fresh', 'dirty-dependent') AND target_node_id IN (${ph})`,
        chunk
      ).changes;
    }
    return total;
  }

  /** Promote surviving inbound edges (dirty-dependent → fresh) whose TARGET is one of the given
   *  (surviving, re-materialized) node ids — the symmetric complement of markEdgesStaleByTargetNodes.
   *
   *  The step-1 fence marks EVERY edge touching R dirty-dependent (source OR target in R). The
   *  settle re-derives R's own outbound edges (fresh) and orphans inbound edges into REMOVED symbols
   *  (stale), but a surviving-target inbound edge C→A (A∈R survives, C∉R, not re-derived) is left
   *  untouched — it would stay dirty-dependent forever and drop out of the `fresh` slice, violating
   *  the equivalence contract (SC-7) that a full rebuild leaves C→A `fresh`. This restores it, so a
   *  complete refresh settles to ZERO residual dirty-dependent.
   *
   *  Only promotes `dirty-dependent`: a legitimately `stale` edge (orphaned target, or a skipped-LSP
   *  residual) is left stale; a re-derived edge is already `fresh` and is not matched. */
  markEdgesFreshByTargetNodes(nodeIds: string[]): number {
    let total = 0;
    for (let i = 0; i < nodeIds.length; i += LuxDatabase.DELTA_IN_CHUNK) {
      const chunk = nodeIds.slice(i, i + LuxDatabase.DELTA_IN_CHUNK);
      if (chunk.length === 0) continue;
      const ph = LuxDatabase.deltaPlaceholders(chunk.length);
      total += this.db.run(
        `UPDATE structural_edges SET freshness_status = 'fresh', updated_at = unixepoch()
          WHERE freshness_status = 'dirty-dependent' AND target_node_id IN (${ph})`,
        chunk
      ).changes;
    }
    return total;
  }

  /** Evidence-dimension dirty-dependent mark for the pre-repair fence (mirrors invalidateEdgesForFiles
   *  which is node-path only). Marks the victim set's evidence-cited edges dirty-dependent. */
  invalidateEdgesByEvidencePaths(relPaths: string[]): number {
    let total = 0;
    for (let i = 0; i < relPaths.length; i += LuxDatabase.DELTA_IN_CHUNK) {
      const chunk = relPaths.slice(i, i + LuxDatabase.DELTA_IN_CHUNK);
      if (chunk.length === 0) continue;
      const ph = LuxDatabase.deltaPlaceholders(chunk.length);
      total += this.db.run(
        `UPDATE structural_edges SET freshness_status = 'dirty-dependent', updated_at = unixepoch()
          WHERE freshness_status = 'fresh'
            AND id IN (SELECT DISTINCT ev.edge_id FROM edge_evidence ev WHERE ev.file_path IN (${ph}))`,
        chunk
      ).changes;
    }
    return total;
  }

  /** Delete operational rows (boundaries + their handlers/contracts/edges) declared in relPaths.
   *  Operational inserts are not idempotent, so R's operational slice is cleared before re-extraction. */
  deleteOperationalForFiles(relPaths: string[]): number {
    const boundaryIds = this.deltaChunkedIn<{ id: string }>(
      relPaths,
      (ph) => `SELECT id FROM operational_boundaries WHERE file_path IN (${ph})`
    ).map((r) => r.id);
    if (boundaryIds.length === 0) return 0;
    let removed = 0;
    for (let i = 0; i < boundaryIds.length; i += LuxDatabase.DELTA_IN_CHUNK) {
      const chunk = boundaryIds.slice(i, i + LuxDatabase.DELTA_IN_CHUNK);
      if (chunk.length === 0) continue;
      const ph = LuxDatabase.deltaPlaceholders(chunk.length);
      this.db.run(`DELETE FROM operational_handlers WHERE boundary_id IN (${ph})`, chunk);
      this.db.run(`DELETE FROM operational_contracts WHERE boundary_id IN (${ph})`, chunk);
      this.db.run(
        `DELETE FROM operational_edges WHERE source_id IN (${ph}) OR target_id IN (${ph})`,
        [...chunk, ...chunk]
      );
      removed += this.db.run(
        `DELETE FROM operational_boundaries WHERE id IN (${ph})`,
        chunk
      ).changes;
    }
    return removed;
  }

  /** Symbol node ids declared in the given files — reuses getStructuralNodesForFilePaths (Decision 14
   *  growth gate + orphan detection). */
  getSymbolNodeIdsForFiles(relPaths: string[]): string[] {
    return this.getStructuralNodesForFilePaths(relPaths)
      .filter((n) => n.node_type === 'symbol')
      .map((n) => n.id);
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
