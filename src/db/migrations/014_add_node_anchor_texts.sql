-- src/db/migrations/014_add_node_anchor_texts.sql
-- 013_add_edge_ownership.sql is the latest landed migration (verified: migrations end at 013), so
-- 014 is the next free integer. Phase-1 lexical claims 014; the Phase-3 embeddings table is 015.
-- EXAMPLE_DASHBOARDCILIATION: if any migration lands on main before this merges, renumber to the next free
-- integer at merge time (loadMigrations applies any file numbered > MAX(version); a gap never blocks).

-- Prepared per-node text (Decision 5). One row per anchor-viable local node (Class/Function/Method),
-- written in the SAME materialization transaction that upserts structural_nodes. `content_hash` is
-- this plane's freshness key (Decision 5) — the WASM engine has no sha256(), so the hash is computed
-- in JS and stored, then compared column-to-column by the Phase-3 needs-embedding queue.
CREATE TABLE structural_node_texts (
  node_id      TEXT PRIMARY KEY,   -- structural_nodes.id (deterministic; astSymbolIdentity, symbols.ts:32)
  prepared     TEXT NOT NULL,      -- prepareNodeText().embedText — the rendered embed/search unit
  content_hash TEXT NOT NULL,      -- sha256(prepared), hex
  updated_at   INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Standalone FTS5 (Decision 4). NOT external-content: structural_nodes has a TEXT PK whose implicit
-- rowid is not durable across VACUUM (Current State §1.2), so an external-content FTS cannot bind to
-- it stably — this table carries its own rows. node_id UNINDEXED: stored + retrievable, not tokenized
-- or matched. Columns split so weighted bm25 favours name/identifier hits over context hits.
CREATE VIRTUAL TABLE structural_node_fts USING fts5(
  node_id UNINDEXED,
  name,           -- symbol_name as written
  identifiers,    -- camelCase/PascalCase/snake_case split: 'StripeService' -> 'stripe service'
  qualified,      -- qualified_name, namespace separators tokenised
  path_segments,  -- 'src/Services/Payments/StripeService.php' -> 'services payments stripe service'
  context         -- signature line + leading doc-comment (truncated)
);
