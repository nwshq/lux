// Vendor pack on-disk format (ADR-1) — a self-contained, portable SQLite file
// holding the vendor structural graph, built once per dependency-set and merged
// into a project overlay every rebuild (see cache.ts + pack-builder.ts).
//
// The pack's tables MIRROR the project overlay exactly so the Phase-0 merge is a
// single in-engine `ATTACH … ; INSERT OR IGNORE INTO structural_nodes(<cols>)
// SELECT <cols> FROM pack.structural_nodes` (src/db/index.ts importVendorPack) —
// the ~800k rows never cross into JS. Concretely:
//   - `structural_nodes` carries the ADR-3 `origin` column (stamped 'vendor-pack'
//     at write); `structural_edges` carries NO origin column (an edge's
//     externality is derived from its endpoints, not a per-edge marker).
//   - No `edge_evidence` table: vendor edges carry their provenance inline in
//     `provenance_summary`, and the merge skips per-edge evidence (Phase-0 /
//     CANONICAL-DECISIONS §3–§4), so the pack never builds or stores it.
//   - `pack_meta` is a small JSON-per-key manifest read by `lux vendor-pack
//     status` and by the cache to validate a hit.

import { LuxSqlite } from '../../db/sqlite-adapter.js';
import { mkdirSync } from 'fs';
import { dirname } from 'path';
import type { StructuralNode, StructuralEdge } from '../../db/types.js';

/** Bump when the pack schema or the extraction contract changes incompatibly. */
export const PACK_FORMAT_VERSION = 1;

/** Origin marker stamped on every pack node row (ADR-3). */
export const VENDOR_PACK_ORIGIN = 'vendor-pack';

/** ADR-4 within-vendor resolution depth. */
export type VendorPackDepth = 'ast-only' | 'full-lsp';

/**
 * Pack schema — a column-exact mirror of the project overlay tables (migration
 * 008 + 012, nodes-only origin), so the merge's `INSERT … SELECT` needs no column
 * mapping. `structural_edges` intentionally omits `origin`; there is no
 * `edge_evidence` table.
 */
const PACK_SCHEMA = `
  CREATE TABLE IF NOT EXISTS pack_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS structural_nodes (
    id             TEXT PRIMARY KEY,
    node_type      TEXT NOT NULL,
    file_path      TEXT,
    language_id    TEXT,
    symbol_name    TEXT,
    symbol_kind    TEXT,
    qualified_name TEXT,
    metadata       TEXT,
    origin         TEXT NOT NULL DEFAULT 'vendor-pack',
    updated_at     INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS structural_edges (
    id                     TEXT PRIMARY KEY,
    source_node_id         TEXT NOT NULL,
    target_node_id         TEXT NOT NULL,
    edge_type              TEXT NOT NULL,
    confidence             REAL NOT NULL,
    confidence_class       TEXT NOT NULL,
    freshness_status       TEXT NOT NULL DEFAULT 'fresh',
    source_commit          TEXT,
    dirty_dependency_count INTEGER NOT NULL DEFAULT 0,
    provenance_summary     TEXT,
    updated_at             INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_structural_nodes_type ON structural_nodes(node_type);
  CREATE INDEX IF NOT EXISTS idx_structural_edges_source ON structural_edges(source_node_id);
  CREATE INDEX IF NOT EXISTS idx_structural_edges_target ON structural_edges(target_node_id);
`;

/**
 * Manifest describing what a pack contains and how it was keyed (cache.ts §key).
 * Stored one JSON value per key in `pack_meta`; read by `status` and by
 * `lookupPack` to validate a cache hit.
 */
export interface VendorPackManifest {
  /** Pack schema/extraction contract version (must equal PACK_FORMAT_VERSION to be usable). */
  formatVersion: number;
  /** Keying scheme used (cache.ts). */
  keyScheme: 'composer-lock' | 'per-package';
  /** Full hex digest that keys this pack (whole-lock sha256, or the per-package digest). */
  key: string;
  /** Framework label for humans (e.g. "laravel/framework@v11.54.0"), best-effort from composer.lock. */
  framework?: string;
  /** Within-vendor resolution depth this pack was built at (ADR-4). */
  depth: VendorPackDepth;
  /** Counts, for status + sanity checks. */
  nodeCount: number;
  edgeCount: number;
  /** Wall-clock build time (ms) and when it was built (epoch seconds). */
  buildDurationMs: number;
  builtAt: number;
  /** lux version that produced the pack. */
  luxVersion: string;
}

