#!/usr/bin/env node
'use strict';
/**
 * cli.js — the `vault` command.
 *
 *   node vault/cli.js init            create the database and apply migrations
 *   node vault/cli.js watch           live preview at http://localhost:4317
 *   node vault/cli.js status          print a summary in the terminal
 *   node vault/cli.js doctor          check the environment
 *   node vault/cli.js import <file>   (Phase 1 — generic column-mapping importer)
 *   node vault/cli.js export          (Phase 2 — multi-format export)
 *
 * Every command writes its progress to state/status.json, which the preview
 * server streams to the browser. Nothing here contacts the network.
 */
require('./lib/quiet');

const fs = require('node:fs');
const path = require('node:path');

const status = require('./lib/status');
const db = require('./lib/db');
const importer = require('./lib/importer');
const sources = require('./lib/sources');
const reference = require('./lib/reference');
const enrich = require('./lib/enrich');
const classify = require('./lib/classify');
const exporter = require('./lib/export');
const { ROOT, STATE, DATA, EXPORTS, DB_FILE, VAULT, ensureDirs } = require('./lib/paths');

const PHASE = 'Phase 0 — Foundation';

/* ------------------------------------------------------------------ helpers */

const fmtBytes = (n) => {
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
};

const fmtMs = (ms) => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);

// Switch flags never swallow the following token, so `import --dry-run file.csv`
// works as expected while `--table places` still takes its value.
const BOOLEAN_FLAGS = new Set(['dry-run', 'yes', 'json', 'help', 'no-header']);

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) {
        args[a.slice(2, eq)] = a.slice(eq + 1);
        continue;
      }
      const key = a.slice(2);
      const next = argv[i + 1];
      if (!BOOLEAN_FLAGS.has(key) && next !== undefined && !next.startsWith('--')) {
        args[key] = next;
        i += 1;
      } else {
        args[key] = true;
      }
    } else {
      args._.push(a);
    }
  }
  return args;
}

function printSummary(info, result, startedAt) {
  const totalRows = info.tables.reduce((a, t) => a + Math.max(0, t.rows), 0);
  console.log('');
  console.log('  Database      ', DB_FILE);
  console.log('  Size          ', fmtBytes(info.sizeBytes));
  console.log('  Journal       ', info.journal, '· foreign keys', info.foreignKeys ? 'on' : 'off');
  console.log('  Tables        ', info.tables.length, `(${totalRows.toLocaleString()} rows total)`);
  console.log('  Migrations    ', `${result.applied}/${result.total}`, result.ranNow ? `(${result.ranNow} applied now)` : '(up to date)');
  console.log('  Elapsed       ', fmtMs(Date.now() - startedAt));
  console.log('');
  if (info.tables.length) {
    for (const t of info.tables) {
      console.log(`    · ${t.name}${' '.repeat(Math.max(1, 26 - t.name.length))}${t.rows.toLocaleString()}`);
    }
    console.log('');
  }
}

/* ---------------------------------------------------------------- commands */

function cmdInit() {
  const startedAt = Date.now();
  status.begin({ action: 'init', phase: PHASE });
  status.info('Initialising Spatial Vault');

  ensureDirs();
  status.info(`state/ ready at ${STATE}`);
  status.setTask('Opening database', 0, 3);

  const database = db.open();
  status.info(`Database opened: ${DB_FILE}`);

  const files = db.listMigrations();
  status.info(`Found ${files.length} migration file(s) on disk`);
  status.setTask('Applying migrations', 1, 3);

  const result = db.migrate(database, (index, total, name) => {
    status.log('info', `applying ${name}`);
    status.setTask(`Applying ${name}`, index, total);
  });

  if (!result.ranNow) status.info('Schema already up to date');

  status.setTask('Introspecting schema', 2, 3);
  const info = db.summary(database);
  status.setDb(info);
  status.info(`${info.tables.length} tables present, ${result.applied} migration(s) applied`);
  database.close();

  status.setTask('Done', 3, 3);
  status.done('Schema is ready');

  console.log('');
  console.log('  Spatial Vault — init');
  printSummary(info, result, startedAt);
  console.log('  Next:  node vault/cli.js watch      (then open http://localhost:4317)');
  console.log('');
  return 0;
}

