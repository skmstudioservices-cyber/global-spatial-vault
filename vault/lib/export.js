'use strict';
/**
 * export.js — turn the database into portable, committable assets.
 *
 * Outputs (default into `exports/`, which belongs to the private data repo):
 *
 *   schema.sql                     full DDL
 *   dump.sql                       data as INSERTs (portable restore)
 *   tables/<table>.json            one file per table, diff-friendly
 *   tables/<table>.csv             same, for spreadsheets
 *   niches/<slug>/index.json       LIGHTWEIGHT client search index
 *   niches/<slug>/places.json      full detail, projected per site
 *   niches/<slug>/site.json        the site profile (which field goes where)
 *   niches/<slug>/places.geojson   map-ready
 *   manifest.json                  counts + byte sizes for every artefact
 *
 * A site's `visible_fields` projection decides what actually ships, so the same
 * database serves every niche without leaking columns a site should not show.
 */
const fs = require('node:fs');
const path = require('node:path');
const { EXPORTS } = require('./paths');

const nowIso = () => new Date().toISOString();
const ensure = (dir) => fs.mkdirSync(dir, { recursive: true });

const DEFAULT_INDEX_FIELDS = ['uid', 'listing_code', 'canonical_name', 'city', 'lat', 'lng'];

/* ------------------------------------------------------------- primitives -- */

function writeJson(file, data) {
  ensure(path.dirname(file));
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  return { file, bytes: fs.statSync(file).size };
}

function csvCell(value) {
  if (value == null) return '';
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function writeCsv(file, columns, rows) {
  ensure(path.dirname(file));
  const lines = [columns.join(',')];
  for (const row of rows) lines.push(columns.map((c) => csvCell(row[c])).join(','));
  fs.writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');
  return { file, bytes: fs.statSync(file).size };
}

const sqlValue = (v) => {
  if (v == null) return 'NULL';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  if (typeof v === 'bigint') return String(v);
  return `'${String(v).replace(/'/g, "''")}'`;
};

const parseList = (json) => {
  if (!json) return null;
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) && v.length ? v : null;
  } catch {
    return String(json).split('|').map((s) => s.trim()).filter(Boolean);
  }
};

function listTables(db) {
  return db.prepare(`SELECT name FROM sqlite_master
                     WHERE type='table' AND name NOT LIKE 'sqlite_%'
                     ORDER BY name`).all().map((r) => r.name);
}

/* ---------------------------------------------------------------- formats -- */

function exportSchema(db, outDir) {
  const objects = db.prepare(`SELECT type, name, sql FROM sqlite_master
                              WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'
                              ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END, name`).all();
  const body = objects.map((o) => `${o.sql};`).join('\n\n');
  const file = path.join(outDir, 'schema.sql');
  ensure(outDir);
  fs.writeFileSync(file, `-- Spatial Vault schema\n-- generated ${nowIso()}\n\nPRAGMA foreign_keys = ON;\n\n${body}\n`, 'utf8');
  return { file, objects: objects.length, bytes: fs.statSync(file).size };
}

function exportDump(db, outDir, { tables, skip = [] } = {}) {
  const parts = [`-- Spatial Vault data dump\n-- generated ${nowIso()}\n`, 'PRAGMA foreign_keys = OFF;', 'BEGIN;'];
  let total = 0;
  for (const table of tables) {
    if (skip.includes(table)) continue;
    const rows = db.prepare(`SELECT * FROM "${table}"`).all();
    if (!rows.length) continue;
    const columns = Object.keys(rows[0]);
    parts.push(`\n-- ${table}: ${rows.length} row(s)`);
    for (const row of rows) {
      parts.push(`INSERT INTO "${table}" (${columns.map((c) => `"${c}"`).join(', ')}) VALUES (${columns.map((c) => sqlValue(row[c])).join(', ')});`);
    }
    total += rows.length;
  }
  parts.push('COMMIT;');
  const file = path.join(outDir, 'dump.sql');
  ensure(outDir);
  fs.writeFileSync(file, `${parts.join('\n')}\n`, 'utf8');
  return { file, rows: total, bytes: fs.statSync(file).size };
}

function exportTables(db, outDir, { tables, skip = [] } = {}) {
  const results = [];
  for (const table of tables) {
    if (skip.includes(table)) continue;
    const rows = db.prepare(`SELECT * FROM "${table}"`).all();
    const columns = rows.length
      ? Object.keys(rows[0])
      : db.prepare(`PRAGMA table_info("${table}")`).all().map((c) => c.name);

    const json = writeJson(path.join(outDir, 'tables', `${table}.json`), rows);
    const csv = writeCsv(path.join(outDir, 'tables', `${table}.csv`), columns, rows);
    results.push({ table, rows: rows.length, jsonBytes: json.bytes, csvBytes: csv.bytes });
  }
  return results;
}

/* ------------------------------------------------------------- projections -- */

