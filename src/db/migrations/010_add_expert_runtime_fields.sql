-- Migration 010: Add expert runtime configuration fields
-- Enables backend-aware expert execution without overloading `model`.

ALTER TABLE experts ADD COLUMN backend TEXT;
ALTER TABLE experts ADD COLUMN provider TEXT;
ALTER TABLE experts ADD COLUMN thinking TEXT;