function cmdStatus() {
  ensureDirs();
  if (!fs.existsSync(DB_FILE)) {
    console.log('');
    console.log('  No database yet at', DB_FILE);
    console.log('  Run:  node vault/cli.js init');
    console.log('');
    return 0;
  }
  const database = db.open();
  const info = db.summary(database);
  const applied = info.migrations.length;
  const result = { applied, total: db.listMigrations().length, ranNow: 0 };
  database.close();

  status.setDb(info);
  console.log('');
  console.log('  Spatial Vault — status');
  printSummary(info, result, Date.now());

  const live = status.load();
  console.log('  Last action   ', live.action || '—', `(${live.state})`);
  console.log('  Preview       ', `http://localhost:${process.env.VAULT_PORT || 4317}`);
  console.log('');
  return 0;
}

function cmdWatch(args) {
  if (args.port) process.env.VAULT_PORT = String(args.port);
  ensureDirs();
  if (!fs.existsSync(DB_FILE)) {
    status.begin({ action: 'watch', phase: PHASE });
    status.warn('No database yet — the preview will show an empty schema until you run init');
    status.done('Waiting for init');
  }
  require('./watch');
  return null; // stays running
}

function cmdDoctor() {
  const checks = [];
  const add = (ok, label, detail) => checks.push({ ok, label, detail });

  const nodeMajor = Number(process.versions.node.split('.')[0]);
  add(nodeMajor >= 22, 'Node.js version', `v${process.versions.node} (needs >= 22 for built-in SQLite)`);

  let sqliteOk = false;
  let sqliteDetail = '';
  try {
    const { DatabaseSync } = require('node:sqlite');
    const probe = new DatabaseSync(':memory:');
    probe.exec('CREATE TABLE t (a INTEGER)');
    probe.close();
    sqliteOk = true;
    sqliteDetail = 'node:sqlite working (zero dependencies)';
  } catch (err) {
    sqliteDetail = err.message;
  }
  add(sqliteOk, 'SQLite', sqliteDetail);

  for (const [label, dir] of [['state/', STATE], ['data/', DATA], ['exports/', EXPORTS]]) {
    const exists = fs.existsSync(dir);
    add(exists, `${label} folder`, exists ? dir : `missing — will be created (${dir})`);
  }

  add(fs.existsSync(VAULT), 'vault/ engine', VAULT);
  add(db.listMigrations().length > 0, 'migrations', `${db.listMigrations().length} file(s) in vault/migrations`);
  add(fs.existsSync(DB_FILE), 'database file', fs.existsSync(DB_FILE) ? `${fmtBytes(db.fileSize())} at ${DB_FILE}` : `not created yet (${DB_FILE})`);

  console.log('');
  console.log('  Spatial Vault — doctor');
  console.log('');
  for (const c of checks) {
    console.log(`  ${c.ok ? '[ ok ]' : '[  ! ]'}  ${c.label.padEnd(18)}${c.detail}`);
  }
  console.log('');
  const bad = checks.filter((c) => !c.ok).length;
  console.log(bad === 0 ? '  Everything checks out.' : `  ${bad} item(s) need attention.`);
  console.log('');
  return bad === 0 ? 0 : 1;
}

function cmdTables(args) {
  ensureDirs();
  if (!fs.existsSync(DB_FILE)) {
    console.error('  No database yet. Run:  node vault/cli.js init');
    return 1;
  }
  const database = db.open();
  const names = importer.listTables(database);

  if (args.json) {
    const payload = names.map((n) => ({
      table: n,
      columns: importer.tableColumns(database, n).map((c) => ({
        name: c.name, type: c.type, notnull: !!c.notnull, pk: !!c.pk,
      })),
    }));
    console.log(JSON.stringify(payload, null, 2));
    database.close();
    return 0;
  }

  console.log('');
  console.log('  Spatial Vault — tables');
  console.log('');
  for (const name of names) {
    const cols = importer.tableColumns(database, name);
    let count = 0;
    try { count = database.prepare(`SELECT COUNT(*) AS c FROM "${name}"`).get().c; } catch { /* ignore */ }
    console.log(`  ${name}  —  ${cols.length} columns, ${count.toLocaleString()} rows`);
    console.log(`      ${cols.map((c) => c.name).join(', ')}`);
    console.log('');
  }
  database.close();
  return 0;
}

