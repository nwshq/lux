-- Provenance marker for structural nodes (ADR-3, tracing-calls-through-vendor).
-- 'local'       = materialized from the scanned project corpus (app code).
-- 'vendor-pack' = imported from a merged vendor pack (a framework/dependency graph
--                 built once per composer.lock and merged into the overlay).
--
-- NOT NULL DEFAULT 'local' makes the migration total and back-compatible: every
-- existing row and every future app-materialized row reads back 'local', so all
-- current consumers behave exactly as before until they opt into filtering on
-- `origin = 'local'`.
--
-- Node marker ONLY — NOT edges. An edge's provenance is fully derivable from its
-- endpoints (vendor->vendor: both external; app->vendor boundary: local source,
-- vendor-pack target; app-internal: both local). `structural_edges` has no foreign
-- key to `structural_nodes` (migration 008), so importing vendor edges that point
-- at vendor nodes never trips a referential check.

ALTER TABLE structural_nodes ADD COLUMN origin TEXT NOT NULL DEFAULT 'local';

CREATE INDEX IF NOT EXISTS idx_structural_nodes_origin ON structural_nodes(origin);
