'use strict';
/**
 * classify.js — turn free-text `category_text` into real relationships.
 *
 * Your source data says "Tailor" or "Pharmacy" as text. To export per niche we
 * need (a) a row in the shared `categories` graph and (b) membership in every
 * niche whose match terms accept that text. Membership also mints the
 * Justdial-style listing code: <PREFIX>-<REGION>-<SEQ>, e.g. TSH-INDL-000001.
 *
 * All of it is derived from data (`niches.match_terms`), never hard-coded.
 */
const nowIso = () => new Date().toISOString();

const normalizeText = (s) => String(s == null ? '' : s)
  .toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();

const slugify = (s) => normalizeText(s).replace(/\s+/g, '-');

const ADMIN_CACHE = new WeakMap();

function adminLookup(db) {
  if (ADMIN_CACHE.has(db)) return ADMIN_CACHE.get(db);
  const rows = db.prepare('SELECT id, kind, code, parent_id FROM ref_admin').all();
  const byId = new Map(rows.map((r) => [r.id, r]));
  ADMIN_CACHE.set(db, byId);
  return byId;
}

/**
 * Region token for a listing code: the state code if the place is linked to a
 * state, else the nearest ancestor code, else the country. `IN-DL` -> `INDL`.
 */
function regionToken(byId, adminId, iso2) {
  let current = adminId;
  let guard = 0;
  let stateCode = null;
  let anyCode = null;
  while (current != null && guard < 32) {
    const node = byId.get(current);
    if (!node) break;
    if (node.code) {
      if (!anyCode) anyCode = node.code;
      if (node.kind === 'state') stateCode = node.code;
    }
    current = node.parent_id;
    guard += 1;
  }
  const code = stateCode || anyCode || iso2 || 'XX';
  return String(code).replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 6) || 'XX';
}

/** Does a place's category text belong to this niche? */
function matches(text, terms) {
  if (!text) return false;
  return terms.some((term) => {
    if (term.length < 4 && text !== term) return false;
    return text === term
      || text.includes(term)
      || (term.includes(text) && text.length >= 4);
  });
}

/**
 * Assign categories + niche memberships + listing codes.
 * Idempotent: an existing membership keeps its code.
 */
function classifyPlaces(db, opts = {}) {
  const { dryRun = false, onProgress = null } = opts;

  const niches = db.prepare('SELECT id, slug, code_prefix, match_terms, listing_format FROM niches').all()
    .map((n) => ({
      ...n,
      terms: String(n.match_terms || '').split(',').map(normalizeText).filter(Boolean),
    }))
    .filter((n) => n.terms.length);

  const places = db.prepare(`
    SELECT uid, canonical_name, category_text, admin_id, country_iso2
    FROM places WHERE status != 'merged' ORDER BY uid`).all();

  const byId = adminLookup(db);

  // Continue numbering from whatever codes already exist.
  const counters = new Map();
  for (const r of db.prepare('SELECT niche_id, listing_code FROM place_niches WHERE listing_code IS NOT NULL').all()) {
    const parts = String(r.listing_code).split('-');
    const n = Number(parts[parts.length - 1]);
    if (!Number.isFinite(n)) continue;
    const key = `${r.niche_id}|${parts.slice(0, -1).join('-')}`;
    counters.set(key, Math.max(counters.get(key) || 0, n));
  }

  const findCategory = db.prepare('SELECT id FROM categories WHERE slug = ?');
  const insertCategory = db.prepare('INSERT INTO categories (slug, name, sort_order) VALUES (?, ?, 0)');
  const linkCategory = db.prepare(`
    INSERT INTO place_category_map (place_uid, category_id, level, is_primary, weight)
    VALUES (?, ?, 1, ?, 0)
    ON CONFLICT(place_uid, category_id) DO UPDATE SET is_primary = MAX(is_primary, excluded.is_primary)`);
  const findMembership = db.prepare('SELECT id FROM place_niches WHERE place_uid = ? AND niche_id = ?');
  const insertMembership = db.prepare(`
    INSERT INTO place_niches (place_uid, niche_id, listing_code, status, priority, created_at, updated_at)
    VALUES (?, ?, ?, 'active', 0, ?, ?)`);

  const at = nowIso();
  const stats = { places: places.length, categoriesCreated: 0, linked: 0, memberships: 0, codesMinted: 0 };

  db.exec('BEGIN');
  try {
    places.forEach((place, index) => {
      const text = normalizeText(place.category_text);

      if (text) {
        const slug = slugify(place.category_text);
        let category = findCategory.get(slug);
        if (!category) {
          insertCategory.run(slug, String(place.category_text).trim());
          category = findCategory.get(slug);
          stats.categoriesCreated += 1;
        }
        if (category) {
          linkCategory.run(place.uid, category.id, 1);
          stats.linked += 1;
        }
      }

      const region = regionToken(byId, place.admin_id, place.country_iso2);
      for (const niche of niches) {
        if (!matches(text, niche.terms)) continue;
        if (findMembership.get(place.uid, niche.id)) continue;

        const prefix = `${niche.code_prefix}-${region}`;
        const key = `${niche.id}|${prefix}`;
        const next = (counters.get(key) || 0) + 1;
        counters.set(key, next);
        const code = `${prefix}-${String(next).padStart(6, '0')}`;

        insertMembership.run(place.uid, niche.id, code, at, at);
        stats.memberships += 1;
        stats.codesMinted += 1;
      }

      if (onProgress && (index % 25 === 0 || index === places.length - 1)) {
        onProgress(index + 1, places.length, place.canonical_name);
      }
    });

    if (dryRun) db.exec('ROLLBACK'); else db.exec('COMMIT');
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
    throw err;
  }

  return { ...stats, dryRun, niches: niches.length };
}

module.exports = { classifyPlaces, normalizeText, slugify, regionToken, matches };