function cmdMappings() {
  ensureDirs();
  if (!fs.existsSync(DB_FILE)) {
    console.error('  No database yet. Run:  node vault/cli.js init');
    return 1;
  }
  const database = db.open();
  const list = importer.listTemplates(database);

  console.log('');
  console.log('  Spatial Vault — saved mappings');
  console.log('');
  if (!list.length) {
    console.log('  none yet. Save one with:');
    console.log('    node vault/cli.js import data/foo.csv --save-template my-source');
  } else {
    for (const m of list) {
      console.log(`  ${m.name.padEnd(24)}-> ${m.target_table}   (updated ${String(m.updated_at).slice(0, 19).replace('T', ' ')})`);
    }
  }
  console.log('');
  database.close();
  return 0;
}

function cmdImport(args) {
  const file = args._[1];
  if (!file) {
    console.error('  Usage: vault import <file> [--table places] [--template name] [--map file.json] [--limit N] [--dry-run] [--yes]');
    return 2;
  }
  ensureDirs();
  if (!fs.existsSync(DB_FILE)) {
    console.error('  No database yet. Run:  node vault/cli.js init');
    return 1;
  }

  const database = db.open();
  const table = args.table || 'places';

  let mapping = null;
  if (args.map) {
    mapping = importer.loadMappingFile(args.map).mapping;
  } else if (args.template) {
    mapping = importer.loadTemplate(database, args.template).mapping;
  }

  // A first-time auto-mapping is never committed by accident: it dry-runs until
  // you either add --yes or save it as a template.
  const autoSuggested = !mapping;
  const dryRun = !!args['dry-run'] || (autoSuggested && !args.yes);

  status.begin({ action: 'import', phase: 'Phase 1 — Ingestion' });
  status.info(`Reading ${path.basename(file)} into ${table}`);
  if (autoSuggested) status.info('No saved mapping given — auto-suggesting columns');

  let result;
  try {
    result = importer.runImport(database, {
      file,
      table,
      mapping,
      dryRun,
      limit: args.limit ? Number(args.limit) : 0,
      onProgress: (task, done, total) => status.setTask(task, done, total),
    });
  } catch (err) {
    status.fail(err.message);
    database.close();
    throw err;
  }

  if (typeof args['save-template'] === 'string') {
    importer.saveTemplate(database, args['save-template'], table, result.mapping, {
      delimiter: result.delimiter, format: result.format,
    });
    status.info(`Saved mapping template "${args['save-template']}"`);
  }

  status.setDb(db.summary(database));
  status.done(`${result.dryRun ? 'Dry run' : 'Imported'} ${result.inserted} row(s) into ${table}`);
  database.close();

  printImportResult(result, args);
  return 0;
}

