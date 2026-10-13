# PLAN — Global Spatial Vault Data Engine

**Status:** planning (not yet approved to build)
**Scope owner:** this DSH session = **backend data engine only**
**Out of scope here:** niche site design, SEO copy, Astro page templates, Leaflet UI
(those are owned by your other AI models).

---

## 0. Hard constraints (these drive every decision)

| Constraint | Consequence |
|---|---|
| **No payment card available** | ❌ Cloudflare R2, ❌ CF Zero Trust / Access, ❌ any paid tier. Only card-free free tiers: CF Pages, Workers, D1, KV, Supabase, GitHub. |
| **Tiny AI token budget (~3 CNY)** | Engine must be **CLI-runnable** so you can repeat work without spending tokens. Fewer, larger agent steps. |
| **Portal runs on your PC only** | No cloud auth needed at all. Supabase is a write-only inbox. |
| **`pages.dev` free tier = 20,000 files per site** | Tiles/pages must be **sharded per niche** (you already have ~28 projects = 28 separate 20k budgets). |
| **Data is the moat** | Source lives in a **private** GitHub repo; sites pull at build time. |
| **No Google Maps data** | OSM/Overpass + your own submissions + LGD/pincode only. |

---

## 1. Architecture

```
   niche sites (anonymous forms) ──POST──► SUPABASE  (inbox ONLY: pending submissions)
                                                │
                                    you pull every few days
                                                ▼
   ┌──────────────────────────────────────────────────────────┐
   │  YOUR PC — the real database                             │
   │                                                          │
   │   SQLite  (working store: tables, FKs, joins, edits)     │
   │   Local web portal  →  localhost UI + CLI equivalents    │
   └──────────────────────────────────────────────────────────┘
                          │  export + commit
                          ▼
   PRIVATE GITHUB DATA REPO  ← the moat
     schema.sql · tables/*.json · tables/*.csv
     niches/<slug>/index.json      ← lightweight, client-searchable
     niches/<slug>/places.json     ← full detail, lazy-loaded
     geo/*            · geojson/*
                          │  pulled at build time
                          ▼
   per-niche repo  →  Astro SSG build  →  CF Pages (static, unlimited free requests)
```

**Why this kills the D1 problem permanently:** public traffic never touches a
database. Only you and moderators read/write, and only locally.

---

## 2. Storage model

- **Working store:** `vault.db` (SQLite, on your PC). Real FKs, real joins,
  transactional edits, `ALTER TABLE` for column moves.
- **Committed to GitHub:** portable, diffable text — `schema.sql`,
  `tables/<table>.json`, `tables/<table>.csv`. Never the binary `.db`
  (undiffable, and merge conflicts are unresolvable).
- **Backups:** each commit is the backup; plus a periodic full `dump.sql` + `.db`.

---

## 3. Core schema (v1)

### Reference / geography (your LGD + pincode data — **fully user-editable**)

> You're unsure which LGD depth you actually hold, so every level is an ordinary
> editable table: import what you have, add levels by hand, extend later.
> Nothing about the hierarchy is hard-coded.
```
ref_country     (iso2 PK, iso3, name, phone_code)
ref_state       (lgd_code PK, country_iso2 FK, name)
ref_district    (lgd_code PK, state_lgd FK, name)
ref_block       (lgd_code PK, district_lgd FK, name)
ref_village     (lgd_code PK, block_lgd FK, name)
ref_pincode     (pincode PK, state_lgd, district_lgd, office_name, lat, lng, geohash13, digipin)
```

### Niches (metadata-driven — new niche = rows, not code)
```
niches        (id PK, slug UNIQUE, name, code_prefix, icon, theme_color,
               default_zoom, created_at)
niche_fields  (id PK, niche_id FK, key, label, data_type, required,
               options_json, sort_order, help_text)
place_categories (id PK, slug, name, parent_id FK, sort_order)
                   -- the shared category GRAPH; carries no fixed level
place_category_map (place_uid FK, category_id FK,
                    level 1|2|3,      -- chosen PER PLACE, by the owner
                    is_primary, weight)
```

> **Level belongs to the place, not the category.** A pharmacy inside a hospital is
> that hospital's *secondary* category; the same pharmacy on a roadside is *primary*
> for itself. Because the owner decides, `level` lives on the **join row**.
> The category graph is shared (not niche-bound), so the master directory and every
> niche site draw from one tree while each place presents its own emphasis.

### Site profiles — how ONE database serves 28+ different sites