function project(row, fields) {
  if (!fields) return { ...row };
  const out = {};
  for (const f of fields) if (row[f] !== undefined) out[f] = row[f];
  return out;
}

function renderSlug(template, row) {
  if (!template) return null;
  const slug = template.replace(/\{(\w+)\}/g, (_, key) => {
    const value = row[key];
    if (value == null) return '';
    return String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  });
  return slug.replace(/\/{2,}/g, '/').replace(/\/$/, '');
}

/* ----------------------------------------------------------------- niches -- */

function nicheRows(db, nicheId) {
  return db.prepare(`
    SELECT p.*,
           pn.listing_code, pn.title, pn.description, pn.attributes_json,
           pn.priority AS niche_priority, pn.status AS niche_status,
           n.slug AS niche_slug, n.name AS niche_name, n.code_prefix
    FROM place_niches pn
    JOIN places p ON p.uid = pn.place_uid
    JOIN niches n ON n.id = pn.niche_id
    WHERE pn.niche_id = ? AND p.status != 'merged' AND pn.status = 'active'
    ORDER BY pn.priority DESC, p.quality_score DESC, p.canonical_name COLLATE NOCASE`).all(nicheId);
}

function exportNiche(db, niche, site, outDir) {
  const rows = nicheRows(db, niche.id);
  const dir = path.join(outDir, 'niches', niche.slug);

  const visible = site ? parseList(site.visible_fields_json) : null;
  const hidden = new Set(site ? (parseList(site.hidden_fields_json) || []) : []);
  const indexFields = (site && parseList(site.index_fields_json)) || DEFAULT_INDEX_FIELDS;
  const cardFields = (site && parseList(site.card_fields_json)) || null;
  const detailFields = (site && parseList(site.detail_fields_json)) || null;
  const template = site ? site.slug_template : null;

  const decorate = (row) => {
    const filtered = {};
    for (const [k, v] of Object.entries(row)) {
      if (hidden.has(k)) continue;
      if (visible && !visible.includes(k) && !['uid', 'listing_code'].includes(k)) continue;
      filtered[k] = v;
    }
    const slug = renderSlug(template, { ...row, ...filtered });
    return { ...filtered, slug, _slug: slug };
  };

  const index = rows.map((r) => project(decorate(r), indexFields.length ? indexFields : DEFAULT_INDEX_FIELDS));
  const places = rows.map(decorate);

  const geo = {
    type: 'FeatureCollection',
    features: rows
      .filter((r) => r.lat != null && r.lng != null)
      .map((r) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [r.lng, r.lat] },
        properties: project(decorate(r), visible || ['uid', 'listing_code', 'canonical_name', 'city', 'lat', 'lng', 'digipin']),
      })),
  };

  const written = [
    writeJson(path.join(dir, 'index.json'), { niche: niche.slug, generatedAt: nowIso(), count: index.length, records: index }),
    writeJson(path.join(dir, 'places.json'), { niche: niche.slug, generatedAt: nowIso(), count: places.length, records: places }),
    writeJson(path.join(dir, 'places.geojson'), geo),
  ];

  if (site) {
    written.push(writeJson(path.join(dir, 'site.json'), {
      slug: site.slug,
      domain: site.domain,
      name: site.name,
      kind: site.kind,
      niche: niche.slug,
      slugTemplate: site.slug_template,
      cardFields,
      detailFields,
      indexFields,
      visibleFields: visible,
    }));
  }

  return {
    niche: niche.slug,
    site: site ? site.slug : null,
    records: rows.length,
    files: written.map((w) => ({ file: path.relative(outDir, w.file), bytes: w.bytes })),
  };
}

function exportTiles(db, outDir) {
  const rows = db.prepare(`
    SELECT p.*, GROUP_CONCAT(n.slug, ',') as niche_slugs
    FROM places p
    LEFT JOIN place_niches pn ON pn.place_uid = p.uid AND pn.status = 'active'
    LEFT JOIN niches n ON n.id = pn.niche_id
    WHERE p.status != 'merged' AND p.lat IS NOT NULL AND p.lng IS NOT NULL
    GROUP BY p.uid
  `).all();

  const records = rows.map((r, i) => {
    return spatial.normalizeRecord({
      name: r.canonical_name,
      lat: r.lat,
      lng: r.lng,
      city: r.city || '',
      country: r.country_iso2 || 'India',
      category: (r.niche_slugs && r.niche_slugs.split(',')[0]) || 'other',
      address: r.address || '',
      pincode: r.pincode || '',
      digipin: r.digipin || null,
      uid: r.uid,
    }, i + 1);
  });

  const grouped = spatial.groupByPrefix(records);
  const tileResults = [];
  for (const [prefix, recs] of Object.entries(grouped)) {
    tileResults.push(spatial.writeTile(prefix, recs, outDir));
  }
  const manifestData = spatial.buildManifest(tileResults, records.length);
  const encManifest = spatial.encryptJSON(manifestData);
  fs.writeFileSync(path.join(outDir, 'manifest.dat'), encManifest, 'utf8');

  return {
    recordCount: records.length,
    tileCount: tileResults.length,
    tiles: tileResults.map((t) => ({ prefix: t.prefix, count: t.count, bytes: t.bytes })),
  };
}