function printImportResult(r, args) {
  const pad = Math.max(...Object.keys(r.mapping).map((k) => k.length), 14);
  const rows = Object.values(r.mapping).filter(Boolean).length;

  console.log('');
  console.log(`  Spatial Vault — import${r.dryRun ? '   (dry run — nothing committed)' : ''}`);
  console.log('');
  console.log('  File           ', r.file);
  console.log('  Format         ', r.format + (r.delimiter ? `   (delimiter ${JSON.stringify(r.delimiter)})` : ''));
  console.log('  Target table   ', r.table);
  console.log('  Rows read      ', r.rows.toLocaleString());
  console.log('  Columns mapped ', `${rows} of ${Object.keys(r.mapping).length}`);
  console.log(r.dryRun ? '  Would insert   ' : '  Inserted       ', r.inserted.toLocaleString());
  if (r.failed) console.log('  Failed         ', r.failed.toLocaleString());
  if (r.missingRequired && r.missingRequired.length) {
    console.log('  Unmapped reqd  ', r.missingRequired.join(', '));
  }

  console.log('');
  console.log('  MAPPING');
  for (const [src, tgt] of Object.entries(r.mapping)) {
    console.log(`    ${src.padEnd(pad)}  ${tgt ? `-> ${tgt}` : '   (skipped)'}`);
  }

  if (r.unmappedSource && r.unmappedSource.length) {
    console.log('');
    console.log('  SKIPPED SOURCE COLUMNS');
    console.log(`    ${r.unmappedSource.join(', ')}`);
  }

  if (r.errors && r.errors.length) {
    console.log('');
    console.log('  FIRST ERRORS');
    for (const e of r.errors.slice(0, 8)) console.log(`    row ${e.row_no}: ${e.message}`);
  }

  const rel = path.relative(ROOT, r.file) || r.file;
  console.log('');
  if (r.dryRun) {
    console.log('  Nothing was written. To commit:');
    console.log(`    node vault/cli.js import ${rel} --table ${r.table} --yes`);
    if (!args || !args['save-template']) {
      console.log('  To reuse this mapping forever:');
      console.log(`    node vault/cli.js import ${rel} --table ${r.table} --save-template my-source`);
    }
  } else {
    console.log('  Committed. Watch it in the live preview:  node vault/cli.js watch');
  }
  console.log('');
}

function cmdQuery(args) {
  const sql = (args._.slice(1).join(' ') || (typeof args.sql === 'string' ? args.sql : '')).trim();
  if (!sql) {
    console.error('  Usage: vault query "SELECT * FROM places LIMIT 5"');
    return 2;
  }
  if (!/^(select|with|pragma)\b/i.test(sql)) {
    console.error('  `query` is read-only (SELECT / WITH / PRAGMA). Use `import` or the portal to write.');
    return 2;
  }
  ensureDirs();
  if (!fs.existsSync(DB_FILE)) {
    console.error('  No database yet. Run:  node vault/cli.js init');
    return 1;
  }

  const database = db.open();
  const startedAt = Date.now();
  const rows = database.prepare(sql).all();
  const ms = Date.now() - startedAt;
  database.close();

  console.log('');
  if (!rows.length) {
    console.log(`  0 rows  (${ms} ms)`);
    console.log('');
    return 0;
  }

  const limit = args.limit ? Number(args.limit) : 50;
  const cols = Object.keys(rows[0]);
  const shown = rows.slice(0, limit);
  const cell = (v) => String(v == null ? '' : v);
  const widths = cols.map((c) => Math.max(c.length, ...shown.map((r) => cell(r[c]).length)));
  const line = (vals) => `  ${vals.map((v, i) => String(v).padEnd(widths[i])).join('  ')}`;

  console.log(line(cols));
  console.log(`  ${widths.map((w) => '-'.repeat(w)).join('  ')}`);
  for (const r of shown) console.log(line(cols.map((c) => cell(r[c]))));
  console.log('');
  console.log(`  ${rows.length} row(s)${rows.length > limit ? ` — showing first ${limit}` : ''}  (${ms} ms)`);
  console.log('');
  return 0;
}

function cmdLoadAdmin(args) {
  const file = args._[1];
  if (!file) { console.error('  Usage: vault load-admin <file.csv>'); return 2; }
  ensureDirs();
  if (!fs.existsSync(DB_FILE)) { console.error('  No database yet. Run:  node vault/cli.js init'); return 1; }

  const database = db.open();
  status.begin({ action: 'load-admin', phase: 'Phase 2 — Enrichment' });
  status.info(`Loading admin hierarchy from ${path.basename(file)}`);

  const result = reference.loadAdminTree(database, file, (i, total, name) => {
    status.setTask(`Loading ${name}`, i, total);
  });

  status.setDb(db.summary(database));
  status.done(`Loaded ${result.upserted} admin row(s)`);
  database.close();

  console.log('');
  console.log('  Spatial Vault — load-admin');
  console.log('');
  console.log('  File       ', result.file);
  console.log('  Rows read  ', result.rows.toLocaleString());
  console.log('  Upserted   ', result.upserted.toLocaleString());
  console.log('');
  return 0;
}

