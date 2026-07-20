import type Database from 'better-sqlite3';

/**
 * Prepared statements for the Lux database.
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
  readonly clearStructuralNodes: Database.Statement;
  readonly clearStructuralEdges: Database.Statement;
  readonly clearEdgeEvidence: Database.Statement;
  readonly clearOperationalBoundaries: Database.Statement;
  readonly clearOperationalHandlers: Database.Statement;
  readonly clearOperationalEdges: Database.Statement;
  readonly clearOperationalContracts: Database.Statement;

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

  // Index metadata queries
  readonly getIndexMetadata: Database.Statement;
  readonly setIndexMetadata: Database.Statement;
  readonly deleteIndexMetadata: Database.Statement;

  // Delete knowledge entry by path
  readonly deleteKnowledgeEntryByPath: Database.Statement;

  // Module dependency queries
  readonly insertModuleDependency: Database.Statement;
  readonly getModuleDependenciesBySource: Database.Statement;
  readonly getModuleDependenciesByTarget: Database.Statement;
  readonly getAllModuleDependencies: Database.Statement;
  readonly getModuleDependency: Database.Statement;
  readonly clearModuleDependencies: Database.Statement;
  readonly getDistinctModules: Database.Statement;

  // Structural overlay queries — nodes
  readonly upsertStructuralNode: Database.Statement;
  readonly getStructuralNode: Database.Statement;
  readonly getStructuralNodesByType: Database.Statement;
  readonly getLocalStructuralNodesByType: Database.Statement;
  readonly findStructuralSymbolNodes: Database.Statement;
  readonly getStructuralNodeByFilePath: Database.Statement;

  // Structural overlay queries — edges
  readonly upsertStructuralEdge: Database.Statement;
  readonly getStructuralEdge: Database.Statement;
  readonly getStructuralEdgesForSourceNode: Database.Statement;
  readonly getStructuralEdgesForTargetNode: Database.Statement;
  readonly getStructuralEdgesForNode: Database.Statement;
  readonly invalidateEdgesForFile: Database.Statement;
  readonly markEdgesStaleForFile: Database.Statement;
  readonly markEdgesStaleByCommit: Database.Statement;

  // Structural overlay queries — evidence
  readonly insertEdgeEvidence: Database.Statement;
  readonly deleteEdgeEvidence: Database.Statement;
  readonly getEdgeEvidence: Database.Statement;
  readonly getEdgeEvidenceByResolver: Database.Statement;

  // Capability-surface queries
  readonly getCapabilitySurfaces: Database.Statement;
  readonly searchSurfacesByHandle: Database.Statement;

  // Operational boundary queries
  readonly upsertOperationalBoundary: Database.Statement;
  readonly getOperationalBoundary: Database.Statement;
  readonly getOperationalBoundariesByKind: Database.Statement;
  readonly getOperationalBoundariesByRepoRoot: Database.Statement;
  readonly upsertOperationalHandler: Database.Statement;
  readonly getOperationalHandlersForBoundary: Database.Statement;
  readonly upsertOperationalEdge: Database.Statement;
  readonly getOperationalEdgesForSource: Database.Statement;
  readonly getOperationalEdgesForTarget: Database.Statement;
  readonly upsertOperationalContract: Database.Statement;
  readonly getOperationalContractsForBoundary: Database.Statement;

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
    this.clearEdgeEvidence = db.prepare(`DELETE FROM edge_evidence`);
    this.clearStructuralEdges = db.prepare(`DELETE FROM structural_edges`);
    this.clearStructuralNodes = db.prepare(`DELETE FROM structural_nodes`);
    this.clearOperationalContracts = db.prepare(`DELETE FROM operational_contracts`);
    this.clearOperationalEdges = db.prepare(`DELETE FROM operational_edges`);
    this.clearOperationalHandlers = db.prepare(`DELETE FROM operational_handlers`);
    this.clearOperationalBoundaries = db.prepare(`DELETE FROM operational_boundaries`);

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
      INSERT INTO experts (
        slug,
        name,
        mount_path,
        model,
        backend,
        provider,
        thinking,
        claude_md_path,
        memory_path,
        status,
        boundary_basis,
        structural_signature,
        structural_rationale
      )
      VALUES (
        @slug,
        @name,
        @mount_path,
        @model,
        @backend,
        @provider,
        @thinking,
        @claude_md_path,
        @memory_path,
        @status,
        @boundary_basis,
        @structural_signature,
        @structural_rationale
      )
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
        backend = COALESCE(@backend, backend),
        provider = COALESCE(@provider, provider),
        thinking = COALESCE(@thinking, thinking),
        claude_md_path = COALESCE(@claude_md_path, claude_md_path),
        memory_path = COALESCE(@memory_path, memory_path),
        status = COALESCE(@status, status),
        boundary_basis = COALESCE(@boundary_basis, boundary_basis),
        structural_signature = COALESCE(@structural_signature, structural_signature),
        structural_rationale = COALESCE(@structural_rationale, structural_rationale),
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

    // Index metadata queries
    this.getIndexMetadata = db.prepare(`
      SELECT value FROM index_metadata WHERE key = ?
    `);

    this.setIndexMetadata = db.prepare(`
      INSERT INTO index_metadata (key, value, updated_at)
      VALUES (@key, @value, unixepoch())
      ON CONFLICT(key) DO UPDATE SET value = @value, updated_at = unixepoch()
    `);

    this.deleteIndexMetadata = db.prepare(`
      DELETE FROM index_metadata WHERE key = ?
    `);

    // Delete knowledge entry by file path
    this.deleteKnowledgeEntryByPath = db.prepare(`
      DELETE FROM knowledge_entries WHERE file_path = ?
    `);

    // Module dependency queries
    this.insertModuleDependency = db.prepare(`
      INSERT OR REPLACE INTO module_dependencies (source_module, target_module, reference_count, sample_files)
      VALUES (@source_module, @target_module, @reference_count, @sample_files)
    `);

    this.getModuleDependenciesBySource = db.prepare(`
      SELECT * FROM module_dependencies WHERE source_module = ? ORDER BY reference_count DESC
    `);

    this.getModuleDependenciesByTarget = db.prepare(`
      SELECT * FROM module_dependencies WHERE target_module = ? ORDER BY reference_count DESC
    `);

    this.getAllModuleDependencies = db.prepare(`
      SELECT * FROM module_dependencies ORDER BY reference_count DESC
    `);

    this.getModuleDependency = db.prepare(`
      SELECT * FROM module_dependencies WHERE source_module = ? AND target_module = ?
    `);

    this.clearModuleDependencies = db.prepare(`DELETE FROM module_dependencies`);

    this.getDistinctModules = db.prepare(`
      SELECT DISTINCT module FROM (
        SELECT source_module AS module FROM module_dependencies
        UNION
        SELECT target_module AS module FROM module_dependencies
      ) ORDER BY module
    `);

    // Structural overlay — node queries
    this.upsertStructuralNode = db.prepare(`
      INSERT INTO structural_nodes (id, node_type, file_path, language_id, symbol_name, symbol_kind, qualified_name, metadata, origin, updated_at)
      VALUES (@id, @node_type, @file_path, @language_id, @symbol_name, @symbol_kind, @qualified_name, @metadata, @origin, @updated_at)
      ON CONFLICT(id) DO UPDATE SET
        node_type = excluded.node_type,
        file_path = excluded.file_path,
        language_id = excluded.language_id,
        symbol_name = excluded.symbol_name,
        symbol_kind = excluded.symbol_kind,
        qualified_name = excluded.qualified_name,
        metadata = excluded.metadata,
        origin = excluded.origin,
        updated_at = excluded.updated_at
    `);

    this.getStructuralNode = db.prepare(`
      SELECT * FROM structural_nodes WHERE id = ?
    `);

    this.getStructuralNodesByType = db.prepare(`
      SELECT * FROM structural_nodes WHERE node_type = ? ORDER BY updated_at DESC
    `);

    // origin='local' only — excludes merged vendor-pack nodes (ADR-3 / REQ-7).
    this.getLocalStructuralNodesByType = db.prepare(`
      SELECT * FROM structural_nodes
      WHERE node_type = ? AND origin = 'local'
      ORDER BY updated_at DESC
    `);

    // Resolve a user-supplied symbol to structural symbol nodes for a trace start
    // (ADR-5). Exact id / qualified_name / symbol_name wins; app (local) nodes
    // rank above vendor-pack nodes so `lux trace Foo::bar` picks authored code.
    this.findStructuralSymbolNodes = db.prepare(`
      SELECT * FROM structural_nodes
      WHERE node_type = 'symbol'
        AND (id = @term OR qualified_name = @term OR symbol_name = @term
             OR qualified_name LIKE @suffix OR symbol_name = @leaf)
      ORDER BY
        (id = @term OR qualified_name = @term) DESC,
        (origin = 'local') DESC,
        updated_at DESC
      LIMIT @limit
    `);

    this.getStructuralNodeByFilePath = db.prepare(`
      SELECT * FROM structural_nodes WHERE file_path = ? ORDER BY node_type
    `);

    // Structural overlay — edge queries
    this.upsertStructuralEdge = db.prepare(`
      INSERT INTO structural_edges (id, source_node_id, target_node_id, edge_type, confidence, confidence_class, freshness_status, source_commit, dirty_dependency_count, provenance_summary, updated_at)
      VALUES (@id, @source_node_id, @target_node_id, @edge_type, @confidence, @confidence_class, @freshness_status, @source_commit, @dirty_dependency_count, @provenance_summary, @updated_at)
      ON CONFLICT(id) DO UPDATE SET
        source_node_id = excluded.source_node_id,
        target_node_id = excluded.target_node_id,
        edge_type = excluded.edge_type,
        confidence = excluded.confidence,
        confidence_class = excluded.confidence_class,
        freshness_status = excluded.freshness_status,
        source_commit = excluded.source_commit,
        dirty_dependency_count = excluded.dirty_dependency_count,
        provenance_summary = excluded.provenance_summary,
        updated_at = excluded.updated_at
    `);

    this.getStructuralEdge = db.prepare(`
      SELECT * FROM structural_edges WHERE id = ?
    `);

    this.getStructuralEdgesForSourceNode = db.prepare(`
      SELECT * FROM structural_edges WHERE source_node_id = ? ORDER BY confidence DESC
    `);

    this.getStructuralEdgesForTargetNode = db.prepare(`
      SELECT * FROM structural_edges WHERE target_node_id = ? ORDER BY confidence DESC
    `);

    this.getStructuralEdgesForNode = db.prepare(`
      SELECT * FROM structural_edges
      WHERE source_node_id = ? OR target_node_id = ?
      ORDER BY confidence DESC
    `);

    this.invalidateEdgesForFile = db.prepare(`
      UPDATE structural_edges SET freshness_status = 'dirty-dependent', updated_at = unixepoch()
      WHERE id IN (
        SELECT se.id FROM structural_edges se
        JOIN structural_nodes sn ON se.source_node_id = sn.id OR se.target_node_id = sn.id
        WHERE sn.file_path = ?
      )
    `);

    this.markEdgesStaleForFile = db.prepare(`
      UPDATE structural_edges SET freshness_status = 'stale', updated_at = unixepoch()
      WHERE id IN (
        SELECT se.id FROM structural_edges se
        JOIN structural_nodes sn ON se.source_node_id = sn.id OR se.target_node_id = sn.id
        WHERE sn.file_path = ?
      )
    `);

    this.markEdgesStaleByCommit = db.prepare(`
      UPDATE structural_edges
      SET freshness_status = 'stale', updated_at = unixepoch()
      WHERE freshness_status = 'fresh'
        AND source_commit IS NOT NULL
        AND source_commit != ?
    `);

    // Structural overlay — evidence queries
    this.insertEdgeEvidence = db.prepare(`
      INSERT INTO edge_evidence (id, edge_id, resolver, evidence_kind, file_path, line, note, payload_json, recorded_at)
      VALUES (@id, @edge_id, @resolver, @evidence_kind, @file_path, @line, @note, @payload_json, @recorded_at)
    `);

    this.deleteEdgeEvidence = db.prepare(`
      DELETE FROM edge_evidence WHERE edge_id = ?
    `);

    this.getEdgeEvidence = db.prepare(`
      SELECT * FROM edge_evidence WHERE edge_id = ? ORDER BY recorded_at ASC
    `);

    this.getEdgeEvidenceByResolver = db.prepare(`
      SELECT * FROM edge_evidence WHERE edge_id = ? AND resolver = ? ORDER BY recorded_at ASC
    `);

    // Capability-surface queries
    this.getCapabilitySurfaces = db.prepare(`
      SELECT * FROM structural_nodes WHERE node_type = 'capability-surface' ORDER BY updated_at DESC
    `);

    // Search surfaces by symbol_name (canonical handle) prefix or exact match
    this.searchSurfacesByHandle = db.prepare(`
      SELECT * FROM structural_nodes
      WHERE node_type = 'capability-surface'
        AND symbol_name LIKE ?
      ORDER BY updated_at DESC
    `);

    // Operational boundary queries
    this.upsertOperationalBoundary = db.prepare(`
      INSERT INTO operational_boundaries (id, repo_root, kind, name, trust_tier, file_path)
      VALUES (@id, @repo_root, @kind, @name, @trust_tier, @file_path)
      ON CONFLICT(id) DO UPDATE SET
        repo_root = excluded.repo_root,
        kind = excluded.kind,
        name = excluded.name,
        trust_tier = excluded.trust_tier,
        file_path = excluded.file_path
    `);

    this.getOperationalBoundary = db.prepare(`
      SELECT * FROM operational_boundaries WHERE id = ?
    `);

    this.getOperationalBoundariesByKind = db.prepare(`
      SELECT * FROM operational_boundaries WHERE kind = ? ORDER BY name ASC
    `);

    this.getOperationalBoundariesByRepoRoot = db.prepare(`
      SELECT * FROM operational_boundaries WHERE repo_root = ? ORDER BY kind ASC, name ASC
    `);

    this.upsertOperationalHandler = db.prepare(`
      INSERT INTO operational_handlers (id, boundary_id, symbol_id, trust_tier)
      VALUES (@id, @boundary_id, @symbol_id, @trust_tier)
      ON CONFLICT(id) DO UPDATE SET
        boundary_id = excluded.boundary_id,
        symbol_id = excluded.symbol_id,
        trust_tier = excluded.trust_tier
    `);

    this.getOperationalHandlersForBoundary = db.prepare(`
      SELECT * FROM operational_handlers WHERE boundary_id = ? ORDER BY symbol_id ASC
    `);

    this.upsertOperationalEdge = db.prepare(`
      INSERT INTO operational_edges (id, source_id, target_id, edge_type, transport, trust_tier)
      VALUES (@id, @source_id, @target_id, @edge_type, @transport, @trust_tier)
      ON CONFLICT(id) DO UPDATE SET
        source_id = excluded.source_id,
        target_id = excluded.target_id,
        edge_type = excluded.edge_type,
        transport = excluded.transport,
        trust_tier = excluded.trust_tier
    `);

    this.getOperationalEdgesForSource = db.prepare(`
      SELECT * FROM operational_edges WHERE source_id = ? ORDER BY edge_type ASC, target_id ASC
    `);

    this.getOperationalEdgesForTarget = db.prepare(`
      SELECT * FROM operational_edges WHERE target_id = ? ORDER BY edge_type ASC, source_id ASC
    `);

    this.upsertOperationalContract = db.prepare(`
      INSERT INTO operational_contracts (id, boundary_id, payload_schema, trust_tier)
      VALUES (@id, @boundary_id, @payload_schema, @trust_tier)
      ON CONFLICT(id) DO UPDATE SET
        boundary_id = excluded.boundary_id,
        payload_schema = excluded.payload_schema,
        trust_tier = excluded.trust_tier
    `);

    this.getOperationalContractsForBoundary = db.prepare(`
      SELECT * FROM operational_contracts WHERE boundary_id = ? ORDER BY id ASC
    `);
  }
}
