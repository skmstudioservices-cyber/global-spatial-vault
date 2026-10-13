-- ============================================================================
--  001_init.sql — Global Spatial Vault, schema v1
-- ----------------------------------------------------------------------------
--  Design notes (see PLAN.md for the reasoning):
--   * Every id is stable and machine-friendly; `places.uid` is the public one.
--   * One canonical place  ← many →  niches  (place_niches), so a single shop can
--     live on several niche sites and the master directory without duplication.
--   * The category graph is shared, and the LEVEL (1|2|3) is stored per place,
--     because a pharmacy is "secondary" inside a hospital but "primary" on a road.
--   * The admin hierarchy is a self-referencing tree, so it does not assume which
--     LGD depth you hold — add whatever levels you have, by hand or by import.
--   * `lat`/`lng` are nullable on purpose: most existing listings are address-only.
-- ============================================================================

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------- reference --

CREATE TABLE IF NOT EXISTS ref_admin (
  id           INTEGER PRIMARY KEY,
  parent_id    INTEGER REFERENCES ref_admin(id) ON DELETE SET NULL,
  kind         TEXT    NOT NULL,           -- country|state|district|block|village|<custom>
  code         TEXT,                       -- LGD code / ISO 3166-2 / your own
  name         TEXT    NOT NULL,
  country_iso2 TEXT,
  lat          REAL,
  lng          REAL,
  geohash13    TEXT,
  digipin      TEXT,
  meta_json    TEXT,
  UNIQUE (kind, code)
);
CREATE INDEX IF NOT EXISTS idx_ref_admin_parent ON ref_admin (parent_id);
CREATE INDEX IF NOT EXISTS idx_ref_admin_name   ON ref_admin (name);
CREATE INDEX IF NOT EXISTS idx_ref_admin_iso2   ON ref_admin (country_iso2);

CREATE TABLE IF NOT EXISTS ref_pincode (
  pincode      TEXT PRIMARY KEY,
  country_iso2 TEXT,
  admin_id     INTEGER REFERENCES ref_admin(id) ON DELETE SET NULL,
  office_name  TEXT,
  lat          REAL,
  lng          REAL,
  geohash13    TEXT,
  digipin      TEXT,
  source       TEXT
);
CREATE INDEX IF NOT EXISTS idx_ref_pincode_admin ON ref_pincode (admin_id);

-- ------------------------------------------------------------------ niches --

CREATE TABLE IF NOT EXISTS niches (
  id           INTEGER PRIMARY KEY,
  slug         TEXT    NOT NULL UNIQUE,     -- potholes, safe-alleys, tailorshopnearme
  name         TEXT    NOT NULL,
  code_prefix  TEXT    NOT NULL UNIQUE,     -- TSH, ATM, PET …
  icon         TEXT,
  theme_color  TEXT,
  default_zoom INTEGER DEFAULT 13,
  blurb        TEXT,
  created_at   TEXT    NOT NULL
);

-- Fields are DATA, not code: a new niche needs rows here, not a code change.
CREATE TABLE IF NOT EXISTS niche_fields (
  id           INTEGER PRIMARY KEY,
  niche_id     INTEGER NOT NULL REFERENCES niches(id) ON DELETE CASCADE,
  key          TEXT    NOT NULL,
  label        TEXT    NOT NULL,
  data_type    TEXT    NOT NULL,            -- text|number|boolean|date|select|multi|latlng|url|phone
  required     INTEGER NOT NULL DEFAULT 0,
  options_json TEXT,
  sort_order   INTEGER NOT NULL DEFAULT 0,
  help_text    TEXT,
  UNIQUE (niche_id, key)
);

