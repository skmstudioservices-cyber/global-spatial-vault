'use strict';
/**
 * enrich.js — turn address-only listings into map points, then dedupe.
 *
 * The cascade (cheapest and most reliable first, per PLAN.md §5.3):
 *   1. it already has lat/lng        -> trust it
 *   2. PIN code -> centroid          -> from ref_pincode
 *   3. locality / city -> admin      -> from ref_admin
 *   4. nothing                       -> flagged `needs-geocode`
 * ...then geohash13, spatial cell and DIGIPIN are computed from the point, and
 * the admin / country links are resolved.
 *
 * The spatial maths is REUSED from spatial-vault.js — not reimplemented.
 */
const spatial = require('../../spatial-vault');

const CELL_PRECISION = 5;
const DIGIPIN_SOURCE = 'spatial-vault/reference-v1';
const nowIso = () => new Date().toISOString();

const norm = (s) => String(s == null ? '' : s)
  .toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();

/* ---------------------------------------------------------------- lookups -- */

function buildLookups(db) {
  const pincodes = new Map();
  for (const r of db.prepare('SELECT pincode, lat, lng, admin_id, country_iso2 FROM ref_pincode').all()) {
    pincodes.set(String(r.pincode), r);
  }
  const adminsByName = new Map();
  for (const r of db.prepare('SELECT id, name, kind, country_iso2, lat, lng FROM ref_admin').all()) {
    const key = norm(r.name);
    if (key && !adminsByName.has(key)) adminsByName.set(key, r);
  }
  const adminsById = new Map(
    db.prepare('SELECT id, name, kind, parent_id, country_iso2 FROM ref_admin').all().map((r) => [r.id, r])
  );
  return { pincodes, adminsByName, adminsById };
}

function countryFromChain(adminsById, adminId) {
  let current = adminId;
  let guard = 0;
  while (current != null && guard < 32) {
    const node = adminsById.get(current);
    if (!node) break;
    if (node.country_iso2) return node.country_iso2;
    current = node.parent_id;
    guard += 1;
  }
  return null;
}

/* ------------------------------------------------------------- enrichment -- */

/**
 * opts: { limit, dryRun, recompute, onProgress }
 * `recompute` re-derives every place, not just the ones missing coordinates.
 */
function enrichPlaces(db, opts = {}) {
  const { limit = 0, dryRun = false, recompute = false, onProgress = null } = opts;
  const lookups = buildLookups(db);

  const where = recompute
    ? `WHERE status != 'merged'`
    : `WHERE status != 'merged' AND (lat IS NULL OR lng IS NULL OR geohash13 IS NULL)`;
  const targets = db.prepare(`
    SELECT uid, canonical_name, lat, lng, pincode, city, locality, state_text,
           admin_id, country_iso2, geo_source
    FROM places ${where}
    ORDER BY uid
    ${limit > 0 ? `LIMIT ${Number(limit)}` : ''}`).all();

  const update = db.prepare(`
    UPDATE places SET
      lat = ?, lng = ?, geohash13 = ?, spatial_cell = ?,
      digipin = ?, digipin_source = ?,
      admin_id = COALESCE(?, admin_id),
      country_iso2 = COALESCE(?, country_iso2),
      geo_source = ?, geo_confidence = ?, updated_at = ?
    WHERE uid = ?`);

  const stats = {
    scanned: targets.length, alreadyHad: 0, fromPincode: 0,
    fromAdmin: 0, needsGeocode: 0, withDigipin: 0, adminResolved: 0, adminUnresolved: 0,
  };

  db.exec('BEGIN');
  try {
    targets.forEach((place, index) => {
      let { lat, lng } = place;
      let source = place.geo_source;
      let confidence = null;
      let adminId = place.admin_id;
      let iso2 = place.country_iso2;

      if (lat != null && lng != null && !recompute) {
        stats.alreadyHad += 1;
        source = source || 'provided';
        confidence = 0.9;
      } else {
        const pin = place.pincode ? lookups.pincodes.get(String(place.pincode)) : null;
        if (pin && pin.lat != null && pin.lng != null) {
          lat = pin.lat; lng = pin.lng;
          source = 'pincode'; confidence = 0.8;
          if (pin.admin_id) adminId = pin.admin_id;
          if (!iso2) iso2 = pin.country_iso2;
          stats.fromPincode += 1;
        } else {
          let matched = null;
          for (const candidate of [place.locality, place.city, place.state_text]) {
            const key = candidate ? norm(candidate) : '';
            if (!key) continue;
            const admin = lookups.adminsByName.get(key);
            if (admin && admin.lat != null && admin.lng != null) { matched = admin; break; }
          }
          if (matched) {
            lat = matched.lat; lng = matched.lng;
            source = 'admin-centroid'; confidence = 0.4;
            if (!adminId) adminId = matched.id;
            stats.fromAdmin += 1;
          } else {
            source = 'needs-geocode'; confidence = 0;
            stats.needsGeocode += 1;
          }
        }
      }

      if (adminId && !place.admin_id) stats.adminResolved += 1;
      if (!adminId) stats.adminUnresolved += 1;
      if (!iso2 && adminId) iso2 = countryFromChain(lookups.adminsById, adminId);

      let geohash13 = null;
      let cell = null;
      let digipin = null;
      let digipinSource = null;
      if (lat != null && lng != null) {
        geohash13 = spatial.encodeGeohash(lat, lng, spatial.GEOHASH_PRECISION);
        cell = geohash13.slice(0, CELL_PRECISION);
        if (spatial.isInIndia(lat, lng)) {
          digipin = spatial.computeDigipin(lat, lng);
          digipinSource = DIGIPIN_SOURCE;
          stats.withDigipin += 1;
          if (!iso2) iso2 = 'IN';
        }
      }

      update.run(
        lat, lng, geohash13, cell, digipin, digipinSource,
        adminId ?? null, iso2 ?? null, source, confidence, nowIso(), place.uid,
      );

      if (onProgress && (index % 25 === 0 || index === targets.length - 1)) {
        onProgress(index + 1, targets.length, place.canonical_name);
      }
    });
    if (dryRun) db.exec('ROLLBACK'); else db.exec('COMMIT');
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
    throw err;
  }

  return { ...stats, dryRun };
}

