-- src/db/migrations/015_add_node_embeddings.sql
-- 014_add_node_anchor_texts.sql is the latest landed migration (verified: migrations run 001..014,
-- no gaps), so 015 is the next free integer. Phase-1 lexical claimed 014; this is the Phase-3 vector
-- plane. RECONCILIATION: loadMigrations auto-discovers by filename regex, sorts, and applies any
-- version above MAX(version) (migrations.ts:69-109), so a gap never blocks a later file. If any
-- migration lands on main before this merges, renumber to the next free integer at merge time; the
-- table shape and code are unaffected.
--
-- Mirrors the superseded doc-plane primitive's knowledge_embeddings shape (Decision 8), re-keyed to
-- the structural-node plane: a TEXT node_id PK (not an INTEGER entry_id), a model-tagged fp32 BLOB,
-- and a content_hash freshness key. Deliberately carries NO foreign key and NO file_path column (see
-- 014's no-FK posture and 03 §Storage contract) — the divergence Decision 5 turns on: structural_nodes
-- ids are deterministic and updated in place (never churn), so freshness is code-driven — the scoped
-- refresh deletes victim node ids' sibling rows and the queue's `content_hash <>` arm catches survivors.
CREATE TABLE structural_node_embeddings (
  node_id      TEXT PRIMARY KEY,   -- one active vector per node; a re-embed REPLACEs in place
  model        TEXT NOT NULL,      -- self-describing identity: ANCHOR_EMBED_MODEL, or
                                   --   'openai:text-embedding-3-small' (API path, Phase 4)
  dims         INTEGER NOT NULL,   -- 384 for the local default; provider-declared for API models
  vector       BLOB NOT NULL,      -- Float32Array little-endian bytes, dims * 4 (codec.ts)
  content_hash TEXT NOT NULL,      -- copied from structural_node_texts.content_hash at embed time
  updated_at   INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Every read this plane adds (the widened queue, the per-model row scan, the coverage count) filters
-- or joins on `model` (Decision 11 — never a cross-model cosine). The active model is config-selectable
-- (Decision 7), so a model change is an ordinary re-embed: old-model rows sit inert under the filter
-- until superseded, indexed lookups on the new model stay fast throughout.
CREATE INDEX idx_sne_model ON structural_node_embeddings(model);