```
sites (id PK, slug UNIQUE, domain, name, kind,
       niches_json,          -- which niches this site shows (empty = all)
       visible_fields_json,  -- PUBLIC PROJECTION: only these columns are exported
       hidden_fields_json,   -- explicit denies (always win)
       index_fields_json,    -- fields for the lightweight client search index
       card_fields_json,     -- fields on the collapsed 3-card view
       detail_fields_json,   -- fields on the expanded / detail page
       slug_template,        -- e.g. /{country}/{state}/{city}/{name}-{uid}
       theme_json, created_at, updated_at)
```

> **Not every column is visible on every site**, even when it exists in your data.
> The export writes only the projection a site declares.
>
> **Slug templates are data**, rendered from each record's own fields — so the same
> place produces the correct URL on any domain you publish it to, automatically.

### Places (the canonical entity — one row per real-world place)
```
places (uid PK, canonical_name, name_norm, slug,
        lat, lng, geohash13, digipin, spatial_cell,
        country_iso2, state_lgd, district_lgd, block_lgd, village_lgd, pincode,
        address, phone, phone_norm, email, website,
        status, quality_score, priority, popularity,
        source, source_ref, created_at, updated_at, verified_at, merged_into)
```

### Many-to-many: one place ↔ many niches (this is your "relationability")
```
place_niches (id PK, place_uid FK, niche_id FK, listing_code UNIQUE,
              title, description, attributes_json,
              status, quality_score, created_at, updated_at,
              UNIQUE(place_uid, niche_id))
```
→ A tailor shop can live on `tailorshopnearme` **and** the master map, with
different fields in each, without duplicating the place.

### Detail tables
```
place_media    (id PK, place_uid FK, url, kind, license, credit, sort_order)
place_hours    (id PK, place_uid FK, day_of_week, open_time, close_time)
place_reviews  (id PK, place_uid FK, niche_id FK, rating, body, author, status, created_at)
place_keywords (id PK, place_uid FK, niche_id FK, keyword, kind,
                volume_estimate, source, approved)   -- owner-suggested SEO keywords
```

### Safety (aggregated only — never per-place accusation)
```
risk_reports (id PK, area_lgd, spatial_cell, slot, kind, severity, reported_at, status)
place_risk   (place_uid PK, slot, risk_level, score, hex)
```

### Ingestion / staging
```
submissions   (id PK, niche_id, payload_json, submitted_by, ip_hash,
               user_agent, status, reviewer, reviewed_at, promoted_place_uid, created_at)
import_batches (id PK, source_file, mapping_json, rows_total, rows_ok, rows_failed, created_at)
import_errors  (id PK, batch_id FK, row_no, column, message, raw_json)
```

### System
```
audit_log       (id PK, actor, action, table_name, row_pk, before_json, after_json, at)
saved_views     (id PK, name, table_name, filter_json, sort_json, columns_json)
schema_migrations (id PK, description, sql, applied_at)
```

`saved_views` + the column-move engine are what deliver your **"adjust my mental
mapping / adjust the view"** requirement.

---

## 4. Numbering system (your "global spatial numbering" + Justdial-style niche codes)

| Kind | Form | Purpose |
|---|---|---|
| **Global place uid** | 10-char Crockford base32, immutable | Stable identity, appears in slugs, never reused |
| **Niche listing code** | `<PREFIX>-<REGION>-<SEQ>` with ISO 3166-2 region, e.g. `TSH-INDL-000123`, `TSH-USNY-000042` | Human-typeable, justdial-like, **worldwide**; a city token can be added later as data matures; numeric tail lengthens as a niche grows |
| **Spatial cell** | geohash5 (coarse) | Clustering / map filtering |
| **Micro spatial** | geohash13 (~4.7 mm) | Drone/utility precision |
| **India digital address** | DIGIPIN (10-char) | Official-style address code |

**Client-side filter cascade** (this is your ~90% data reduction):
`niche → category → spatial cell → text`. A niche page loads only its own
lightweight `index.json`; full detail is lazy-loaded per place.

---

## 5. Feature set

### 5.1 Generic importer (build first — you need volume, not UI polish)
1. Drop any CSV / Excel / JSON / SQLite / GeoJSON.
2. Preview first N rows; sniff delimiter, encoding, types.
3. **Column mapper:** map N arbitrary source columns → M target columns.
   Saved as a reusable **mapping template** per source shape.
4. Validate → dry run → commit inside a transaction. Per-row error report.
5. Idempotent: re-importing the same file updates rather than duplicates.

### 5.2 Schema / view editor
- Create/rename/retype tables and columns from the UI (no SQL writing).
- **Move a column** between tables, with preview. Two modes:
  - **normalize** — extract repeated values into a related table + FK (IDs preserved)
  - **relocate** — move the column and keep a reference link
- `saved_views` — save filter + sort + column layouts; flip between "mental maps"

### 5.3 Enrichment — turning address-only listings into points

Cascade, cheapest and fastest first, refined by crowdsourcing over time:

