-- Spatial Vault schema
-- generated 2026-10-20T13:11:59.113Z

PRAGMA foreign_keys = ON;

CREATE TABLE amenity_contributions (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  census_code         TEXT,
  locality_name       TEXT NOT NULL,
  pincode             TEXT,
  amenity_type        TEXT NOT NULL,     -- drinking_water|street_light|ev_charger|public_toilet|atm|bus_shelter
  facility_name       TEXT,
  status              TEXT DEFAULT 'operational', -- operational|broken|under_maintenance|proposed
  user_comment        TEXT,
  photo_url           TEXT,
  contributor_name    TEXT,
  contributor_contact TEXT,
  upvotes             INTEGER DEFAULT 0,
  verified            INTEGER DEFAULT 0,
  created_at          TEXT DEFAULT (datetime('now'))
);

CREATE TABLE audit_log (
  id          INTEGER PRIMARY KEY,
  actor       TEXT,
  action      TEXT NOT NULL,
  table_name  TEXT,
  row_pk      TEXT,
  before_json TEXT,
  after_json  TEXT,
  at          TEXT NOT NULL
);

CREATE TABLE businesses (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  slug          TEXT UNIQUE NOT NULL,
  category      TEXT NOT NULL,
  niche         TEXT NOT NULL,
  city          TEXT,
  address       TEXT,
  area          TEXT,
  pincode       TEXT,
  lat           REAL,
  lng           REAL,
  phone         TEXT,
  whatsapp      TEXT,
  website       TEXT,
  email         TEXT,
  description   TEXT,
  price_range   TEXT DEFAULT '$$',     -- $, $$, $$$, $$$$
  opening_time  TEXT DEFAULT '09:00',
  closing_time  TEXT DEFAULT '21:00',
  is_featured   INTEGER DEFAULT 0,
  is_verified   INTEGER DEFAULT 1,
  status        TEXT DEFAULT 'published', -- published|pending|rejected
  plan          TEXT DEFAULT 'free',      -- free|featured|premium
  avg_rating    REAL DEFAULT 4.5,
  review_count  INTEGER DEFAULT 0,
  view_count    INTEGER DEFAULT 0,
  call_count    INTEGER DEFAULT 0,
  submitted_by  TEXT DEFAULT 'admin',
  created_at    TEXT DEFAULT (datetime('now')),
  updated_at    TEXT DEFAULT (datetime('now'))
);