-- Shared category graph. Carries NO level: level is chosen per place.
CREATE TABLE IF NOT EXISTS categories (
  id         INTEGER PRIMARY KEY,
  parent_id  INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  slug       TEXT    NOT NULL UNIQUE,
  name       TEXT    NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_categories_parent ON categories (parent_id);

-- ------------------------------------------------------------------ places --

CREATE TABLE IF NOT EXISTS places (
  uid            TEXT PRIMARY KEY,          -- short public id, immutable
  canonical_name TEXT NOT NULL,
  name_norm      TEXT,                      -- lowercased, punctuation stripped (dedupe)
  slug           TEXT UNIQUE,
  lat            REAL,
  lng            REAL,
  geohash13      TEXT,                      -- ~4.7 mm micro cell
  digipin        TEXT,                      -- India Post style digital address
  digipin_source TEXT,                      -- which resolver produced it
  spatial_cell   TEXT,                      -- coarse geohash5 for clustering
  geo_source     TEXT,                      -- pincode|centroid|nominatim|manual|crowd
  geo_confidence REAL,
  country_iso2   TEXT,
  admin_id       INTEGER REFERENCES ref_admin(id) ON DELETE SET NULL,
  pincode        TEXT,
  address        TEXT,
  phone          TEXT,
  phone_norm     TEXT,
  email          TEXT,
  website        TEXT,
  status         TEXT    NOT NULL DEFAULT 'draft',   -- draft|pending|active|hidden|merged
  quality_score  INTEGER NOT NULL DEFAULT 0,
  priority       INTEGER NOT NULL DEFAULT 0,         -- paid ranking lever
  popularity     INTEGER NOT NULL DEFAULT 0,
  source         TEXT,
  source_ref     TEXT,
  merged_into    TEXT REFERENCES places(uid) ON DELETE SET NULL,
  created_at     TEXT    NOT NULL,
  updated_at     TEXT    NOT NULL,
  verified_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_places_name_norm  ON places (name_norm);
CREATE INDEX IF NOT EXISTS idx_places_geohash    ON places (geohash13);
CREATE INDEX IF NOT EXISTS idx_places_cell       ON places (spatial_cell);
CREATE INDEX IF NOT EXISTS idx_places_status     ON places (status);
CREATE INDEX IF NOT EXISTS idx_places_latlng     ON places (lat, lng);
CREATE INDEX IF NOT EXISTS idx_places_phone_norm ON places (phone_norm);

-- The relation that makes one database serve many sites.
CREATE TABLE IF NOT EXISTS place_niches (
  id              INTEGER PRIMARY KEY,
  place_uid       TEXT    NOT NULL REFERENCES places(uid) ON DELETE CASCADE,
  niche_id        INTEGER NOT NULL REFERENCES niches(id) ON DELETE CASCADE,
  listing_code    TEXT UNIQUE,              -- TSH-INDL-000123 (worldwide, expandable)
  title           TEXT,
  description     TEXT,
  attributes_json TEXT,                     -- the niche-specific fields
  status          TEXT    NOT NULL DEFAULT 'active',
  quality_score   INTEGER NOT NULL DEFAULT 0,
  priority        INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT    NOT NULL,
  updated_at      TEXT    NOT NULL,
  UNIQUE (place_uid, niche_id)
);
CREATE INDEX IF NOT EXISTS idx_place_niches_niche ON place_niches (niche_id);
CREATE INDEX IF NOT EXISTS idx_place_niches_code  ON place_niches (listing_code);

CREATE TABLE IF NOT EXISTS place_category_map (
  place_uid   TEXT    NOT NULL REFERENCES places(uid) ON DELETE CASCADE,
  category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  level       INTEGER NOT NULL DEFAULT 1,   -- 1|2|3 — chosen PER PLACE
  is_primary  INTEGER NOT NULL DEFAULT 0,
  weight      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (place_uid, category_id)
);
CREATE INDEX IF NOT EXISTS idx_pcm_category ON place_category_map (category_id);

-- Owner-suggested keywords: they know their business best.
CREATE TABLE IF NOT EXISTS place_keywords (
  id              INTEGER PRIMARY KEY,
  place_uid       TEXT NOT NULL REFERENCES places(uid) ON DELETE CASCADE,
  niche_id        INTEGER REFERENCES niches(id) ON DELETE CASCADE,
  keyword         TEXT NOT NULL,
  kind            TEXT,                     -- service|product|locality|brand|other
  volume_estimate INTEGER,
  source          TEXT,                     -- owner|admin|crowd|research
  approved        INTEGER NOT NULL DEFAULT 0,
  UNIQUE (place_uid, keyword)
);
CREATE INDEX IF NOT EXISTS idx_keywords_place ON place_keywords (place_uid);

CREATE TABLE IF NOT EXISTS place_media (
  id         INTEGER PRIMARY KEY,
  place_uid  TEXT NOT NULL REFERENCES places(uid) ON DELETE CASCADE,
  url        TEXT NOT NULL,
  kind       TEXT,                          -- photo|logo|video|document
  license    TEXT,
  credit     TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_media_place ON place_media (place_uid);

CREATE TABLE IF NOT EXISTS place_hours (
  id          INTEGER PRIMARY KEY,
  place_uid   TEXT    NOT NULL REFERENCES places(uid) ON DELETE CASCADE,
  day_of_week INTEGER NOT NULL,             -- 0=Sunday … 6=Saturday
  open_time   TEXT,
  close_time  TEXT,
  closed      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_hours_place ON place_hours (place_uid);

CREATE TABLE IF NOT EXISTS place_reviews (
  id          INTEGER PRIMARY KEY,
  place_uid   TEXT NOT NULL REFERENCES places(uid) ON DELETE CASCADE,
  niche_id    INTEGER REFERENCES niches(id) ON DELETE SET NULL,
  rating      INTEGER,
  body        TEXT,
  author_name TEXT,
  status      TEXT NOT NULL DEFAULT 'pending',
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reviews_place ON place_reviews (place_uid);

-- --------------------------------------------------------------- safety data --
-- Aggregated only: never a per-place accusation.

CREATE TABLE IF NOT EXISTS risk_reports (
  id            INTEGER PRIMARY KEY,
  admin_id      INTEGER REFERENCES ref_admin(id) ON DELETE SET NULL,
  spatial_cell  TEXT,
  slot          TEXT NOT NULL,              -- dawn|morning|noon|afternoon|evening|night|midnight
  kind          TEXT NOT NULL,              -- robbery|theft|animalAttacks|misbehave|other
  severity      INTEGER NOT NULL DEFAULT 0,
  reported_at   TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending'
);
CREATE INDEX IF NOT EXISTS idx_risk_cell ON risk_reports (spatial_cell, slot);

CREATE TABLE IF NOT EXISTS place_risk (
  place_uid  TEXT    NOT NULL REFERENCES places(uid) ON DELETE CASCADE,
  slot       TEXT    NOT NULL,
  risk_level TEXT,
  score      INTEGER NOT NULL DEFAULT 0,
  hex        TEXT,
  PRIMARY KEY (place_uid, slot)
);

-- ------------------------------------------------------------------- sites --
-- How ONE database serves 28+ different sites, each with its own projection.

CREATE TABLE IF NOT EXISTS sites (
  id                  INTEGER PRIMARY KEY,
  slug                TEXT NOT NULL UNIQUE,
  domain              TEXT,
  name                TEXT NOT NULL,
  kind                TEXT,                 -- niche|master|directory
  niches_json         TEXT,                 -- [] or null = every niche
  visible_fields_json TEXT,                 -- public projection
  hidden_fields_json  TEXT,                 -- explicit denies (always win)
  index_fields_json   TEXT,                 -- lightweight client search index
  card_fields_json    TEXT,                 -- collapsed 3-card view
  detail_fields_json  TEXT,                 -- expanded / detail page
  slug_template       TEXT,                 -- /{country}/{state}/{city}/{name}-{uid}
  theme_json          TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

-- ---------------------------------------------------------------- ingestion --

CREATE TABLE IF NOT EXISTS submissions (
  id                 INTEGER PRIMARY KEY,
  niche_id           INTEGER REFERENCES niches(id) ON DELETE SET NULL,
  place_uid          TEXT REFERENCES places(uid) ON DELETE SET NULL,
  payload_json       TEXT NOT NULL,
  submitted_by       TEXT,
  ip_hash            TEXT,
  user_agent         TEXT,
  status             TEXT NOT NULL DEFAULT 'pending',  -- pending|approved|rejected|duplicate
  reviewer           TEXT,
  review_note        TEXT,
  reviewed_at        TEXT,
  remote_id          TEXT UNIQUE,           -- id from the Supabase inbox, keeps pulls idempotent
  created_at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_submissions_status ON submissions (status);

CREATE TABLE IF NOT EXISTS import_batches (
  id          INTEGER PRIMARY KEY,
  source_file TEXT NOT NULL,
  mapping_json TEXT,
  rows_total  INTEGER NOT NULL DEFAULT 0,
  rows_ok     INTEGER NOT NULL DEFAULT 0,
  rows_failed INTEGER NOT NULL DEFAULT 0,
  started_at  TEXT NOT NULL,
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS import_errors (
  id       INTEGER PRIMARY KEY,
  batch_id INTEGER NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
  row_no   INTEGER,
  column_n TEXT,
  message  TEXT NOT NULL,
  raw_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_import_errors_batch ON import_errors (batch_id);

-- ------------------------------------------------------------------ system --

CREATE TABLE IF NOT EXISTS audit_log (
  id          INTEGER PRIMARY KEY,
  actor       TEXT,
  action      TEXT NOT NULL,
  table_name  TEXT,
  row_pk      TEXT,
  before_json TEXT,
  after_json  TEXT,
  at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_table ON audit_log (table_name, row_pk);

CREATE TABLE IF NOT EXISTS saved_views (
  id           INTEGER PRIMARY KEY,
  name         TEXT NOT NULL UNIQUE,
  table_name   TEXT NOT NULL,
  filter_json  TEXT,
  sort_json    TEXT,
  columns_json TEXT,
  created_at   TEXT NOT NULL
);