function cmdLoadPincode(args) {
  const file = args._[1];
  if (!file) { console.error('  Usage: vault load-pincode <file.csv>'); return 2; }
  ensureDirs();
  if (!fs.existsSync(DB_FILE)) { console.error('  No database yet. Run:  node vault/cli.js init'); return 1; }

  const database = db.open();
  status.begin({ action: 'load-pincode', phase: 'Phase 2 — Enrichment' });
  status.info(`Loading PIN codes from ${path.basename(file)}`);

  const result = reference.loadPincodes(database, file, (i, total, pin) => {
    status.setTask(`Loading PIN ${pin}`, i, total);
  });

  status.setDb(db.summary(database));
  status.done(`Loaded ${result.loaded} PIN code(s)`);
  database.close();

  console.log('');
  console.log('  Spatial Vault — load-pincode');
  console.log('');
  console.log('  File             ', result.file);
  console.log('  Rows read        ', result.rows.toLocaleString());
  console.log('  Loaded           ', result.loaded.toLocaleString());
  if (result.withoutAdmin) console.log('  Unlinked admin   ', result.withoutAdmin.toLocaleString());
  if (result.withoutCoords) console.log('  Without coords   ', result.withoutCoords.toLocaleString());
  console.log('');
  return 0;
}

function cmdEnrich(args) {
  ensureDirs();
  if (!fs.existsSync(DB_FILE)) {
    console.error('  No database yet. Run:  node vault/cli.js init');
    return 1;
  }
  const database = db.open();
  const dryRun = !!args['dry-run'];
  const recompute = !!args.recompute;

  status.begin({ action: 'enrich', phase: 'Phase 2 — Enrichment' });
  status.info('Resolving coordinates, geohash13, DIGIPIN and admin links');

  const r = enrich.enrichPlaces(database, {
    limit: args.limit ? Number(args.limit) : 0,
    dryRun,
    recompute,
    onProgress: (i, total, name) => status.setTask(`Enriching ${name}`, i, total),
  });

  status.setDb(db.summary(database));
  status.done(`Enriched ${r.scanned} place(s) — ${r.withDigipin} with DIGIPIN`);
  database.close();

  console.log('');
  console.log(`  Spatial Vault — enrich${r.dryRun ? '   (dry run — nothing committed)' : ''}`);
  console.log('');
  console.log('  Scanned             ', r.scanned.toLocaleString());
  console.log('  Already had coords  ', r.alreadyHad.toLocaleString());
  console.log('  From PIN code       ', r.fromPincode.toLocaleString());
  console.log('  From admin centroid ', r.fromAdmin.toLocaleString());
  console.log('  Still needs geocode ', r.needsGeocode.toLocaleString());
  console.log('  DIGIPIN assigned    ', r.withDigipin.toLocaleString());
  console.log('  Admin linked        ', r.adminResolved.toLocaleString());
  console.log('  Admin unlinked      ', r.adminUnresolved.toLocaleString());
  console.log('');
  return 0;
}

function cmdDedupe(args) {
  ensureDirs();
  if (!fs.existsSync(DB_FILE)) {
    console.error('  No database yet. Run:  node vault/cli.js init');
    return 1;
  }
  const database = db.open();
  const groups = enrich.findDuplicates(database, {});

  console.log('');
  console.log('  Spatial Vault — duplicate scan');
  console.log('');
  if (!groups.length) {
    console.log('  No duplicate groups found.');
    console.log('');
    database.close();
    return 0;
  }
  for (const g of groups) {
    console.log(`  ${g.name}   (${g.count} rows, bucket "${g.bucket || '—'}")`);
    console.log(`      ${g.uids.join(', ')}`);
  }
  console.log('');
  console.log(`  ${groups.length} group(s), ${groups.reduce((a, g) => a + g.count - 1, 0)} row(s) would be merged.`);

  if (args.merge) {
    const dryRun = !args.yes;
    const r = enrich.mergeDuplicates(database, { dryRun, onProgress: (i, t) => status.setTask('Merging', i, t) });
    console.log('');
    console.log(dryRun
      ? `  DRY RUN — would merge ${r.merged} row(s). Add --yes to commit.`
      : `  Merged ${r.merged} row(s) into their survivors.`);
  } else {
    console.log('  To merge:  node vault/cli.js dedupe --merge --yes');
  }
  console.log('');
  database.close();
  return 0;
}

