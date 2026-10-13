'use strict';
/**
 * paths.js — every location the engine reads or writes, in one place.
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..'); // repository root
const VAULT = path.join(ROOT, 'vault');
const WEB = path.join(VAULT, 'web');

const STATE = path.join(ROOT, 'state');   // local working state (git-ignored)
const DATA = path.join(ROOT, 'data');     // drop raw source files here
const EXPORTS = path.join(ROOT, 'exports'); // generated, committed to the data repo

const DB_FILE = process.env.VAULT_DB
  ? path.resolve(process.env.VAULT_DB)
  : path.join(STATE, 'vault.db');

const STATUS_FILE = path.join(STATE, 'status.json');

function ensureDirs() {
  for (const dir of [STATE, DATA, EXPORTS]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

module.exports = { ROOT, VAULT, WEB, STATE, DATA, EXPORTS, DB_FILE, STATUS_FILE, ensureDirs };
