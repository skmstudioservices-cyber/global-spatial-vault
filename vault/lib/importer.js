'use strict';
/**
 * importer.js — the generic column-mapping importer.
 *
 * Pipeline:  read -> suggest/load mapping -> transform -> validate -> insert
 *
 * Nothing here is niche-specific: any source file can be mapped to any table.
 * A mapping is just `{ "Source Column": "target_column" | null }`, saved as a
 * reusable template so the same shape of file imports the same way forever.
 */
const path = require('node:path');
const fs = require('node:fs');
const sources = require('./sources');

/* ------------------------------------------------------------- utilities -- */

const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const nowIso = () => new Date().toISOString();

/** 10-char Crockford base32 id: sortable timestamp prefix + random tail. */
function newUid() {
  let n = BigInt(Date.now());
  let out = '';
  for (let i = 0; i < 8; i += 1) { out = B32[Number(n & 31n)] + out; n >>= 5n; }
  let tail = '';
  for (let i = 0; i < 2; i += 1) tail += B32[Math.floor(Math.random() * 32)];
  return out + tail;
}

/** Lowercase, strip punctuation, collapse whitespace — the dedupe key. */
function normName(value) {
  return String(value == null ? '' : value)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const normKey = (s) => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]/g, '');

/* ---------------------------------------------- mapping suggestion tables -- */

const SYNONYMS = {
  canonical_name: ['name', 'businessname', 'shopname', 'storename', 'firmname', 'companyname', 'placename', 'title', 'listingname', 'business', 'establishment'],
  external_id: ['id', 'businessid', 'shopid', 'placeid', 'skuid', 'reference', 'ref', 'code', 'externalid', 'listingid'],
  category_text: ['category', 'categories', 'type', 'businesstype', 'industry', 'sector', 'vertical', 'subcategory', 'tags', 'keywords'],
  city: ['city', 'town', 'municipality', 'corporation'],
  locality: ['arealocality', 'area', 'locality', 'neighbourhood', 'neighborhood', 'sublocality', 'sector', 'colony', 'mohalla', 'ward', 'block', 'village'],
  state_text: ['state', 'province', 'region'],
  pincode: ['pincode', 'pin', 'pincode', 'zip', 'zipcode', 'postalcode', 'postcode'],
  address: ['fulladdress', 'address', 'addressline', 'addressline1', 'streetaddress', 'street', 'location', 'landmark', 'premises'],
  lat: ['lat', 'latitude', 'y'],
  lng: ['lng', 'lon', 'long', 'longitude', 'x'],
  phone: ['phone', 'mobile', 'contact', 'phonenumber', 'contactnumber', 'telephone', 'tel', 'whatsapp', 'phone1'],
  email: ['email', 'emailaddress', 'mail'],
  website: ['website', 'url', 'site', 'web', 'link'],
  owner_submitted: ['areyouthebusinessowner', 'isowner', 'owner', 'businessowner', 'ownersubmitted', 'claimed'],
  description: ['description', 'about', 'details', 'summary', 'bio', 'overview'],
  status: ['status', 'state', 'active'],
  quality_score: ['qualityscore', 'quality', 'score'],
  priority: ['priority', 'rank', 'tier', 'plan', 'package', 'featured'],
  popularity: ['popularity', 'views', 'visits', 'clicks', 'impressions'],
  source: ['source', 'datasource', 'origin'],
  source_ref: ['sourceref', 'sourcereference', 'sheetrow', 'rowid'],
};

/**
 * Columns the *substring* fallback must never target. A loose partial match is
 * fine for a plain text field, but mapping a boolean like "Verified" onto
 * `verified_at`, or anything onto a timestamp, silently writes wrong data — so
 * these are reachable only by an exact or synonym match.
 */
const FALLBACK_BLOCKLIST = new Set([
  'uid', 'name_norm', 'slug', 'raw_json', 'created_at', 'updated_at', 'verified_at',
  'merged_into', 'lat', 'lng', 'geohash13', 'digipin', 'digipin_source', 'spatial_cell',
  'geo_source', 'geo_confidence', 'admin_id', 'country_iso2', 'source_ref',
]);

