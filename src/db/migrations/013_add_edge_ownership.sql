-- Ownership classification for surface->handler edges (E1, cross-repo shared-kernel
-- resolution). For each `handled_by` edge from an HTTP surface, records who owns the
-- handler relative to the app/kernel boundary:
--   'kernel-owned'     = handler resolves to a promoted first-party (kernel) class
--   'client-override'  = handler resolves to the consuming app's own class (App\*)
--   'client-gap'       = an App\* handler the client does NOT implement (target node absent)
--   'external'         = a third-party (vendor) handler, absent from the overlay
--
-- NULL for every non-handler edge and until an overlay rebuild populates it. Nullable +
-- no default keeps the migration total and back-compatible: existing rows read back NULL
-- and all current consumers are unaffected until they opt into reading `ownership`.
ALTER TABLE structural_edges ADD COLUMN ownership TEXT;

CREATE INDEX IF NOT EXISTS idx_structural_edges_ownership ON structural_edges(ownership);