/* ---------------------------------------------------------------- dedupe -- */

/**
 * Group places that look like the same real entity. The bucket falls back from
 * PIN code to spatial cell to city, so duplicates are only suggested when the
 * name AND a locator agree.
 */
function findDuplicates(db, opts = {}) {
  const minGroup = opts.minGroup || 2;
  const rows = db.prepare(`
    SELECT name_norm,
           COALESCE(NULLIF(pincode, ''), NULLIF(spatial_cell, ''), NULLIF(city, ''), '') AS bucket,
           COUNT(*) AS n,
           GROUP_CONCAT(uid) AS uids
    FROM places
    WHERE status != 'merged' AND name_norm IS NOT NULL AND name_norm != ''
    GROUP BY name_norm, bucket
    HAVING COUNT(*) >= ?
    ORDER BY n DESC, name_norm`).all(minGroup);

  return rows.map((r) => ({
    name: r.name_norm,
    bucket: r.bucket,
    count: r.n,
    uids: String(r.uids).split(','),
  }));
}

/** Keep the best row of each duplicate group and point the rest at it. */
function mergeDuplicates(db, opts = {}) {
  const { dryRun = false, onProgress = null } = opts;
  const groups = findDuplicates(db, opts);
  const pick = db.prepare('SELECT uid, canonical_name, quality_score, priority, created_at FROM places WHERE uid = ?');
  const setMerged = db.prepare(`UPDATE places SET merged_into = ?, status = 'merged', updated_at = ? WHERE uid = ?`);

  const merges = [];
  db.exec('BEGIN');
  try {
    groups.forEach((group, index) => {
      const rows = group.uids.map((uid) => pick.get(uid)).filter(Boolean);
      // Survivor: best quality, then paid priority, then the earliest record.
      rows.sort((a, b) =>
        (b.quality_score - a.quality_score) ||
        (b.priority - a.priority) ||
        String(a.created_at).localeCompare(String(b.created_at)) ||
        String(a.uid).localeCompare(String(b.uid)));
      const survivor = rows[0];
      for (const loser of rows.slice(1)) {
        setMerged.run(survivor.uid, nowIso(), loser.uid);
        merges.push({ kept: survivor.uid, merged: loser.uid, name: survivor.canonical_name });
      }
      if (onProgress) onProgress(index + 1, groups.length, group.name);
    });
    if (dryRun) db.exec('ROLLBACK'); else db.exec('COMMIT');
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
    throw err;
  }

  return { groups: groups.length, merged: merges.length, merges, dryRun };
}

module.exports = { enrichPlaces, findDuplicates, mergeDuplicates, buildLookups, CELL_PRECISION, DIGIPIN_SOURCE };
