-- ============================================================================
--  004_demo_and_crowdsource.sql — Cloudflare Pincode & Demo Repo Tables + Crowdsourcing
-- ----------------------------------------------------------------------------
--  Brings the full schema from:
--   1. Cloudflare D1 Pincode DB (digipincode-india):
--      states, districts, sub_districts, villages, village_amenities, lgd_panchayats
--   2. Demo Directory Repo (skm-studio-maps / pincode-directory):
--      cities, businesses, reviews, leads, feedback_messages, claims
--   3. Crowdsourcing Data:
--      crowdsourced_hazards, amenity_contributions
-- ============================================================================

PRAGMA foreign_keys = ON;

-- ------------------------------------------------------------- 1. Geo / Admin -
CREATE TABLE IF NOT EXISTS states (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  code    TEXT UNIQUE NOT NULL,          -- e.g. 'PB', 'DL', 'MH'
  name    TEXT NOT NULL,
  name_hi TEXT,
  slug    TEXT UNIQUE NOT NULL
);

CREATE TABLE IF NOT EXISTS districts (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  state_id INTEGER NOT NULL REFERENCES states(id) ON DELETE CASCADE,
  code     TEXT,
  name     TEXT NOT NULL,
  slug     TEXT NOT NULL,
  UNIQUE(state_id, slug)
);

CREATE TABLE IF NOT EXISTS sub_districts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  district_id INTEGER NOT NULL REFERENCES districts(id) ON DELETE CASCADE,
  code        TEXT,
  name        TEXT NOT NULL,
  slug        TEXT NOT NULL,
  UNIQUE(district_id, slug)
);

CREATE TABLE IF NOT EXISTS villages (
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

CREATE TABLE IF NOT EXISTS village_amenities (
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

CREATE TABLE IF NOT EXISTS lgd_panchayats (
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

-- ------------------------------------------------------------- 2. Directory ---
CREATE TABLE IF NOT EXISTS cities (
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

CREATE TABLE IF NOT EXISTS businesses (
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

CREATE TABLE IF NOT EXISTS reviews (
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

CREATE TABLE IF NOT EXISTS leads (
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

CREATE TABLE IF NOT EXISTS claims (
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

CREATE TABLE IF NOT EXISTS feedback_messages (
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

-- ------------------------------------------------------------- 3. Crowdsourcing -
CREATE TABLE IF NOT EXISTS crowdsourced_hazards (
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

CREATE TABLE IF NOT EXISTS amenity_contributions (
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

CREATE INDEX IF NOT EXISTS idx_states_slug ON states(slug);
CREATE INDEX IF NOT EXISTS idx_districts_state ON districts(state_id);
CREATE INDEX IF NOT EXISTS idx_subdistricts_district ON sub_districts(district_id);
CREATE INDEX IF NOT EXISTS idx_villages_pincode ON villages(pincode);
CREATE INDEX IF NOT EXISTS idx_villages_census ON villages(census_code);
CREATE INDEX IF NOT EXISTS idx_businesses_niche ON businesses(niche);
CREATE INDEX IF NOT EXISTS idx_businesses_city ON businesses(city);
CREATE INDEX IF NOT EXISTS idx_businesses_pincode ON businesses(pincode);
CREATE INDEX IF NOT EXISTS idx_reviews_business ON reviews(business_id);
CREATE INDEX IF NOT EXISTS idx_leads_business ON leads(business_id);
CREATE INDEX IF NOT EXISTS idx_hazards_pincode ON crowdsourced_hazards(pincode);
CREATE INDEX IF NOT EXISTS idx_amenity_census ON amenity_contributions(census_code);
