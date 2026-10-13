-- ============================================================================
--  003_export.sql — classification rules + saved export recipes
-- ----------------------------------------------------------------------------
--  To export per niche, a place has to BELONG to a niche. Your source data only
--  carries free-text `category_text`, so a niche needs match terms that map that
--  text onto membership. Those terms are data, not code.
--
--  `export_recipes` stores a named set of export options, so a shape you approve
--  once can be re-run forever without re-deciding it.
-- ============================================================================

PRAGMA foreign_keys = ON;

-- Comma-separated phrases matched against places.category_text (case-insensitive).
ALTER TABLE niches ADD COLUMN match_terms TEXT;

-- Controls how listing codes are rendered: {prefix}, {region}, {seq}.
ALTER TABLE niches ADD COLUMN listing_format TEXT;

CREATE TABLE IF NOT EXISTS export_recipes (
  id           INTEGER PRIMARY KEY,
  name         TEXT NOT NULL UNIQUE,
  options_json TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_place_niches_niche_region
  ON place_niches (niche_id, listing_code);
