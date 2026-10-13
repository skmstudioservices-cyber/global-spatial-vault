'use strict';
/**
 * db.js — SQLite access and the migration runner.
 *
 * Uses Node's built-in `node:sqlite` (no dependency, no install, no card needed).
 * `quiet.js` must load first so the experimental warning stays out of the output.
 */
require('./quiet');

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { DB_FILE, VAULT, ensureDirs } = require('./paths');

const MIGRATIONS_DIR = path.join(VAULT, 'migrations');

/** Open (creating if needed) the database with sane pragmas. */
function open(file = DB_FILE) {
  ensureDirs();
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  return db;
}

function ensureMigrationTable(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version    TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);
}

/** All migration files on disk, ordered by their numeric prefix. */
function listMigrations() {
  if (!fs.existsSync(MIGRATIONS_DIR)) return [];
  return fs.readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => ({ version: f.split('_')[0], name: f }));
}

function appliedVersions(db) {
  ensureMigrationTable(db);
  return new Set(db.prepare('SELECT version FROM schema_migrations').all().map((r) => r.version));
}

/**
 * Apply every migration that has not run yet, each in its own transaction.
 * `onProgress(index, total, name)` is called before each file.
 */
function migrate(db, onProgress) {
  ensureMigrationTable(db);
  const done = appliedVersions(db);
  const all = listMigrations();
  const pending = all.filter((m) => !done.has(m.version));

  pending.forEach((migration, index) => {
    if (onProgress) onProgress(index + 1, pending.length, migration.name);
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, migration.name), 'utf8');
    db.exec('BEGIN');
    try {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
        .run(migration.version, migration.name, new Date().toISOString());
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw new Error(`migration ${migration.name} failed: ${err.message}`);
    }
  });

  return {
    total: all.length,
    applied: all.length,          // after a successful run, every migration is applied
    ranNow: pending.length,
    ran: pending.map((m) => m.name),
  };
}

function tableNames(db) {
  return db
    .prepare(`SELECT name FROM sqlite_master
              WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
              ORDER BY name`)
    .all()
    .map((r) => r.name);
}

function rowCounts(db) {
  return tableNames(db).map((name) => {
    let rows = 0;
    try {
      rows = db.prepare(`SELECT COUNT(*) AS c FROM "${name}"`).get().c;
    } catch {
      rows = -1;
    }
    return { name, rows };
  });
}

function fileSize(file = DB_FILE) {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

/** Everything the preview needs to describe the database. */
function summary(db, file = DB_FILE) {
  let journal = '?';
  let foreignKeys = 0;
  let migrations = [];
  try { journal = db.prepare('PRAGMA journal_mode').get().journal_mode; } catch { /* ignore */ }
  try { foreignKeys = db.prepare('PRAGMA foreign_keys').get().foreign_keys; } catch { /* ignore */ }
  try {
    migrations = db.prepare('SELECT version, name, applied_at FROM schema_migrations ORDER BY version').all();
  } catch { /* table may not exist yet */ }

  return {
    path: file,
    exists: fs.existsSync(file),
    sizeBytes: fileSize(file),
    journal,
    foreignKeys,
    migrations,
    tables: tableNames(db).length ? rowCounts(db) : [],
  };
}

module.exports = {
  open, migrate, listMigrations, appliedVersions,
  tableNames, rowCounts, fileSize, summary, MIGRATIONS_DIR,
};