CREATE TABLE categories (
  id         INTEGER PRIMARY KEY,
  parent_id  INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  slug       TEXT    NOT NULL UNIQUE,
  name       TEXT    NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE cities (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  slug       TEXT UNIQUE NOT NULL,
  state      TEXT,
  district   TEXT,
  pincode    TEXT,
  lat        REAL,
  lng        REAL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE claims (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id     INTEGER REFERENCES businesses(id) ON DELETE CASCADE,
  business_name   TEXT,
  claimant_name   TEXT NOT NULL,
  claimant_phone  TEXT NOT NULL,
  claimant_email  TEXT,
  business_role   TEXT DEFAULT 'Owner', -- Owner|Manager|Partner
  id_proof_url    TEXT,
  status          TEXT DEFAULT 'pending', -- pending|verified|rejected
  created_at      TEXT DEFAULT (datetime('now'))
);

CREATE TABLE crowdsourced_hazards (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  slot             TEXT NOT NULL,        -- dawn|morning|noon|afternoon|evening|night|midnight
  threat_kind      TEXT NOT NULL,        -- robbery|theft|animalAttacks|misbehave|pothole|dark_alley|other
  severity         INTEGER DEFAULT 3,    -- 1 (low) to 5 (extreme)
  address          TEXT NOT NULL,
  pincode          TEXT,
  lat              REAL,
  lng              REAL,
  description      TEXT NOT NULL,
  reporter_contact TEXT,
  upvotes          INTEGER DEFAULT 1,
  status           TEXT DEFAULT 'active',-- active|investigating|resolved|flagged
  created_at       TEXT DEFAULT (datetime('now'))
);

CREATE TABLE districts (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  state_id INTEGER NOT NULL REFERENCES states(id) ON DELETE CASCADE,
  code     TEXT,
  name     TEXT NOT NULL,
  slug     TEXT NOT NULL,
  UNIQUE(state_id, slug)
);

CREATE TABLE export_recipes (
  id           INTEGER PRIMARY KEY,
  name         TEXT NOT NULL UNIQUE,
  options_json TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE TABLE feedback_messages (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  page_url         TEXT,
  message_type     TEXT NOT NULL,        -- bug|feature|feedback|data_correction
  message          TEXT NOT NULL,
  contact_optional TEXT,
  project_slug     TEXT DEFAULT 'global-spatial-vault',
  ip_address       TEXT,
  status           TEXT DEFAULT 'new',   -- new|reviewed|resolved
  created_at       TEXT DEFAULT (datetime('now'))
);

CREATE TABLE import_batches (
  id          INTEGER PRIMARY KEY,
  source_file TEXT NOT NULL,
  mapping_json TEXT,
  rows_total  INTEGER NOT NULL DEFAULT 0,
  rows_ok     INTEGER NOT NULL DEFAULT 0,
  rows_failed INTEGER NOT NULL DEFAULT 0,
  started_at  TEXT NOT NULL,
  finished_at TEXT
);

CREATE TABLE import_errors (
  id       INTEGER PRIMARY KEY,
  batch_id INTEGER NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
  row_no   INTEGER,
  column_n TEXT,
  message  TEXT NOT NULL,
  raw_json TEXT
);

CREATE TABLE import_mappings (
  id           INTEGER PRIMARY KEY,
  name         TEXT NOT NULL UNIQUE,
  target_table TEXT NOT NULL,
  mapping_json TEXT NOT NULL,
  options_json TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE TABLE leads (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id   INTEGER REFERENCES businesses(id) ON DELETE SET NULL,
  business_name TEXT,
  customer_name TEXT NOT NULL,
  phone         TEXT NOT NULL,
  email         TEXT,
  message       TEXT,
  plan          TEXT DEFAULT 'free',
  status        TEXT DEFAULT 'new',       -- new|contacted|converted|closed
  source_page   TEXT,
  created_at    TEXT DEFAULT (datetime('now'))
);

CREATE TABLE lgd_panchayats (
  lgd_code         TEXT PRIMARY KEY,
  state_lgd_code   TEXT,
  district_lgd_code TEXT,
  block_lgd_code   TEXT,
  local_body_name  TEXT NOT NULL,
  local_body_type  TEXT,               -- Gram Panchayat / Block Panchayat / Zilla Parishad
  state_name       TEXT,
  district_name    TEXT,
  block_name       TEXT,
  village_lgd_code TEXT,
  census_code      TEXT,
  population       INTEGER,
  households       INTEGER,
  area_km2         REAL,
  head_name        TEXT,
  head_phone       TEXT,
  website          TEXT,
  updated_at       TEXT DEFAULT (datetime('now'))
);

CREATE TABLE niche_fields (
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

CREATE TABLE niches (
  id           INTEGER PRIMARY KEY,
  slug         TEXT    NOT NULL UNIQUE,     -- potholes, safe-alleys, tailorshopnearme
  name         TEXT    NOT NULL,
  code_prefix  TEXT    NOT NULL UNIQUE,     -- TSH, ATM, PET …
  icon         TEXT,
  theme_color  TEXT,
  default_zoom INTEGER DEFAULT 13,
  blurb        TEXT,
  created_at   TEXT    NOT NULL
, match_terms TEXT, listing_format TEXT);

CREATE TABLE place_category_map (
  place_uid   TEXT    NOT NULL REFERENCES places(uid) ON DELETE CASCADE,
  category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  level       INTEGER NOT NULL DEFAULT 1,   -- 1|2|3 — chosen PER PLACE
  is_primary  INTEGER NOT NULL DEFAULT 0,
  weight      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (place_uid, category_id)
);

CREATE TABLE place_hours (
  id          INTEGER PRIMARY KEY,
  place_uid   TEXT    NOT NULL REFERENCES places(uid) ON DELETE CASCADE,
  day_of_week INTEGER NOT NULL,             -- 0=Sunday … 6=Saturday
  open_time   TEXT,
  close_time  TEXT,
  closed      INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE place_keywords (
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

CREATE TABLE place_media (
  id         INTEGER PRIMARY KEY,
  place_uid  TEXT NOT NULL REFERENCES places(uid) ON DELETE CASCADE,
  url        TEXT NOT NULL,
  kind       TEXT,                          -- photo|logo|video|document
  license    TEXT,
  credit     TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE place_niches (
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

CREATE TABLE place_reviews (
  id          INTEGER PRIMARY KEY,
  place_uid   TEXT NOT NULL REFERENCES places(uid) ON DELETE CASCADE,
  niche_id    INTEGER REFERENCES niches(id) ON DELETE SET NULL,
  rating      INTEGER,
  body        TEXT,
  author_name TEXT,
  status      TEXT NOT NULL DEFAULT 'pending',
  created_at  TEXT NOT NULL
);

CREATE TABLE place_risk (
  place_uid  TEXT    NOT NULL REFERENCES places(uid) ON DELETE CASCADE,
  slot       TEXT    NOT NULL,
  risk_level TEXT,
  score      INTEGER NOT NULL DEFAULT 0,
  hex        TEXT,
  PRIMARY KEY (place_uid, slot)
);

CREATE TABLE places (
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
, city             TEXT, locality         TEXT, state_text       TEXT, category_text    TEXT, raw_json         TEXT, owner_submitted  INTEGER NOT NULL DEFAULT 0, external_id      TEXT);

CREATE TABLE ref_admin (
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

CREATE TABLE ref_pincode (
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

CREATE TABLE reviews (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id   INTEGER REFERENCES businesses(id) ON DELETE CASCADE,
  business_name TEXT,
  user_name     TEXT NOT NULL,
  user_email    TEXT,
  rating        INTEGER CHECK (rating BETWEEN 1 AND 5),
  title         TEXT,
  body          TEXT NOT NULL,
  is_verified   INTEGER DEFAULT 1,
  helpful_count INTEGER DEFAULT 0,
  created_at    TEXT DEFAULT (datetime('now'))
);

CREATE TABLE risk_reports (
  id            INTEGER PRIMARY KEY,
  admin_id      INTEGER REFERENCES ref_admin(id) ON DELETE SET NULL,
  spatial_cell  TEXT,
  slot          TEXT NOT NULL,              -- dawn|morning|noon|afternoon|evening|night|midnight
  kind          TEXT NOT NULL,              -- robbery|theft|animalAttacks|misbehave|other
  severity      INTEGER NOT NULL DEFAULT 0,
  reported_at   TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending'
);

CREATE TABLE saved_views (
  id           INTEGER PRIMARY KEY,
  name         TEXT NOT NULL UNIQUE,
  table_name   TEXT NOT NULL,
  filter_json  TEXT,
  sort_json    TEXT,
  columns_json TEXT,
  created_at   TEXT NOT NULL
);

CREATE TABLE schema_migrations (
    version    TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    applied_at TEXT NOT NULL
  );

CREATE TABLE sites (
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

CREATE TABLE states (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  code    TEXT UNIQUE NOT NULL,          -- e.g. 'PB', 'DL', 'MH'
  name    TEXT NOT NULL,
  name_hi TEXT,
  slug    TEXT UNIQUE NOT NULL
);

CREATE TABLE sub_districts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  district_id INTEGER NOT NULL REFERENCES districts(id) ON DELETE CASCADE,
  code        TEXT,
  name        TEXT NOT NULL,
  slug        TEXT NOT NULL,
  UNIQUE(district_id, slug)
);

CREATE TABLE submissions (
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

CREATE TABLE village_amenities (
  census_code     TEXT PRIMARY KEY REFERENCES villages(census_code) ON DELETE CASCADE,
  road            TEXT,
  drinking_water  TEXT,
  electricity     TEXT,
  school          TEXT,
  hospital        TEXT,
  bus_stop        TEXT,
  railway_station TEXT,
  mobile_network  TEXT,
  bank_atm        TEXT,
  famous_for      TEXT,
  source          TEXT DEFAULT 'census2011',
  verified_at     TEXT
);

CREATE TABLE villages (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  sub_district_id INTEGER REFERENCES sub_districts(id) ON DELETE SET NULL,
  name            TEXT NOT NULL,
  slug            TEXT NOT NULL,
  pincode         TEXT,
  census_code     TEXT UNIQUE,
  lgd_code        TEXT,
  population      INTEGER,
  households      INTEGER,
  lat             REAL,
  lon             REAL,
  digipin         TEXT,
  ai_description  TEXT
);

CREATE INDEX idx_amenity_census ON amenity_contributions(census_code);

CREATE INDEX idx_audit_table ON audit_log (table_name, row_pk);

CREATE INDEX idx_businesses_city ON businesses(city);

CREATE INDEX idx_businesses_niche ON businesses(niche);

CREATE INDEX idx_businesses_pincode ON businesses(pincode);

CREATE INDEX idx_categories_parent ON categories (parent_id);

CREATE INDEX idx_districts_state ON districts(state_id);

CREATE INDEX idx_hazards_pincode ON crowdsourced_hazards(pincode);

CREATE INDEX idx_hours_place ON place_hours (place_uid);

CREATE INDEX idx_import_errors_batch ON import_errors (batch_id);

CREATE INDEX idx_keywords_place ON place_keywords (place_uid);

CREATE INDEX idx_leads_business ON leads(business_id);

CREATE INDEX idx_media_place ON place_media (place_uid);

CREATE INDEX idx_pcm_category ON place_category_map (category_id);

CREATE INDEX idx_place_niches_code  ON place_niches (listing_code);

CREATE INDEX idx_place_niches_niche ON place_niches (niche_id);

CREATE INDEX idx_place_niches_niche_region
  ON place_niches (niche_id, listing_code);

CREATE INDEX idx_places_cell       ON places (spatial_cell);

CREATE INDEX idx_places_city    ON places (city);

CREATE INDEX idx_places_extid   ON places (external_id);

CREATE INDEX idx_places_geohash    ON places (geohash13);

CREATE INDEX idx_places_latlng     ON places (lat, lng);

CREATE INDEX idx_places_name_norm  ON places (name_norm);

CREATE INDEX idx_places_phone_norm ON places (phone_norm);

CREATE INDEX idx_places_pincode ON places (pincode);

CREATE UNIQUE INDEX idx_places_source_ref
  ON places (source, source_ref);

CREATE INDEX idx_places_status     ON places (status);

CREATE INDEX idx_ref_admin_iso2   ON ref_admin (country_iso2);

CREATE INDEX idx_ref_admin_name   ON ref_admin (name);

CREATE INDEX idx_ref_admin_parent ON ref_admin (parent_id);

CREATE INDEX idx_ref_pincode_admin ON ref_pincode (admin_id);

CREATE INDEX idx_reviews_business ON reviews(business_id);

CREATE INDEX idx_reviews_place ON place_reviews (place_uid);

CREATE INDEX idx_risk_cell ON risk_reports (spatial_cell, slot);

CREATE INDEX idx_states_slug ON states(slug);

CREATE INDEX idx_subdistricts_district ON sub_districts(district_id);

CREATE INDEX idx_submissions_status ON submissions (status);

CREATE INDEX idx_villages_census ON villages(census_code);

CREATE INDEX idx_villages_pincode ON villages(pincode);