function cmdInspect(args) {
  const file = args._[1];
  if (!file) {
    console.error('  Usage: vault inspect <file> [--sheet <name|n>] [--rows N]');
    return 2;
  }
  const data = sources.readSource(file, { sheet: typeof args.sheet === 'string' ? args.sheet : undefined });
  const limit = args.rows ? Number(args.rows) : 5;
  const pad = Math.max(...data.headers.map((h) => h.length), 12);

  console.log('');
  console.log('  Spatial Vault — inspect');
  console.log('');
  console.log('  File    ', data.file);
  console.log('  Format  ', data.format + (data.delimiter ? `   (delimiter ${JSON.stringify(data.delimiter)})` : ''));
  if (data.sheets) console.log('  Sheets  ', data.sheets.join(', ') + (data.sheet ? `   (reading "${data.sheet}")` : ''));
  console.log('  Rows    ', data.rows.length.toLocaleString());
  console.log('  Columns ', data.headers.length);
  console.log('');
  console.log('  COLUMNS');
  for (const c of data.columns) {
    const sample = String(c.sample).replace(/\s+/g, ' ').slice(0, 44);
    console.log(`    ${c.name.padEnd(pad)}  ${String(c.type).padEnd(8)} fill ${String(`${c.fillRate}%`).padEnd(5)} eg ${sample}`);
  }
  console.log('');
  console.log(`  FIRST ${Math.min(limit, data.rows.length)} ROW(S)`);
  for (const row of data.rows.slice(0, limit)) {
    console.log(`    ${data.headers.map((h) => `${h}=${JSON.stringify(row[h])}`).join('  ')}`);
  }
  console.log('');
  return 0;
}

function cmdLoadNiches(args) {
  const file = args._[1];
  if (!file) { console.error('  Usage: vault load-niches <file.csv>'); return 2; }
  ensureDirs();
  if (!fs.existsSync(DB_FILE)) { console.error('  No database yet. Run:  node vault/cli.js init'); return 1; }

  const database = db.open();
  status.begin({ action: 'load-niches', phase: 'Phase 3 — Distribution' });
  const result = reference.loadNiches(database, file, (i, t, slug) => status.setTask(`Loading ${slug}`, i, t));
  status.setDb(db.summary(database));
  status.done(`Loaded ${result.loaded} niche(s)`);
  database.close();

  console.log('');
  console.log('  Spatial Vault — load-niches');
  console.log('  File     ', result.file);
  console.log('  Loaded   ', result.loaded.toLocaleString());
  console.log('');
  return 0;
}

function cmdLoadSites(args) {
  const file = args._[1];
  if (!file) { console.error('  Usage: vault load-sites <file.csv>'); return 2; }
  ensureDirs();
  if (!fs.existsSync(DB_FILE)) { console.error('  No database yet. Run:  node vault/cli.js init'); return 1; }

  const database = db.open();
  status.begin({ action: 'load-sites', phase: 'Phase 3 — Distribution' });
  const result = reference.loadSites(database, file, (i, t, slug) => status.setTask(`Loading ${slug}`, i, t));
  status.setDb(db.summary(database));
  status.done(`Loaded ${result.loaded} site profile(s)`);
  database.close();

  console.log('');
  console.log('  Spatial Vault — load-sites');
  console.log('  File     ', result.file);
  console.log('  Loaded   ', result.loaded.toLocaleString());
  console.log('');
  return 0;
}