/* ---------------------------------------------------------------- recipes -- */

function saveRecipe(db, name, options) {
  const at = nowIso();
  db.prepare(`INSERT INTO export_recipes (name, options_json, created_at, updated_at)
              VALUES (?, ?, ?, ?)
              ON CONFLICT(name) DO UPDATE SET options_json = excluded.options_json, updated_at = excluded.updated_at`)
    .run(name, JSON.stringify(options, null, 2), at, at);
}

function loadRecipe(db, name) {
  const row = db.prepare('SELECT * FROM export_recipes WHERE name = ?').get(name);
  if (!row) throw new Error(`No saved export recipe named "${name}". Run \`vault recipes\` to list them.`);
  return { name: row.name, options: JSON.parse(row.options_json) };
}

function listRecipes(db) {
  try {
    return db.prepare('SELECT name, updated_at FROM export_recipes ORDER BY name').all();
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------------- main -- */

const spatial = require('../../spatial-vault');

const DEFAULT_OPTIONS = {
  formats: ['schema', 'dump', 'tables', 'niches', 'geojson', 'tiles'],
  skipTables: ['import_errors'],
  nicheSlugs: null,
  siteSlug: null,
};

/**
 * Run a full export. Returns a manifest describing every artefact written.
 */
function runExport(db, options = {}, onProgress) {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const outDir = opts.outDir ? path.resolve(opts.outDir) : EXPORTS;
  fs.rmSync(outDir, { recursive: true, force: true });
  ensure(outDir);

  const tables = listTables(db);
  const manifest = { generatedAt: nowIso(), outDir, formats: opts.formats, artefacts: {} };
  const step = (label) => { if (onProgress) onProgress(label); };

  if (opts.formats.includes('schema')) {
    step('schema.sql');
    const r = exportSchema(db, outDir);
    manifest.artefacts.schema = { file: 'schema.sql', objects: r.objects, bytes: r.bytes };
  }

  if (opts.formats.includes('tables')) {
    step('tables/*.json + *.csv');
    const results = exportTables(db, outDir, { tables, skip: opts.skipTables });
    manifest.artefacts.tables = {
      count: results.length,
      rows: results.reduce((a, t) => a + t.rows, 0),
      files: results,
    };
  }

  if (opts.formats.includes('dump')) {
    step('dump.sql');
    const r = exportDump(db, outDir, { tables, skip: opts.skipTables });
    manifest.artefacts.dump = { file: 'dump.sql', rows: r.rows, bytes: r.bytes };
  }

  if (opts.formats.includes('niches')) {
    const sites = db.prepare('SELECT * FROM sites').all();
    const niches = db.prepare('SELECT * FROM niches ORDER BY slug').all()
      .filter((n) => !opts.nicheSlugs || opts.nicheSlugs.includes(n.slug));

    const exported = [];
    for (const niche of niches) {
      step(`niches/${niche.slug}`);
      const memberships = db.prepare('SELECT COUNT(*) AS c FROM place_niches WHERE niche_id = ?').get(niche.id).c;
      if (!memberships) continue; // skip empty niches rather than emitting empty files

      let site = null;
      if (opts.siteSlug) {
        site = sites.find((s) => s.slug === opts.siteSlug) || null;
      } else {
        site = sites.find((s) => (parseList(s.niches_json) || []).includes(niche.slug)) || null;
        if (!site) site = sites.find((s) => s.kind === 'master') || null;
      }
      exported.push(exportNiche(db, niche, site, outDir));
    }
    manifest.artefacts.niches = {
      count: exported.length,
      records: exported.reduce((a, n) => a + n.records, 0),
      niches: exported,
    };
  }

  if (opts.formats.includes('tiles')) {
    step('encrypted tiles (.dat)');
    const r = exportTiles(db, outDir);
    manifest.artefacts.tiles = r;
  }

  manifest.totals = {
    files: fs.readdirSync(outDir, { recursive: true }).filter((f) => {
      try { return fs.statSync(path.join(outDir, f)).isFile(); } catch { return false; }
    }).length,
    bytes: 0,
  };
  const walk = (dir) => {
    let sum = 0;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      sum += entry.isDirectory() ? walk(full) : fs.statSync(full).size;
    }
    return sum;
  };
  manifest.totals.bytes = walk(outDir);

  writeJson(path.join(outDir, 'manifest.json'), manifest);
  return manifest;
}

module.exports = {
  runExport, exportSchema, exportDump, exportTables, exportNiche,
  saveRecipe, loadRecipe, listRecipes, renderSlug, project, parseList, DEFAULT_OPTIONS,
};
