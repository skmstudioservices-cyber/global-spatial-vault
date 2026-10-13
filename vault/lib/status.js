'use strict';
/**
 * status.js — the progress bus.
 *
 * Every command writes its progress here (`state/status.json`). The live preview
 * server watches that file and pushes changes to the browser. Nothing in this
 * module talks to the network, so watching progress costs zero tokens.
 */
const fs = require('node:fs');
const { STATUS_FILE, ensureDirs } = require('./paths');

const LOG_CAP = 300;
let cache = null;

const nowIso = () => new Date().toISOString();

function blank() {
  return {
    version: 1,
    action: null,
    phase: 'Phase 0 — Foundation',
    state: 'idle', // idle | running | done | error
    task: null,
    startedAt: null,
    updatedAt: nowIso(),
    finishedAt: null,
    elapsedMs: 0,
    progress: { done: 0, total: 0, percent: 0 },
    steps: [],
    db: null,
    log: [],
    errors: [],
  };
}

function load() {
  if (cache) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8'));
    if (!cache.progress) cache.progress = { done: 0, total: 0, percent: 0 };
    if (!Array.isArray(cache.log)) cache.log = [];
  } catch {
    cache = blank();
  }
  return cache;
}

/** Atomically persist the current status. */
function save() {
  ensureDirs();
  const s = load();
  s.updatedAt = nowIso();
  if (s.startedAt && !s.finishedAt) s.elapsedMs = Date.now() - Date.parse(s.startedAt);
  s.progress.percent = s.progress.total > 0
    ? Math.min(100, Math.round((s.progress.done / s.progress.total) * 100))
    : (s.state === 'done' ? 100 : 0);
  if (s.log.length > LOG_CAP) s.log = s.log.slice(-LOG_CAP);
  const tmp = `${STATUS_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2), 'utf8');
  fs.renameSync(tmp, STATUS_FILE);
  return s;
}

/** Start a new run, clearing the previous one. */
function begin({ action, phase, total = 0 }) {
  cache = blank();
  const s = load();
  s.action = action;
  if (phase) s.phase = phase;
  s.state = 'running';
  s.startedAt = nowIso();
  s.progress = { done: 0, total, percent: 0 };
  return save();
}

/** Update the current task and, optionally, the progress counters. */
function setTask(task, done, total) {
  const s = load();
  s.task = task;
  if (typeof done === 'number') s.progress.done = done;
  if (typeof total === 'number') s.progress.total = total;
  return save();
}

function addStep(name, status, ms) {
  const s = load();
  s.steps.push({ name, status, ms: typeof ms === 'number' ? ms : null, at: nowIso() });
  return save();
}

function log(level, msg) {
  const s = load();
  s.log.push({ at: nowIso(), level, msg: String(msg) });
  return save();
}

const info = (msg) => log('info', msg);
const warn = (msg) => log('warn', msg);

function error(msg) {
  const s = load();
  const text = String(msg);
  s.errors.push({ at: nowIso(), msg: text });
  s.log.push({ at: nowIso(), level: 'error', msg: text });
  return save();
}

function setDb(dbInfo) {
  load().db = dbInfo;
  return save();
}

function done(summary) {
  const s = load();
  s.state = 'done';
  s.task = summary || 'Complete';
  s.finishedAt = nowIso();
  if (s.progress.total > 0) s.progress.done = s.progress.total;
  return save();
}

function fail(msg) {
  const s = load();
  s.state = 'error';
  s.finishedAt = nowIso();
  error(msg);
  return save();
}

module.exports = {
  load, save, begin, setTask, addStep,
  log, info, warn, error, setDb, done, fail, blank,
  STATUS_FILE,
};
