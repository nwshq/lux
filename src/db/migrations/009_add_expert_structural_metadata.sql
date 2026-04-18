-- Add structural metadata columns to the experts table.
--
-- These columns persist overlay-native expert boundary evidence so experts
-- can survive overlay rebuild churn without losing their structural identity.
-- All columns are optional — legacy experts without structural metadata remain
-- fully functional and are treated as directory-led entries.

ALTER TABLE experts ADD COLUMN boundary_basis TEXT;
ALTER TABLE experts ADD COLUMN structural_signature TEXT;
ALTER TABLE experts ADD COLUMN structural_rationale TEXT;