/**
 * Batched, transactional writer over a dedicated WASM-SQLite (`LuxSqlite`) handle.
 *
 * Uses `journal_mode=delete`, which leaves no `-wal`/`-journal` sidecar once the
 * transactions commit, so the resulting single `.db` is self-contained and safe for
 * the merge's read-only `ATTACH` (a leftover sidecar would let ATTACH read a partial DB).
 */
export class VendorPackWriter {
  private db: LuxSqlite;

  constructor(packPath: string) {
    mkdirSync(dirname(packPath), { recursive: true });
    this.db = new LuxSqlite(packPath);
    // journal_mode=delete: WASM SQLite has no WAL, and delete leaves no -wal sidecar,
    // so a bare copy of the file is self-contained (what the ATTACH merge relies on).
    this.db.pragma('journal_mode = delete');
    // NORMAL is safe for a rebuildable artifact.
    this.db.pragma('synchronous = NORMAL');
    this.db.exec(PACK_SCHEMA);
  }

  /**
   * Write nodes + edges in one transaction. Every node row is stamped
   * origin='vendor-pack' regardless of the in-memory value; edges carry no origin
   * column. `INSERT OR IGNORE` keeps the first row on any id collision (the
   * builder dedupes ids upstream, so this is a belt-and-braces guard).
   */
  write(nodes: StructuralNode[], edges: StructuralEdge[]): void {
    const insNode = this.db.prepare(`
      INSERT OR IGNORE INTO structural_nodes
        (id, node_type, file_path, language_id, symbol_name, symbol_kind, qualified_name, metadata, origin, updated_at)
      VALUES (@id, @node_type, @file_path, @language_id, @symbol_name, @symbol_kind, @qualified_name, @metadata, @origin, @updated_at)
    `);
    const insEdge = this.db.prepare(`
      INSERT OR IGNORE INTO structural_edges
        (id, source_node_id, target_node_id, edge_type, confidence, confidence_class, freshness_status, source_commit, dirty_dependency_count, provenance_summary, updated_at)
      VALUES (@id, @source_node_id, @target_node_id, @edge_type, @confidence, @confidence_class, @freshness_status, @source_commit, @dirty_dependency_count, @provenance_summary, @updated_at)
    `);

    const tx = this.db.transaction(() => {
      for (const n of nodes)
        insNode.run({
          id: n.id,
          node_type: n.node_type,
          file_path: n.file_path ?? null,
          language_id: n.language_id ?? null,
          symbol_name: n.symbol_name ?? null,
          symbol_kind: n.symbol_kind ?? null,
          qualified_name: n.qualified_name ?? null,
          metadata: n.metadata ?? null,
          origin: VENDOR_PACK_ORIGIN,
          updated_at: n.updated_at,
        });
      for (const e of edges)
        insEdge.run({
          id: e.id,
          source_node_id: e.source_node_id,
          target_node_id: e.target_node_id,
          edge_type: e.edge_type,
          confidence: e.confidence,
          confidence_class: e.confidence_class,
          freshness_status: e.freshness_status,
          source_commit: e.source_commit ?? null,
          dirty_dependency_count: e.dirty_dependency_count,
          provenance_summary: e.provenance_summary ?? null,
          updated_at: e.updated_at,
        });
    });
    tx();
  }

  /**
   * Persist the manifest (one row per field, JSON value), then close. Under
   * journal_mode=delete there is no WAL sidecar, so once the transactions commit the
   * single .db file is self-contained: re-openable read-only and ATTACH-able by the merge.
   */
  finalize(manifest: VendorPackManifest): void {
    const set = this.db.prepare(`INSERT OR REPLACE INTO pack_meta (key, value) VALUES (?, ?)`);
    const tx = this.db.transaction(() => {
      for (const [k, v] of Object.entries(manifest)) set.run(k, JSON.stringify(v));
    });
    tx();
    this.db.close();
  }
}

/** Read-only manifest reader over a built pack. */
export class VendorPackReader {
  private db: LuxSqlite;

  constructor(public readonly packPath: string) {
    this.db = new LuxSqlite(packPath, { readonly: true, fileMustExist: true });
  }

  manifest(): VendorPackManifest {
    const rows = this.db.prepare(`SELECT key, value FROM pack_meta`).all() as {
      key: string;
      value: string;
    }[];
    const out: Record<string, unknown> = {};
    for (const r of rows) out[r.key] = JSON.parse(r.value);
    return out as unknown as VendorPackManifest;
  }

  close(): void {
    this.db.close();
  }
}
