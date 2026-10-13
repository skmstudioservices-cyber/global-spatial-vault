'use strict';
/**
 * quiet.js — suppress ONE specific warning, nothing else.
 *
 * Node's built-in SQLite (`node:sqlite`) is still flagged experimental and prints
 * an ExperimentalWarning the first time it is required. The engine intentionally
 * uses it because it is zero-dependency and needs no card to install. We drop only
 * that warning so CLI output stays clean, and let every other warning through.
 *
 * MUST be required BEFORE `node:sqlite`.
 */
const SUPPRESS = /SQLite is an experimental feature/i;

const originalEmit = process.emit;
process.emit = function patchedEmit(name, data, ...rest) {
  if (name === 'warning' && data && SUPPRESS.test(String(data.message || ''))) {
    return false;
  }
  return originalEmit.apply(process, [name, data, ...rest]);
};

module.exports = {};