/** Target columns whose value needs interpretation before type coercion. */
const TRANSFORMS = {
  owner_submitted: (v) => (/^(1|true|yes|y|✅|✔)/i.test(String(v == null ? '' : v).trim()) ? 1 : 0),
  status: (v) => {
    const t = String(v == null ? '' : v).trim().toLowerCase();
    if (!t) return null;
    if (/(active|live|published|approved|verified|open)/.test(t)) return 'active';
    if (/(pending|review|moderation|submitted)/.test(t)) return 'pending';
    if (/(hidden|private|draft|inactive|unpublished)/.test(t)) return 'hidden';
    return t;
  },
};

/* ------------------------------------------- engine-supplied target columns -- */

// Filled by the engine when the source file has no matching column, so a plain
// CSV never trips the NOT NULL constraints on identity or timestamps.
const AUTO_COLUMNS = {
  places: ['uid', 'name_norm', 'raw_json', 'source', 'source_ref', 'created_at', 'updated_at'],
  default: ['created_at', 'updated_at'],
};

/* ---------------------------------------------------------------- schema -- */

function listTables(db) {
  return db.prepare(`SELECT name FROM sqlite_master
                     WHERE type='table' AND name NOT LIKE 'sqlite_%'
                     ORDER BY name`).all().map((r) => r.name);
}

function tableColumns(db, table) {
  if (!listTables(db).includes(table)) {
    throw new Error(`Unknown table: ${table}. Run \`vault tables\` to list them.`);
  }
  return db.prepare(`PRAGMA table_info("${table}")`).all();
}

/** Suggest a mapping from source headers to the target table's columns. */
function suggestMapping(sourceHeaders, columns) {
  const names = columns.map((c) => c.name);
  const byNorm = new Map(names.map((n) => [normKey(n), n]));
  const synonymToTarget = new Map();
  for (const [target, keys] of Object.entries(SYNONYMS)) {
    if (!byNorm.has(normKey(target))) continue;
    for (const k of keys) synonymToTarget.set(normKey(k), target);
  }

  const mapping = {};
  const used = new Set();
  for (const header of sourceHeaders) {
    const key = normKey(header);
    let target = null;
    if (byNorm.has(key) && !used.has(byNorm.get(key))) {
      target = byNorm.get(key);
    } else if (synonymToTarget.has(key) && !used.has(synonymToTarget.get(key))) {
      target = synonymToTarget.get(key);
    } else {
      // Last resort: a source header contained in / containing a column name.
      // Restricted to safe columns — never timestamps, identity or geo fields.
      const partial = names.find((n) => !used.has(n) && !FALLBACK_BLOCKLIST.has(n) &&
        key.length >= 4 && (key.includes(normKey(n)) || normKey(n).includes(key)));
      if (partial) target = partial;
    }
    mapping[header] = target || null;
    if (target) used.add(target);
  }
  return mapping;
}

function unmappedTargets(mapping, columns) {
  const mapped = new Set(Object.values(mapping).filter(Boolean));
  return columns.filter((c) => !mapped.has(c.name) && c.notnull && c.dflt_value === null && !c.pk);
}

/* ------------------------------------------------------------ coercion -- */

function coerce(value, type) {
  if (value == null) return null;
  const raw = typeof value === 'string' ? value.trim() : value;
  if (raw === '') return null;
  const t = String(type || '').toUpperCase();

  if (t.includes('INT')) {
    const n = Number(String(raw).replace(/[^\d.-]/g, ''));
    return Number.isFinite(n) ? Math.trunc(n) : null;
  }
  if (t.includes('REAL') || t.includes('FLOA') || t.includes('DOUB') || t.includes('NUM')) {
    const n = Number(String(raw).replace(/[^\d.-]/g, ''));
    return Number.isFinite(n) ? n : null;
  }
  if (t.includes('BOOL')) return /^(1|true|yes|y)$/i.test(String(raw)) ? 1 : 0;
  return typeof raw === 'string' ? raw : String(raw);
}

/* ------------------------------------------------------------ templates -- */

function loadMappingFile(file) {
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) throw new Error(`Mapping file not found: ${abs}`);
  const parsed = JSON.parse(fs.readFileSync(abs, 'utf8'));
  const mapping = parsed.mapping || parsed;
  return { mapping, targetTable: parsed.target_table || parsed.targetTable || null, name: parsed.name || path.basename(abs, '.json') };
}