function cmdClassify(args) {
  ensureDirs();
  if (!fs.existsSync(DB_FILE)) { console.error('  No database yet. Run:  node vault/cli.js init'); return 1; }

  const database = db.open();
  const dryRun = !!args['dry-run'];
  status.begin({ action: 'classify', phase: 'Phase 3 — Distribution' });
  status.info('Classifying places into categories and niches');

  const r = classify.classifyPlaces(database, {
    dryRun,
    onProgress: (i, t, name) => status.setTask(`Classifying ${name}`, i, t),
  });

  status.setDb(db.summary(database));
  status.done(`Classified ${r.places} place(s) — ${r.memberships} memberships`);
  database.close();

  console.log('');
  console.log(`  Spatial Vault — classify${r.dryRun ? '   (dry run — nothing committed)' : ''}`);
  console.log('');
  console.log('  Places scanned     ', r.places.toLocaleString());
  console.log('  Categories created ', r.categoriesCreated.toLocaleString());
  console.log('  Category links     ', r.linked.toLocaleString());
  console.log('  Niche memberships  ', r.memberships.toLocaleString());
  console.log('  Listing codes      ', r.codesMinted.toLocaleString());
  console.log('');
  return 0;
}

function cmdExport(args) {
  ensureDirs();
  if (!fs.existsSync(DB_FILE)) { console.error('  No database yet. Run:  node vault/cli.js init'); return 1; }

  const database = db.open();
  let options = {};
  if (args.recipe) options = exporter.loadRecipe(database, args.recipe).options;
  if (args.site) options.siteSlug = args.site;
  if (args.niche) options.nicheSlugs = String(args.niche).split(',').map((s) => s.trim()).filter(Boolean);
  if (args.out) options.outDir = args.out;

  status.begin({ action: 'export', phase: 'Phase 3 — Distribution' });
  status.info(`Exporting to ${options.outDir ? path.resolve(options.outDir) : EXPORTS}`);

  const manifest = exporter.runExport(database, options, (label) => status.setTask(label));

  if (typeof args['save-recipe'] === 'string') {
    exporter.saveRecipe(database, args['save-recipe'], options);
    status.info(`Saved export recipe "${args['save-recipe']}"`);
  }

  status.setDb(db.summary(database));
  status.done(`Exported ${manifest.totals.files} file(s)`);
  database.close();

  const fmtBytes = (n) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`);
  console.log('');
  console.log('  Spatial Vault — export');
  console.log('');
  console.log('  Output     ', manifest.outDir);
  console.log('  Files      ', manifest.totals.files.toLocaleString());
  console.log('  Bytes      ', fmtBytes(manifest.totals.bytes));
  if (manifest.artefacts.tables) console.log('  Tables     ', manifest.artefacts.tables.count, `(${manifest.artefacts.tables.rows.toLocaleString()} rows)`);
  if (manifest.artefacts.niches) console.log('  Niches     ', manifest.artefacts.niches.count, `(${manifest.artefacts.niches.records.toLocaleString()} records)`);
  console.log('');
  console.log('  To lock this shape as a recipe:');
  console.log('    node vault/cli.js export --save-recipe production');
  console.log('  To re-run it later:');
  console.log('    node vault/cli.js export --recipe production');
  console.log('');
  return 0;
}

function cmdRecipes() {
  ensureDirs();
  if (!fs.existsSync(DB_FILE)) { console.error('  No database yet. Run:  node vault/cli.js init'); return 1; }
  const database = db.open();
  const list = exporter.listRecipes(database);
  database.close();

  console.log('');
  console.log('  Spatial Vault — saved export recipes');
  console.log('');
  if (!list.length) {
    console.log('  none yet. Create one with:  node vault/cli.js export --save-recipe production');
  } else {
    for (const r of list) {
      console.log(`  ${r.name.padEnd(20)}(updated ${String(r.updated_at).slice(0, 19).replace('T', ' ')})`);
    }
  }
  console.log('');
  return 0;
}

function cmdNotYet(name, phase) {
  ensureDirs();
  status.begin({ action: name, phase });
  status.warn(`${name} is not implemented yet (${phase})`);
  status.done(`Waiting for ${phase}`);
  console.log('');
  console.log(`  \`${name}\` arrives in ${phase}.`);
  console.log('  The schema, migrations and live preview are ready now:');
  console.log('    node vault/cli.js init');
  console.log('    node vault/cli.js watch');
  console.log('');
  return 0;
}