1. **PIN code → lat/lng** from your own pincode table, seeded from free government
   and open datasets (data.gov.in, India Post, open GitHub mirrors already carrying
   lat/lng and DIGIPIN). Bulk, offline, instant — covers most of your 1,200 rows.
2. **Area / locality → centroid** where the PIN is ambiguous or missing.
3. **Nominatim (OSM)** street-level lookup for what the first two can't place —
   rate-limited and cached locally.
4. **Manual map-fix screen** for anything that matters; paid listings first.
5. **Crowdsourcing** drifts every pin toward truth over time.

⚠️ Community pincode/DIGIPIN datasets vary in licence and accuracy, and the official
DIGIPIN grid parameters are unpublished — so store `digipin_source` next to the value
and keep the resolver swappable.

Then auto-compute `geohash13`, DIGIPIN, spatial cell and the full admin hierarchy;
score quality; detect duplicates (name + geohash + phone fuzzy match) with a merge tool.

### 5.4 Exporter (format-agnostic — you'll approve formats later)
`tables/*.json` · `tables/*.csv` · `schema.sql` · `dump.sql` · `vault.db` ·
`niches/<slug>/index.json` (lightweight search index) ·
`niches/<slug>/places.json` (full, joined) · `geojson/*` · optional geohash tiles.
Saved **export recipes** so you approve once and rerun forever.

### 5.5 Crowdsource inbox
- I define the `submissions` table + a local `vault pull` command.
- Review queue locally → approve → merges into `places` → export → commit.

---

## 6. Phases

