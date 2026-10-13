-- ============================================================================
--  002_import.sql — landing columns + saved import mappings
-- ----------------------------------------------------------------------------
--  Raw source files (your SKM export, pincode/LGD dumps, CSV drops) carry free
--  text like "City" and "Area / Locality" that has not been resolved to the
--  admin tree yet. These landing columns let a raw import succeed immediately;
--  the enrichment phase later resolves them into admin_id / geohash / DIGIPIN
--  without the original row ever being lost (raw_json keeps it verbatim).
-- ============================================================================

PRAGMA foreign_keys = ON;

ALTER TABLE places ADD COLUMN city             TEXT;
ALTER TABLE places ADD COLUMN locality         TEXT;
ALTER TABLE places ADD COLUMN state_text       TEXT;
ALTER TABLE places ADD COLUMN category_text    TEXT;
ALTER TABLE places ADD COLUMN raw_json         TEXT;
ALTER TABLE places ADD COLUMN owner_submitted  INTEGER NOT NULL DEFAULT 0;
ALTER TABLE places ADD COLUMN external_id      TEXT;

CREATE INDEX IF NOT EXISTS idx_places_city    ON places (city);
CREATE INDEX IF NOT EXISTS idx_places_pincode ON places (pincode);
CREATE INDEX IF NOT EXISTS idx_places_extid   ON places (external_id);

-- One row per (source, source_ref): makes re-importing the same export update
-- instead of duplicating, which is what makes the importer idempotent.
-- Deliberately NOT a partial index, so it can be used as an upsert conflict
-- target. SQLite treats NULLs as distinct, so rows without a source_ref are
-- unaffected.
CREATE UNIQUE INDEX IF NOT EXISTS idx_places_source_ref
  ON places (source, source_ref);

-- Saved column-mapping templates, managed as data (the portal will edit these).
CREATE TABLE IF NOT EXISTS import_mappings (
  id           INTEGER PRIMARY KEY,
  name         TEXT NOT NULL UNIQUE,
  target_table TEXT NOT NULL,
  mapping_json TEXT NOT NULL,
  options_json TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
