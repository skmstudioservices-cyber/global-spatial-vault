'use strict';
/**
 * reference.js — loaders for the hierarchy and PIN tables.
 *
 * These are deliberately NOT run through the generic importer: an admin tree is
 * hierarchical (each row points at a parent by *code*, but stores a parent *id*),
 * so it needs code resolution and cycle detection. Pincodes then resolve their
 * admin link the same way.
 *
 * Both loaders are idempotent — re-running updates instead of duplicating.
 */
const sources = require('./sources');
const spatial = require('../../spatial-vault');

const nowIso = () => new Date().toISOString();

/** Case/punctuation-insensitive accessor for a CSV row. */
function getter(row) {
  const map = new Map(Object.keys(row).map((k) => [k.toLowerCase().replace(/[^a-z0-9]/g, ''), k]));
  return (...names) => {
    for (const n of names) {
      const key = map.get(String(n).toLowerCase().replace(/[^a-z0-9]/g, ''));
      if (key === undefined) continue;
      const v = row[key];
      if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
    }
    return null;
  };
}

const num = (v) => {
  if (v == null) return null;
  const n = Number(String(v).replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n : null;
};

/* ------------------------------------------------------------- admin tree -- */

/**
 * Load an admin hierarchy (country -> state -> district -> ... -> village).
 * Columns: code, parent_code, kind, name, country_iso2, lat, lng.
 * Any depth is fine; the tree is walked parents-first.
 */
function loadAdminTree(db, file, onProgress) {
  const data = sources.readSource(file);
  const entries = new Map();

  for (const row of data.rows) {
    const g = getter(row);
    const code = g('code', 'lgdcode', 'admincode', 'id');
    const name = g('name', 'adminname', 'label');
    if (!code || !name) continue;
    entries.set(code, { g, code, name });
  }
  if (!entries.size) throw new Error('No rows with a usable "code" and "name" column');

  const ids = new Map();
  const upsert = db.prepare(`
    INSERT INTO ref_admin (parent_id, kind, code, name, country_iso2, lat, lng)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(kind, code) DO UPDATE SET
      parent_id    = excluded.parent_id,
      name         = excluded.name,
      country_iso2 = excluded.country_iso2,
      lat          = excluded.lat,
      lng          = excluded.lng`);
  const findId = db.prepare('SELECT id FROM ref_admin WHERE kind = ? AND code = ?');

  let inserted = 0;
  const ensure = (entry, stack) => {
    if (ids.has(entry.code)) return ids.get(entry.code);
    if (stack.includes(entry.code)) {
      throw new Error(`Cycle in admin tree: ${[...stack, entry.code].join(' -> ')}`);
    }
    const { g } = entry;
    const kind = g('kind', 'type', 'level', 'admintype') || 'unknown';
    const parentCode = g('parent_code', 'parentcode', 'parent', 'parentid');
    const countryIso2 = g('country_iso2', 'country', 'iso2');

    let parentId = null;
    if (parentCode) {
      parentId = entries.has(parentCode)
        ? ensure(entries.get(parentCode), [...stack, entry.code])
        : (ids.get(parentCode) ?? null);
    }

    upsert.run(
      parentId, kind, entry.code, entry.name, countryIso2,
      num(g('lat', 'latitude')), num(g('lng', 'lon', 'longitude'))
    );
    const id = findId.get(kind, entry.code).id;
    ids.set(entry.code, id);
    inserted += 1;
    if (onProgress && inserted % 25 === 0) onProgress(inserted, entries.size, entry.name);
    return id;
  };

  db.exec('BEGIN');
  try {
    let i = 0;
    for (const entry of entries.values()) {
      ensure(entry, []);
      i += 1;
      if (onProgress) onProgress(i, entries.size, entry.name);
    }
    db.exec('COMMIT');
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    throw err;
  }

  return { file: data.file, rows: data.rows.length, upserted: inserted };
}

/* --------------------------------------------------------------- pincodes -- */

/**
 * Load PIN codes. Columns: pincode, office_name, district_code, state_code,
 * country_iso2, lat, lng. `district_code` / `state_code` resolve to ref_admin.code.
 */
function loadPincodes(db, file, onProgress) {
  const data = sources.readSource(file);
  const adminByCode = new Map(
    db.prepare('SELECT id, code FROM ref_admin').all().map((r) => [r.code, r.id])
  );

  const upsert = db.prepare(`
    INSERT INTO ref_pincode (pincode, country_iso2, admin_id, office_name, lat, lng, geohash13, digipin, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(pincode) DO UPDATE SET
      country_iso2 = excluded.country_iso2,
      admin_id     = excluded.admin_id,
      office_name  = excluded.office_name,
      lat          = excluded.lat,
      lng          = excluded.lng,
      geohash13    = excluded.geohash13,
      digipin      = excluded.digipin,
      source       = excluded.source`);

  const label = `file:${require('node:path').basename(file)}`;
  let loaded = 0;
  let withoutAdmin = 0;
  let withoutCoords = 0;

  db.exec('BEGIN');
  try {
    let i = 0;
    for (const row of data.rows) {
      const g = getter(row);
      const pincode = g('pincode', 'pin', 'zip', 'postalcode', 'postcode');
      if (!pincode) continue;

      const lat = num(g('lat', 'latitude'));
      const lng = num(g('lng', 'lon', 'longitude'));
      const adminCode = g('district_code', 'admin_code', 'district', 'state_code');
      const adminId = adminCode ? (adminByCode.get(adminCode) ?? null) : null;
      if (!adminId && adminCode) withoutAdmin += 1;
      if (lat == null || lng == null) withoutCoords += 1;

      let geohash13 = null;
      let digipin = null;
      if (lat != null && lng != null) {
        geohash13 = spatial.encodeGeohash(lat, lng, spatial.GEOHASH_PRECISION);
        digipin = spatial.computeDigipin(lat, lng);
      }

      upsert.run(
        pincode, g('country_iso2', 'country', 'iso2'), adminId,
        g('office_name', 'officename', 'area', 'locality'),
        lat, lng, geohash13, digipin, label
      );
      loaded += 1;
      i += 1;
      if (onProgress && i % 25 === 0) onProgress(i, data.rows.length, pincode);
    }
    db.exec('COMMIT');
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    throw err;
  }

  return { file: data.file, rows: data.rows.length, loaded, withoutAdmin, withoutCoords };
}

/* ------------------------------------------------------------------ niches -- */

/** Load niche definitions. Columns: slug, name, code_prefix, match_terms, icon, default_zoom. */
function loadNiches(db, file, onProgress) {
  const data = sources.readSource(file);
  const at = nowIso();
  const upsert = db.prepare(`
    INSERT INTO niches (slug, name, code_prefix, match_terms, listing_format, icon, default_zoom, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(slug) DO UPDATE SET
      name           = excluded.name,
      code_prefix    = excluded.code_prefix,
      match_terms    = excluded.match_terms,
      listing_format = excluded.listing_format,
      icon           = excluded.icon,
      default_zoom   = excluded.default_zoom`);

  let loaded = 0;
  db.exec('BEGIN');
  try {
    let i = 0;
    for (const row of data.rows) {
      const g = getter(row);
      const slug = g('slug');
      if (!slug) continue;
      upsert.run(
        slug,
        g('name') || slug,
        (g('code_prefix', 'prefix', 'code') || slug.slice(0, 3)).toUpperCase(),
        g('match_terms', 'match', 'terms', 'synonyms'),
        g('listing_format', 'format'),
        g('icon'),
        num(g('default_zoom', 'zoom')) || 14,
        at,
      );
      loaded += 1;
      i += 1;
      if (onProgress && i % 10 === 0) onProgress(i, data.rows.length, slug);
    }
    db.exec('COMMIT');
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    throw err;
  }
  return { file: data.file, rows: data.rows.length, loaded };
}

/* ------------------------------------------------------------------- sites -- */

/** Turn a pipe-separated field list (or a JSON array) into a JSON array string. */
function fieldList(value) {
  if (value == null || String(value).trim() === '') return null;
  const text = String(value).trim();
  if (text.startsWith('[')) return text; // already JSON
  const list = text.split('|').map((s) => s.trim()).filter(Boolean);
  return list.length ? JSON.stringify(list) : null;
}

/**
 * Load site profiles. Columns: slug, domain, name, kind, niches, visible_fields,
 * index_fields, card_fields, detail_fields, slug_template.
 * Field lists are pipe-separated: `uid|canonical_name|city`.
 */
function loadSites(db, file, onProgress) {
  const data = sources.readSource(file);
  const at = nowIso();
  const upsert = db.prepare(`
    INSERT INTO sites (slug, domain, name, kind, niches_json, visible_fields_json,
      hidden_fields_json, index_fields_json, card_fields_json, detail_fields_json,
      slug_template, theme_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(slug) DO UPDATE SET
      domain             = excluded.domain,
      name               = excluded.name,
      kind               = excluded.kind,
      niches_json        = excluded.niches_json,
      visible_fields_json= excluded.visible_fields_json,
      hidden_fields_json = excluded.hidden_fields_json,
      index_fields_json  = excluded.index_fields_json,
      card_fields_json   = excluded.card_fields_json,
      detail_fields_json = excluded.detail_fields_json,
      slug_template      = excluded.slug_template,
      theme_json         = excluded.theme_json,
      updated_at         = excluded.updated_at`);

  let loaded = 0;
  db.exec('BEGIN');
  try {
    let i = 0;
    for (const row of data.rows) {
      const g = getter(row);
      const slug = g('slug');
      if (!slug) continue;
      upsert.run(
        slug,
        g('domain'),
        g('name') || slug,
        g('kind', 'type') || 'niche',
        fieldList(g('niches', 'niches_json')),
        fieldList(g('visible_fields', 'visible')),
        fieldList(g('hidden_fields', 'hidden')),
        fieldList(g('index_fields', 'index')),
        fieldList(g('card_fields', 'card')),
        fieldList(g('detail_fields', 'detail')),
        g('slug_template', 'template'),
        g('theme_json', 'theme'),
        at, at,
      );
      loaded += 1;
      i += 1;
      if (onProgress && i % 10 === 0) onProgress(i, data.rows.length, slug);
    }
    db.exec('COMMIT');
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    throw err;
  }
  return { file: data.file, rows: data.rows.length, loaded };
}

module.exports = { loadAdminTree, loadPincodes, loadNiches, loadSites, getter, num, nowIso, fieldList };