| Phase | Deliverable | Status |
|---|---|---|
| **0** | `vault.db` + schema (22 tables) + `vault` CLI + live preview server | ✅ **done & verified** |
| **1** | Generic importer + column mapper | ✅ **done** — CSV/TSV/JSON/JSONL/GeoJSON/**XLSX**, `inspect` preview, auto-suggested + saved mappings, idempotent upsert, read-only `query` |
| **2** | Enrichment (PIN→lat/lng cascade, geohash13, DIGIPIN, admin joins) + dedupe/merge | ✅ **done & verified** — 8/8 places resolved to a PIN centroid with geohash13, DIGIPIN and district links; duplicate groups detected and merged with stable ids |
| **3** | Exporter: all formats + export recipes + per-site projections + encrypted tiles | ✅ **done & verified** |
| **4** | Local web portal (tables, interactive map pin editor, column moves, moderation queue) | ✅ **done & verified** |
| **5** | Supabase inbox pull + review/merge | pending |
| **6** | `templates/` starter (Astro SSG + PWA + Leaflet) — optional | pending |

### Phase 1 known limits

- ~~`.xlsx` is not readable yet~~ ✅ **resolved** — `vault/lib/xlsx.js` reads genuine
  workbooks with **zero dependencies**: shared strings, numbers, booleans, date
  formats, sparse cell references (gaps), multiple worksheets, and sheet selection
  via `vault inspect --sheet <name>` / `import --sheet`. Still unsupported: `.xls`
  (legacy binary), `.xlsm`, encrypted workbooks and ZIP64 — save those as `.xlsx`.
  `tools/make-test-xlsx.py` regenerates the verification fixture.
- **Moving a column between tables** (the "adjust my mental mapping" feature) lands
  in Phase 4 with the portal. The importer can already *map* any source column to
  any target column, which covers most of the need today.

### Auto-mapping is deliberately conservative

A source column is mapped automatically only on an **exact** or **synonym** match.
A loose substring match is allowed solely for safe text columns — never for
timestamps, identity or geo fields (`verified_at`, `created_at`, `lat`, `uid`, …),
because mapping a boolean like `Verified` onto a timestamp silently writes bad data.
Unknown columns such as `Rating`, `Notes` or `Listed On` are left **skipped** so you
can map them deliberately rather than inherit a wrong guess.

### ⚠️ Reference data currently in the database is TEST FIXTURE ONLY

`data/sample-admin.TEST-FIXTURE.csv` and `data/sample-pincodes.TEST-FIXTURE.csv`
exist so the enrichment cascade can be exercised end to end. Their coordinates are
**approximate and illustrative**, and their codes are **not real LGD codes**.

Replace both with your real LGD and India Post datasets before trusting any
coordinates. The loaders are idempotent, so re-running them over the real files
overwrites the fixtures cleanly — then run `enrich --recompute`.

---

## 7. Decisions locked

| Decision | Chosen |
|---|---|
| Storage | SQLite working DB + portable JSON/SQL committed to the private repo |
| Portal | Local web app on localhost, **plus CLI equivalents** (cheap to repeat) |
| Column moves | Both modes — normalize into a related table, or relocate keeping a link |
| Coordinates | Both paths — compute where lat/lng exists, geocode + map-fix the rest |
| Raw data | Generic importer first; real files supplied later |
| Export | All formats + saved export recipes; you approve the shape later |
| Supabase | Inbox only; I define `submissions` and the local pull |
| Listing codes | Worldwide `<PREFIX>-<CC><REGION>-<SEQ>`, expandable numeric tail |
| Build path | Build data locally + push; niche repos auto-build on CF Pages |
| Admin hierarchy | Fully user-editable tables (your LGD depth is uncertain) |
| Templates | Later, but built **here** — you want this portal's design language |

## 8. Known assets to reconcile with

| Asset | State | Implication |
|---|---|---|
| **SKM Studio Maps** (`skm-studio-map.vercel.app`) | Next.js 16 + React + Supabase, live, 1,200+ listings, 200+ cities, paid plans, `/add-business`, `/dashboard`, `/pricing` | A **commercial** directory with business claims and paid tiers. Its Supabase schema is your existing data model — I should extend it, not silently replace it. Vercel hobby tier blocks commercial use, hence the move to CF Pages. |
| **Supabase project** `timnrnmmmmuqmcnuaend` | Live (PostgREST responding) | Source of your current tables — I need the schema (§9). |
| **`spatial-vault.js` + client + dashboard** | Built and verified in this repo | Becomes the **spatial/enrichment + export** layer of the engine. |

### 8.1 Reconstructed from your public pages (verify me)

`/add-business` step 1 exposes your current place form, so your live schema is
roughly `businesses(name, category, city, area_locality, pincode, full_address,
is_owner_submitted, …)` plus Google auth, claims, a submissions queue, a
featured/plan flag and an admin dashboard (per `/roadmap` Phase 1).

| Field on the form | Required | Notes |
|---|---|---|
| Business Name | ✔ | |
| Category | ✔ | flat list of ~27 values |
| City | ✔ | Delhi, New Delhi, Noida, Greater Noida, Gurgaon, Gurugram, Faridabad, Ghaziabad, Gorakhpur, NOIDA Extension, Dwarka, Rohini, Laxmi Nagar, Janakpuri |
| Area / Locality | ✗ | |
| PIN Code | ✗ | |
| Full Address | ✗ | |
| Are you the business owner? | ✗ | yes / submitting-on-behalf |

> ⚠️ **The form captures no latitude/longitude.** Most of your 1,200 listings are
> therefore address-only, which makes geocoding plus a map-fix screen a
> **Phase 2 priority**, not a nice-to-have.

Roadmap items that affect the engine:

- **Phase 1 (live):** community submissions, claim-your-listing, Google Sign-In, admin dashboard.
- **Phase 2:** photos, reviews/ratings, business hours (open/closed), map view.
- **Phase 3:** planned **Google Maps API** — ⚠️ requires a card and per-request billing.
  Leaflet + OSM does the same job here for free; we should **not** adopt it.
- **Phase 4:** planned **bulk business import tools** — that *is* this engine, already on your roadmap.
- **Money:** ₹999/yr featured → ₹15K–75K/mo SEO packages → Monetag ads today.

### 8.2 Still invisible to me (needs the §9 dump)

Auth/user tables · claims · plans & subscriptions · submissions queue ·
review/photo tables · RLS policies · anything not rendered on a public page.

## 9. What I need from you to avoid designing a parallel schema

Copy-paste both of these into the Supabase SQL editor and paste the results back
(or save them as `schema_export.txt` in the workspace):

```sql
-- 1. tables and columns
select table_name, ordinal_position, column_name, data_type, is_nullable, column_default
from information_schema.columns
where table_schema = 'public'
order by table_name, ordinal_position;

-- 2. foreign keys (your relations)
select tc.table_name, kcu.column_name, ccu.table_name as ref_table, ccu.column_name as ref_column
from information_schema.table_constraints tc
join information_schema.key_column_usage kcu on tc.constraint_name = kcu.constraint_name
join information_schema.constraint_column_usage ccu on ccu.constraint_name = tc.constraint_name
where tc.constraint_type = 'FOREIGN KEY' and tc.table_schema = 'public';
```

## 10. Status

**The design is complete enough to build.** The one outstanding input is your
Supabase dump (§9) — and it is now a **migration input, not a blocker**: the v1
schema treats your existing `businesses` shape as an *import source*, so Phase 0 can
start now and reconcile when the dump lands.

When it arrives I will still produce the extend-vs-rebuild comparison you asked for.
It decides how much of your live schema we keep verbatim versus normalise.

**Deferred and non-blocking:** your Excel / referrals system, and the ownership,
plan and billing tables (all additive — `priority` + `quality_score` already carry
paid ranking, and your tier ladder up to ₹5L/month can be layered on later).