function loadTemplate(db, name) {
  const row = db.prepare('SELECT * FROM import_mappings WHERE name = ?').get(name);
  if (!row) throw new Error(`No saved mapping named "${name}". Run \`vault mappings\` to list them.`);
  return { mapping: JSON.parse(row.mapping_json), targetTable: row.target_table, name: row.name };
}

function saveTemplate(db, name, targetTable, mapping, options = {}) {
  const at = nowIso();
  db.prepare(`INSERT INTO import_mappings (name, target_table, mapping_json, options_json, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?)
              ON CONFLICT(name) DO UPDATE SET
                target_table = excluded.target_table,
                mapping_json = excluded.mapping_json,
                options_json = excluded.options_json,
                updated_at   = excluded.updated_at`)
    .run(name, targetTable, JSON.stringify(mapping, null, 2), JSON.stringify(options), at, at);
}

function listTemplates(db) {
  try {
    return db.prepare('SELECT name, target_table, updated_at FROM import_mappings ORDER BY name').all();
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------ the import -- */

/**
 * Import a file into a table.
 *
 * opts: { file, table, mapping, dryRun, limit, source, onProgress }
 *   mapping — a resolved { sourceHeader: targetColumn|null } object, or null to
 *             auto-suggest.
 * Returns { table, mapping, rows, inserted, failed, errors, dryRun, unmapped }.
 */
function runImport(db, opts) {
  const {
    file, table, mapping: providedMapping = null,
    dryRun = false, limit = 0, source = null, onProgress = null,
  } = opts;

  const sourceLabel = source || path.basename(file, path.extname(file));

  const step = (task, done, total) => { if (onProgress) onProgress(task, done, total); };

  step('Reading file', 0, 5);
  const data = sources.readSource(file);

  step(`Parsed ${data.rows.length} rows (${data.format})`, 1, 5);
  const columns = tableColumns(db, table);
  const mapping = providedMapping || suggestMapping(data.headers, columns);

  // Validate every mapped target actually exists.
  const known = new Set(columns.map((c) => c.name));
  for (const [src, target] of Object.entries(mapping)) {
    if (target && !known.has(target)) {
      throw new Error(`Mapping points "${src}" at "${target}", which is not a column of ${table}`);
    }
  }
  const mappedPairs = Object.entries(mapping).filter(([, t]) => t);
  if (!mappedPairs.length) {
    throw new Error('Nothing mapped — every source column was skipped. Check the mapping.');
  }

  const srcColumns = mappedPairs.map(([s]) => s);
  const mappedTargets = mappedPairs.map(([, t]) => t);
  const columnInfo = new Map(columns.map((c) => [c.name, c]));

  // Append the columns the engine supplies itself (identity, search key,
  // provenance, timestamps) unless the source already mapped them.
  const autoColumns = (AUTO_COLUMNS[table] || AUTO_COLUMNS.default)
    .filter((c) => known.has(c) && !mappedTargets.includes(c));

  const targetColumns = [...mappedTargets, ...autoColumns];
  const mappedCount = mappedTargets.length;

  const missingRequired = unmappedTargets(mapping, columns)
    .filter((c) => !targetColumns.includes(c.name));
  const rows = limit > 0 ? data.rows.slice(0, limit) : data.rows;

  const isPlaces = table === 'places';
  const hasSourceRef = targetColumns.includes('source') && targetColumns.includes('source_ref');
  const conflictCols = isPlaces && hasSourceRef ? ['source', 'source_ref'] : null;

  const errors = [];
  let inserted = 0;
  let updated = 0;
  const batchStarted = nowIso();

  step(`Importing ${rows.length} rows into ${table}`, 2, 5);
  let batchId = null;
  if (!dryRun) {
    batchId = db.prepare(`INSERT INTO import_batches (source_file, mapping_json, rows_total, started_at)
                          VALUES (?, ?, ?, ?)`)
      .run(path.basename(file), JSON.stringify(mapping), rows.length, batchStarted).lastInsertRowid;
  }

  db.exec('BEGIN');
  try {
    const insertSql = buildInsert(table, targetColumns, conflictCols);
    const statement = db.prepare(insertSql);

    rows.forEach((rawRow, index) => {
      try {
        const values = targetColumns.map((col, i) => {
          if (i >= mappedCount) return null; // engine-supplied column, filled below
          const srcName = srcColumns[i];
          let value = rawRow[srcName];
          const transform = TRANSFORMS[col];
          if (transform) value = transform(value);
          const info = columnInfo.get(col);
          return coerce(value, info ? info.type : 'TEXT');
        });

        if (isPlaces) applyPlacesDefaults(targetColumns, values, rawRow, sourceLabel);
        applyTimestamps(targetColumns, values);

        statement.run(...values);
        inserted += 1;
      } catch (err) {
        const message = String(err.message || err).replace(/^UNIQUE constraint failed/, 'duplicate:');
        errors.push({ row_no: index + 2, message, raw: rawRow });
        if (!dryRun) {
          db.prepare(`INSERT INTO import_errors (batch_id, row_no, message, raw_json) VALUES (?, ?, ?, ?)`)
            .run(batchId, index + 2, message, JSON.stringify(rawRow));
        }
      }
      if (index % 25 === 0 || index === rows.length - 1) {
        step(`Importing rows (${index + 1}/${rows.length})`, 3, 5);
      }
    });

    if (!dryRun) {
      db.prepare(`UPDATE import_batches SET rows_ok = ?, rows_failed = ?, finished_at = ? WHERE id = ?`)
        .run(inserted, errors.length, nowIso(), batchId);
    }

    if (dryRun) db.exec('ROLLBACK');
    else db.exec('COMMIT');
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
    throw err;
  }

  step('Import finished', 4, 5);

  return {
    table,
    file: data.file,
    format: data.format,
    delimiter: data.delimiter || null,
    headers: data.headers,
    columns: data.columns,
    mapping,
    unmappedSource: Object.entries(mapping).filter(([, t]) => !t).map(([s]) => s),
    missingRequired: missingRequired.map((c) => c.name),
    rows: rows.length,
    inserted,
    updated,
    failed: errors.length,
    errors: errors.slice(0, 25),
    dryRun,
    batchId,
  };
}

function buildInsert(table, targetColumns, conflictCols) {
  const cols = targetColumns.map((c) => `"${c}"`).join(', ');
  const placeholders = targetColumns.map(() => '?').join(', ');
  let sql = `INSERT INTO "${table}" (${cols}) VALUES (${placeholders})`;
  if (conflictCols) {
    const set = targetColumns
      .filter((c) => !conflictCols.includes(c) && c !== 'uid' && c !== 'created_at')
      .map((c) => `"${c}" = excluded."${c}"`)
      .join(', ');
    sql += ` ON CONFLICT(${conflictCols.map((c) => `"${c}"`).join(', ')}) DO UPDATE SET ${set}`;
  }
  return sql;
}

/** Give every place an id, a search key and sane defaults. */
function applyPlacesDefaults(targetColumns, values, rawRow, sourceLabel) {
  const set = (col, value) => {
    const i = targetColumns.indexOf(col);
    if (i >= 0 && (values[i] == null || values[i] === '')) values[i] = value;
  };
  set('uid', newUid());
  const nameIdx = targetColumns.indexOf('canonical_name');
  if (nameIdx >= 0 && values[nameIdx]) set('name_norm', normName(values[nameIdx]));
  set('status', 'draft');
  set('raw_json', JSON.stringify(rawRow));
  if (sourceLabel) set('source', sourceLabel);

  // Carry a source id into source_ref so re-importing the same export UPDATES
  // rows instead of duplicating them (the unique index is on source+source_ref).
  const extIdx = targetColumns.indexOf('external_id');
  const refIdx = targetColumns.indexOf('source_ref');
  if (extIdx >= 0 && refIdx >= 0 && values[refIdx] == null && values[extIdx] != null) {
    values[refIdx] = String(values[extIdx]);
  }
}

function applyTimestamps(targetColumns, values) {
  const at = nowIso();
  for (const col of ['created_at', 'updated_at']) {
    const i = targetColumns.indexOf(col);
    if (i >= 0 && (values[i] == null || values[i] === '')) values[i] = at;
  }
}

module.exports = {
  runImport, suggestMapping, unmappedTargets, coerce, normName, normKey, newUid,
  listTables, tableColumns, loadMappingFile, loadTemplate, saveTemplate, listTemplates,
  SYNONYMS, TRANSFORMS,
};
