'use strict';
/**
 * watch.js — Spatial Vault Local Web Portal & Preview Server.
 *
 * Serves the full Phase 4 interactive local portal at http://localhost:4317:
 *   - Real-time build status & SSE progress monitor
 *   - Interactive Leaflet map editor with draggable pin-fixing
 *   - Database table explorer (all 22 tables)
 *   - One-click pipeline triggers (Enrich, Dedupe, Classify, Export)
 *   - Submissions moderation queue
 *   - Column reorganization tool
 *
 * Usage:
 *   node vault/cli.js watch          # http://localhost:4317
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { WEB, STATUS_FILE, DB_FILE, ensureDirs } = require('./lib/paths');
const status = require('./lib/status');
const db = require('./lib/db');
const enrich = require('./lib/enrich');
const classify = require('./lib/classify');
const exporter = require('./lib/export');
const importer = require('./lib/importer');
const spatial = require('../spatial-vault');

const PORT = Number(process.env.VAULT_PORT) || 4317;
const HOST = process.env.VAULT_HOST || '127.0.0.1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

function readRawStatus() {
  try {
    return fs.readFileSync(STATUS_FILE, 'utf8');
  } catch {
    return JSON.stringify(status.blank());
  }
}

const clients = new Set();
let lastPayload = '';

function broadcast(payload) {
  for (const res of clients) {
    try {
      res.write(`event: status\ndata: ${payload}\n\n`);
    } catch {
      clients.delete(res);
    }
  }
}

function sendFile(res, file) {
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      return res.end(`missing ${path.basename(file)}`);
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(data);
  });
}

function sendJson(res, data, code = 200) {
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
  });
  res.end(JSON.stringify(data));
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 2 * 1024 * 1024) {
        req.destroy();
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => {
      if (!body.trim()) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
  const pathname = parsedUrl.pathname;

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'content-type',
    });
    return res.end();
  }

  // 1. Static Web UI
  if (pathname === '/' || pathname === '/index.html' || pathname === '/preview.html') {
    return sendFile(res, path.join(WEB, 'preview.html'));
  }

  // 2. SSE Events
  if (pathname === '/api/events') {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      'access-control-allow-origin': '*',
    });
    res.write('retry: 3000\n\n');
    const payload = readRawStatus();
    res.write(`event: status\ndata: ${payload}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  // 3. Status JSON
  if (pathname === '/api/status') {
    return sendJson(res, JSON.parse(readRawStatus()));
  }

  // Database endpoints
  let database = null;
  const getDb = () => {
    if (!database) database = db.open();
    return database;
  };

  try {
    // 4. List Tables
    if (pathname === '/api/tables' && req.method === 'GET') {
      const d = getDb();
      const tables = d.prepare(`
        SELECT name FROM sqlite_master
        WHERE type='table' AND name NOT LIKE 'sqlite_%'
        ORDER BY name
      `).all();
      const summary = tables.map((t) => {
        const count = d.prepare(`SELECT count(*) as c FROM "${t.name}"`).get().c;
        const cols = d.prepare(`PRAGMA table_info("${t.name}")`).all();
        return { name: t.name, rows: count, columns: cols.map((c) => c.name) };
      });
      return sendJson(res, { ok: true, tables: summary });
    }

    // 5. Query Specific Table
    if (pathname.startsWith('/api/table/') && req.method === 'GET') {
      const tableName = decodeURIComponent(pathname.replace('/api/table/', ''));
      const d = getDb();
      const cols = d.prepare(`PRAGMA table_info("${tableName}")`).all();
      if (!cols.length) {
        return sendJson(res, { ok: false, error: `Table '${tableName}' not found` }, 404);
      }

      const limit = Math.min(100, Math.max(1, Number(parsedUrl.searchParams.get('limit')) || 50));
      const offset = Math.max(0, Number(parsedUrl.searchParams.get('offset')) || 0);
      const search = parsedUrl.searchParams.get('q') || '';

      let query = `SELECT * FROM "${tableName}"`;
      const params = [];
      if (search) {
        const textCols = cols.filter((c) => c.type.includes('TEXT') || c.type.includes('CHAR')).map((c) => `"${c.name}" LIKE ?`);
        if (textCols.length) {
          query += ` WHERE (${textCols.join(' OR ')})`;
          textCols.forEach(() => params.push(`%${search}%`));
        }
      }
      query += ` LIMIT ${limit} OFFSET ${offset}`;

      const rows = d.prepare(query).all(...params);
      const total = d.prepare(`SELECT count(*) as c FROM "${tableName}"`).get().c;

      return sendJson(res, {
        ok: true,
        table: tableName,
        columns: cols,
        rows,
        total,
        limit,
        offset,
      });
    }

    // 5b. Schema Relations Graph (Supabase-like relational view)
    if (pathname === '/api/schema/relations' && req.method === 'GET') {
      const d = getDb();
      const tableNames = d.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all().map((r) => r.name);
      const tables = [];
      const relations = [];

      for (const t of tableNames) {
        const cols = d.prepare(`PRAGMA table_info("${t}")`).all();
        const fks = d.prepare(`PRAGMA foreign_key_list("${t}")`).all();
        const count = d.prepare(`SELECT count(*) as c FROM "${t}"`).get().c;
        const pkCol = cols.find((c) => c.pk > 0)?.name || null;

        tables.push({
          name: t,
          rowCount: count,
          primaryKey: pkCol,
          columns: cols.map((c) => ({
            name: c.name,
            type: c.type || 'TEXT',
            notNull: !!c.notnull,
            isPk: c.pk > 0,
            default: c.dflt_value,
          })),
          foreignKeys: fks.map((fk) => ({
            from: fk.from,
            toTable: fk.table,
            toColumn: fk.to,
          })),
        });

        for (const fk of fks) {
          relations.push({
            fromTable: t,
            fromColumn: fk.from,
            toTable: fk.table,
            toColumn: fk.to,
          });
        }
      }

      return sendJson(res, { ok: true, tables, relations });
    }

    // 5c. Inline Cell Edit (Excel-like single cell update)
    if (pathname.startsWith('/api/table/') && pathname.endsWith('/cell') && req.method === 'PATCH') {
      const tableName = decodeURIComponent(pathname.replace('/api/table/', '').replace('/cell', ''));
      const body = await parseBody(req);
      const { pkColumn, pkValue, column, value } = body;

      if (!pkColumn || pkValue === undefined || !column) {
        return sendJson(res, { ok: false, error: 'pkColumn, pkValue, and column are required' }, 400);
      }

      const d = getDb();
      const valToSet = (value === '' || value === undefined) ? null : value;
      d.prepare(`UPDATE "${tableName}" SET "${column}" = ? WHERE "${pkColumn}" = ?`).run(valToSet, pkValue);

      // If updating coordinates in places table, re-derive spatial hashes
      if (tableName === 'places' && (column === 'lat' || column === 'lng')) {
        const p = d.prepare('SELECT lat, lng FROM places WHERE uid = ?').get(pkValue);
        if (p && p.lat != null && p.lng != null) {
          const lat = Number(p.lat);
          const lng = Number(p.lng);
          const geohash13 = spatial.encodeGeohash(lat, lng, 13);
          const cell = geohash13.slice(0, 5);
          const inIndia = spatial.isInIndia(lat, lng);
          const digipin = inIndia ? spatial.computeDigipin(lat, lng) : null;
          d.prepare(`UPDATE places SET geohash13 = ?, spatial_cell = ?, digipin = ?, geo_source = 'manual-edit' WHERE uid = ?`)
            .run(geohash13, cell, digipin, pkValue);
        }
      }

      try {
        d.prepare(`INSERT INTO audit_log (actor, action, table_name, row_pk, after_json, at) VALUES ('excel-editor', 'update-cell', ?, ?, ?, ?)`)
          .run(tableName, String(pkValue), JSON.stringify({ [column]: valToSet }), new Date().toISOString());
      } catch (e) { /* ignore */ }

      return sendJson(res, { ok: true, column, value: valToSet });
    }

    // 5d. Add New Row
    if (pathname.startsWith('/api/table/') && pathname.endsWith('/row') && req.method === 'POST') {
      const tableName = decodeURIComponent(pathname.replace('/api/table/', '').replace('/row', ''));
      const body = await parseBody(req);
      const row = body.row || {};
      const d = getDb();
      const now = new Date().toISOString();

      if (tableName === 'places') {
        if (!row.uid) row.uid = importer.newUid();
        if (row.canonical_name && !row.name_norm) row.name_norm = importer.normName(row.canonical_name);
        if (!row.status) row.status = 'active';
        if (!row.created_at) row.created_at = now;
        row.updated_at = now;
        if (row.lat != null && row.lng != null) {
          const lat = Number(row.lat);
          const lng = Number(row.lng);
          row.geohash13 = spatial.encodeGeohash(lat, lng, 13);
          row.spatial_cell = row.geohash13.slice(0, 5);
          if (spatial.isInIndia(lat, lng)) {
            row.digipin = spatial.computeDigipin(lat, lng);
          }
        }
      }

      const validCols = d.prepare(`PRAGMA table_info("${tableName}")`).all().map((c) => c.name);
      const cols = Object.keys(row).filter((k) => validCols.includes(k) && row[k] !== undefined);
      if (!cols.length) return sendJson(res, { ok: false, error: 'No valid table columns provided in row' }, 400);

      const placeholders = cols.map(() => '?').join(', ');
      const stmt = d.prepare(`INSERT INTO "${tableName}" (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${placeholders})`);
      const result = stmt.run(...cols.map((c) => row[c]));

      return sendJson(res, { ok: true, id: result.lastInsertRowid, row });
    }

    // 5e. Delete Row
    if (pathname.startsWith('/api/table/') && pathname.endsWith('/row') && req.method === 'DELETE') {
      const tableName = decodeURIComponent(pathname.replace('/api/table/', '').replace('/row', ''));
      const body = await parseBody(req);
      const { pkColumn, pkValue } = body;
      if (!pkColumn || pkValue === undefined) {
        return sendJson(res, { ok: false, error: 'pkColumn and pkValue required' }, 400);
      }
      const d = getDb();
      d.prepare(`DELETE FROM "${tableName}" WHERE "${pkColumn}" = ?`).run(pkValue);
      return sendJson(res, { ok: true, deleted: pkValue });
    }

    // 5f. Batch / Paste Import (from Excel / CSV / Sheets)
    if ((pathname.startsWith('/api/table/') && pathname.endsWith('/batch') && req.method === 'POST') ||
        (pathname === '/api/upload-import' && req.method === 'POST')) {
      const body = await parseBody(req);
      let targetTable = body.table;
      if (!targetTable && pathname.startsWith('/api/table/')) {
        targetTable = decodeURIComponent(pathname.replace('/api/table/', '').replace('/batch', ''));
      }
      targetTable = targetTable || 'places';

      const d = getDb();
      const validCols = d.prepare(`PRAGMA table_info("${targetTable}")`).all().map((c) => c.name);
      let rowsToInsert = [];

      if (body.text) {
        // Parse raw delimited text (TSV from Excel copy-paste or CSV)
        const lines = body.text.trim().split(/\r?\n/).filter((l) => l.trim().length > 0);
        if (lines.length > 0) {
          const delim = lines[0].includes('\t') ? '\t' : ',';
          const splitLine = (str) => {
            const arr = [];
            let cur = '';
            let q = false;
            for (let i = 0; i < str.length; i += 1) {
              const ch = str[i];
              if (ch === '"') {
                if (q && str[i + 1] === '"') { cur += '"'; i += 1; }
                else q = !q;
              } else if (ch === delim && !q) {
                arr.push(cur.trim()); cur = '';
              } else { cur += ch; }
            }
            arr.push(cur.trim());
            return arr;
          };

          const rawHeaders = splitLine(lines[0]);
          const headers = rawHeaders.map((h) => {
            const clean = h.replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase();
            return validCols.includes(clean) ? clean : (importer.SYNONYMS[clean] || h);
          });

          for (let i = 1; i < lines.length; i += 1) {
            const vals = splitLine(lines[i]);
            const r = {};
            headers.forEach((h, idx) => {
              if (validCols.includes(h)) r[h] = vals[idx] !== undefined && vals[idx] !== '' ? vals[idx] : null;
            });
            if (Object.keys(r).length) rowsToInsert.push(r);
          }
        }
      } else if (Array.isArray(body.rows)) {
        rowsToInsert = body.rows;
      }

      if (!rowsToInsert.length) {
        return sendJson(res, { ok: false, error: 'No valid rows detected to import' }, 400);
      }

      d.exec('BEGIN');
      try {
        const now = new Date().toISOString();
        let inserted = 0;
        for (const row of rowsToInsert) {
          if (targetTable === 'places') {
            if (!row.uid) row.uid = importer.newUid();
            if (row.canonical_name && !row.name_norm) row.name_norm = importer.normName(row.canonical_name);
            if (!row.status) row.status = 'active';
            if (!row.created_at) row.created_at = now;
            row.updated_at = now;
            if (row.lat != null && row.lng != null) {
              const lat = Number(row.lat);
              const lng = Number(row.lng);
              row.geohash13 = spatial.encodeGeohash(lat, lng, 13);
              row.spatial_cell = row.geohash13.slice(0, 5);
              if (spatial.isInIndia(lat, lng)) row.digipin = spatial.computeDigipin(lat, lng);
            }
          }
          const activeCols = Object.keys(row).filter((k) => validCols.includes(k) && row[k] !== undefined);
          if (activeCols.length) {
            const q = `INSERT OR REPLACE INTO "${targetTable}" (${activeCols.map((c) => `"${c}"`).join(', ')}) VALUES (${activeCols.map(() => '?').join(', ')})`;
            d.prepare(q).run(...activeCols.map((c) => row[c]));
            inserted += 1;
          }
        }
        d.exec('COMMIT');
        status.info(`Batch imported ${inserted} rows into ${targetTable}`);
        return sendJson(res, { ok: true, table: targetTable, count: inserted });
      } catch (err) {
        try { d.exec('ROLLBACK'); } catch (e) { /* ignore */ }
        return sendJson(res, { ok: false, error: err.message }, 500);
      }
    }

    // 6. Places list (for Map Editor)
    if (pathname === '/api/places' && req.method === 'GET') {
      const d = getDb();
      const places = d.prepare(`
        SELECT p.uid, p.canonical_name, p.address, p.city, p.state_text, p.pincode,
               p.lat, p.lng, p.geohash13, p.digipin, p.status, p.quality_score, p.geo_source,
               GROUP_CONCAT(n.slug, ', ') as niches
        FROM places p
        LEFT JOIN place_niches pn ON pn.place_uid = p.uid
        LEFT JOIN niches n ON n.id = pn.niche_id
        WHERE p.status != 'merged'
        GROUP BY p.uid
        ORDER BY p.canonical_name COLLATE NOCASE
      `).all();
      return sendJson(res, { ok: true, count: places.length, places });
    }

    // 7. Update Place Coordinates (Pin-Fixing)
    if (pathname === '/api/places/update-coords' && req.method === 'POST') {
      const body = await parseBody(req);
      const { uid, lat, lng } = body;
      if (!uid || lat == null || lng == null) {
        return sendJson(res, { ok: false, error: 'uid, lat, and lng are required' }, 400);
      }

      const numLat = Number(lat);
      const numLng = Number(lng);
      const geohash13 = spatial.encodeGeohash(numLat, numLng, 13);
      const cell = geohash13.slice(0, 5);
      const inIndia = spatial.isInIndia(numLat, numLng);
      const digipin = inIndia ? spatial.computeDigipin(numLat, numLng) : null;
      const now = new Date().toISOString();

      const d = getDb();
      const info = d.prepare(`
        UPDATE places
        SET lat = ?, lng = ?, geohash13 = ?, spatial_cell = ?,
            digipin = ?, digipin_source = ?, geo_source = 'manual-fix',
            geo_confidence = 1.0, updated_at = ?
        WHERE uid = ?
      `).run(numLat, numLng, geohash13, cell, digipin, inIndia ? 'spatial-vault/manual-pin' : null, now, uid);

      if (info.changes === 0) {
        return sendJson(res, { ok: false, error: `Place ${uid} not found` }, 404);
      }

      // Record audit log
      try {
        d.prepare(`
          INSERT INTO audit_log (actor, action, table_name, row_pk, after_json, at)
          VALUES ('web-portal', 'update-coords', 'places', ?, ?, ?)
        `).run(uid, JSON.stringify({ lat: numLat, lng: numLng, geohash13, digipin }), now);
      } catch (e) { /* audit is non-critical */ }

      status.info(`Pin updated for place ${uid}: (${numLat.toFixed(6)}, ${numLng.toFixed(6)}) -> ${geohash13}`);

      return sendJson(res, {
        ok: true,
        uid,
        lat: numLat,
        lng: numLng,
        geohash13,
        digipin,
        cell,
      });
    }

    // 8. Pipeline action trigger
    if (pathname.startsWith('/api/action/') && req.method === 'POST') {
      const actionName = pathname.replace('/api/action/', '');
      const d = getDb();

      if (actionName === 'enrich') {
        status.begin({ action: 'enrich', phase: 'Phase 2 — Enrichment' });
        const resStats = enrich.enrichPlaces(d, {
          recompute: true,
          onProgress: (i, tot, name) => status.setTask(`Enriching ${name}`, i, tot),
        });
        status.setDb(db.summary(d));
        status.done(`Enrich complete: ${resStats.scanned} scanned, ${resStats.withDigipin} with DIGIPIN`);
        return sendJson(res, { ok: true, stats: resStats });
      }

      if (actionName === 'dedupe') {
        status.begin({ action: 'dedupe', phase: 'Phase 2 — Deduplication' });
        const resMerge = enrich.mergeDuplicates(d, {
          dryRun: false,
          onProgress: (i, tot) => status.setTask('Merging duplicates', i, tot),
        });
        status.setDb(db.summary(d));
        status.done(`Dedupe complete: ${resMerge.merged} merged`);
        return sendJson(res, { ok: true, stats: resMerge });
      }

      if (actionName === 'classify') {
        status.begin({ action: 'classify', phase: 'Phase 2 — Classification' });
        const resClass = classify.classifyPlaces(d, {
          onProgress: (i, tot, name) => status.setTask(`Classifying ${name}`, i, tot),
        });
        status.setDb(db.summary(d));
        status.done(`Classified ${resClass.places} place(s) into niches`);
        return sendJson(res, { ok: true, stats: resClass });
      }

      if (actionName === 'export') {
        status.begin({ action: 'export', phase: 'Phase 3 — Distribution' });
        const resExp = exporter.runExport(d, {}, (step) => status.setTask(`Exporting ${step}`, 0, 1));
        status.setDb(db.summary(d));
        status.done(`Exported ${resExp.totals.files} file(s) (${(resExp.totals.bytes / 1024).toFixed(1)} KB)`);
        return sendJson(res, { ok: true, manifest: resExp });
      }

      return sendJson(res, { ok: false, error: `Unknown action ${actionName}` }, 400);
    }

    // 9. Submissions Queue
    if (pathname === '/api/submissions' && req.method === 'GET') {
      const d = getDb();
      const subs = d.prepare('SELECT * FROM submissions ORDER BY created_at DESC LIMIT 100').all();
      return sendJson(res, { ok: true, submissions: subs });
    }

    if (pathname.startsWith('/api/submissions/') && pathname.endsWith('/approve') && req.method === 'POST') {
      const id = Number(pathname.split('/')[3]);
      const d = getDb();
      const sub = d.prepare('SELECT * FROM submissions WHERE id = ?').get(id);
      if (!sub) return sendJson(res, { ok: false, error: 'Submission not found' }, 404);

      let payload = {};
      try { payload = JSON.parse(sub.payload_json); } catch (e) { /* ignore */ }

      const uid = payload.uid || `place_${Date.now()}`;
      const now = new Date().toISOString();
      d.prepare(`
        INSERT INTO places (uid, canonical_name, address, city, pincode, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'active', ?, ?)
        ON CONFLICT(uid) DO UPDATE SET updated_at = excluded.updated_at
      `).run(uid, payload.name || 'Unnamed', payload.address || '', payload.city || '', payload.pincode || '', now, now);

      d.prepare(`UPDATE submissions SET status = 'approved', promoted_place_uid = ?, reviewed_at = ? WHERE id = ?`).run(uid, now, id);
      return sendJson(res, { ok: true, promoted_place_uid: uid });
    }

    // 10. Column Moves (Normalize / Relocate)
    if (pathname === '/api/columns/move' && req.method === 'POST') {
      const body = await parseBody(req);
      const { mode, sourceTable, sourceColumn, targetTable, targetColumn } = body;
      const d = getDb();

      if (mode === 'preview') {
        const distinct = d.prepare(`
          SELECT DISTINCT "${sourceColumn}" as val, count(*) as count
          FROM "${sourceTable}"
          WHERE "${sourceColumn}" IS NOT NULL AND "${sourceColumn}" != ''
          GROUP BY "${sourceColumn}"
          ORDER BY count DESC
          LIMIT 20
        `).all();
        return sendJson(res, { ok: true, distinctValues: distinct });
      }

      if (mode === 'normalize') {
        const now = new Date().toISOString();
        const fkCol = `${targetTable}_id`;
        d.exec('BEGIN');
        try {
          d.exec(`CREATE TABLE IF NOT EXISTS "${targetTable}" (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            "${targetColumn}" TEXT UNIQUE,
            created_at TEXT
          )`);
          const distinct = d.prepare(`
            SELECT DISTINCT "${sourceColumn}" as val
            FROM "${sourceTable}"
            WHERE "${sourceColumn}" IS NOT NULL AND "${sourceColumn}" != ''
          `).all();

          const insertTarget = d.prepare(`INSERT OR IGNORE INTO "${targetTable}" ("${targetColumn}", created_at) VALUES (?, ?)`);
          distinct.forEach((r) => insertTarget.run(r.val, now));

          const cols = d.prepare(`PRAGMA table_info("${sourceTable}")`).all().map((c) => c.name);
          if (!cols.includes(fkCol)) {
            d.exec(`ALTER TABLE "${sourceTable}" ADD COLUMN "${fkCol}" INTEGER`);
          }

          d.exec(`
            UPDATE "${sourceTable}"
            SET "${fkCol}" = (SELECT id FROM "${targetTable}" WHERE "${targetTable}"."${targetColumn}" = "${sourceTable}"."${sourceColumn}")
            WHERE "${sourceColumn}" IS NOT NULL
          `);
          d.exec('COMMIT');
          return sendJson(res, { ok: true, fkColumn: fkCol, normalizedValues: distinct.length });
        } catch (err) {
          try { d.exec('ROLLBACK'); } catch (e) { /* ignore */ }
          return sendJson(res, { ok: false, error: err.message }, 500);
        }
      }

      return sendJson(res, { ok: false, error: 'Invalid move parameters' }, 400);
    }

  } catch (err) {
    console.error('API Error:', err);
    return sendJson(res, { ok: false, error: err.message }, 500);
  } finally {
    if (database) {
      try { database.close(); } catch (e) { /* ignore */ }
    }
  }

  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found');
});

// Push only when the status file actually changed.
fs.watchFile(STATUS_FILE, { interval: 700 }, () => {
  const payload = readRawStatus();
  if (payload !== lastPayload) {
    lastPayload = payload;
    broadcast(payload);
  }
});

// Comment heartbeat keeps idle SSE streams alive.
setInterval(() => {
  for (const res of clients) {
    try { res.write(': ping\n\n'); } catch { clients.delete(res); }
  }
}, 20000).unref();

server.listen(PORT, HOST, () => {
  console.log(`Spatial Vault local portal  ->  http://localhost:${PORT}`);
  console.log(`Interactive Map & Data UI   ->  http://localhost:${PORT}`);
  console.log(`Watching status file        ->  ${STATUS_FILE}`);
});

module.exports = { server };