function cmdHelp() {
  console.log('');
  console.log('  Spatial Vault — local-first data engine');
  console.log('');
  console.log('  Usage:  node vault/cli.js <command> [options]');
  console.log('');
  console.log('    init              create the database and apply migrations');
  console.log('    watch             live preview at http://localhost:4317 (--port N)');
  console.log('    status            print a terminal summary');
  console.log('    doctor            check the environment');
  console.log('    tables            list tables and their columns (--json)');
  console.log('    import <file>     import CSV / TSV / JSON / JSONL / GeoJSON / XLSX');
  console.log('    inspect <file>    preview a file\'s columns before importing');
  console.log('    mappings          list saved column-mapping templates');
  console.log('    query "<sql>"     run a read-only SELECT / PRAGMA (--limit N)');
  console.log('    load-admin <file> import an admin tree (code/parent_code/kind/name)');
  console.log('    load-pincode <f>  import PIN codes (pincode/district_code/lat/lng)');
  console.log('    enrich            resolve coords -> geohash13 + DIGIPIN + admin links');
  console.log('    dedupe            find duplicate places (--merge --yes to merge)');
  console.log('    load-niches <f>   import niche definitions (slug/code_prefix/match_terms)');
  console.log('    load-sites <f>    import site profiles (projections + slug templates)');
  console.log('    classify          assign categories + niche memberships + listing codes');
  console.log('    export            export all formats (--recipe name, --save-recipe name)');
  console.log('    recipes           list saved export recipes');
  console.log('');
  console.log('  import options:');
  console.log('    --table <name>       target table (default: places)');
  console.log('    --template <name>    reuse a saved mapping (commits)');
  console.log('    --map <file.json>    ad-hoc mapping file (commits)');
  console.log('    --save-template <n>  store the mapping for reuse');
  console.log('    --limit <n>          import only the first n rows');
  console.log('    --dry-run            validate, then roll back');
  console.log('    --yes                commit an auto-suggested mapping');
  console.log('');
  console.log('  Folders:  state/ (local DB)   data/ (drop raw files)   exports/ (committed)');
  console.log('');
  return 0;
}

/* -------------------------------------------------------------------- main */

function main(argv) {
  const args = parseArgs(argv);
  const command = (args._[0] || 'help').toLowerCase();

  switch (command) {
    case 'init': return cmdInit();
    case 'status': return cmdStatus();
    case 'watch': return cmdWatch(args);
    case 'doctor': return cmdDoctor();
    case 'import': return cmdImport(args);
    case 'tables': return cmdTables(args);
    case 'mappings': return cmdMappings(args);
    case 'query': return cmdQuery(args);
    case 'inspect': return cmdInspect(args);
    case 'load-admin': return cmdLoadAdmin(args);
    case 'load-pincode': return cmdLoadPincode(args);
    case 'enrich': return cmdEnrich(args);
    case 'dedupe': return cmdDedupe(args);
    case 'load-niches': return cmdLoadNiches(args);
    case 'load-sites': return cmdLoadSites(args);
    case 'classify': return cmdClassify(args);
    case 'export': return cmdExport(args);
    case 'recipes': return cmdRecipes(args);
    case 'help':
    case '--help':
    case '-h': return cmdHelp();
    default:
      console.error(`Unknown command: ${command}`);
      cmdHelp();
      return 2;
  }
}

if (require.main === module) {
  try {
    const code = main(process.argv.slice(2));
    if (code !== null && code !== undefined) process.exitCode = code;
  } catch (err) {
    status.fail(err.message);
    console.error('');
    console.error('  Failed:', err.message);
    console.error('  See the live preview for the full log:  node vault/cli.js watch');
    console.error('');
    process.exitCode = 1;
  }
}

module.exports = { main, fmtBytes, fmtMs };
