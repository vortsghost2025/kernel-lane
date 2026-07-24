#!/usr/bin/env node
'use strict';

/**
 * mode-check.js (kernel lane)
 *
 * Mirrors the Archivist implementation. Uses the canonical cross-lane
 * active-mode.json owned by Archivist; falls back to the lane-local
 * watcher-mode.json.
 */

const fs = require('fs');
const path = require('path');

const ARCHIVIST_ROOT = process.env.ARCHIVIST_ROOT || 'S:\\Archivist-Agent';

function findLaneRoot() {
  return path.resolve(__dirname, '..');
}

function laneRoot() {
  if (!laneRoot._value) laneRoot._value = findLaneRoot();
  return laneRoot._value;
}

function readJsonSafe(p) {
  try {
    const raw = fs.readFileSync(p, 'utf8');
    const json = JSON.parse(raw);
    return json && typeof json === 'object' ? json : null;
  } catch (_) {
    return null;
  }
}

function readCanonical() {
  const p = path.join(ARCHIVIST_ROOT, 'lanes', 'broadcast', 'active-mode.json');
  return { source: p, data: readJsonSafe(p) };
}

function readLaneLocal() {
  const p = path.join(laneRoot(), 'lanes', 'state', 'watcher-mode.json');
  return { source: p, data: readJsonSafe(p) };
}

function getMode() {
  const a = readCanonical();
  if (a.data && typeof a.data.mode === 'string') return a.data.mode;

  const b = readLaneLocal();
  if (b.data && typeof b.data.mode === 'string') return b.data.mode;

  return 'OBSERVE';
}

function isBuildMode() {
  return getMode() === 'BUILD';
}

function getAllowedOperations() {
  const a = readCanonical();
  if (a.data && Array.isArray(a.data.allowed_operations)) return a.data.allowed_operations;
  return [];
}

function isWriteAllowed(op) {
  if (!op || typeof op !== 'string') return false;
  if (op.toLowerCase() === 'read') return true;
  const allowed = getAllowedOperations();
  if (allowed.length === 0) return false;
  return allowed.includes(op);
}

function summary() {
  return {
    mode: getMode(),
    source: readCanonical().data ? 'archivist/broadcast/active-mode.json' : 'lane/state/watcher-mode.json',
    writeAllowed: isWriteAllowed('write'),
  };
}

function _safeLog(entry) {
  try {
    const fsExtra = require('fs');
    const logPath = path.join(ARCHIVIST_ROOT, 'context-buffer', 'mode-check.log');
    fsExtra.appendFileSync(logPath, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
  } catch (_) {}
}

function enforceMutation(op, targetPath) {
  const mode = getMode();
  const allowed =
    mode === 'BUILD' ||
    mode === 'EXCLUSIVE' ||
    mode === 'SHARED' ||
    isWriteAllowed(op);

  if (!allowed) {
    _safeLog({ event: 'MUTATION_BLOCKED', op, mode, target: targetPath });
    const err = new Error(
      `MUTATION_BLOCKED: operation '${op}' not allowed in mode '${mode}' (target=${targetPath || 'n/a'})`
    );
    err.code = 'MODE_GUARD_REJECTED';
    throw err;
  }
  if (!isWriteAllowed(op) && mode !== 'BUILD') {
    _safeLog({ event: 'MUTATION_BLOCKED_ALLOWLIST', op, mode, target: targetPath });
    const err = new Error(
      `MUTATION_BLOCKED: operation '${op}' not in allowed_operations for mode '${mode}'`
    );
    err.code = 'MODE_GUARD_REJECTED';
    throw err;
  }
  _safeLog({ event: 'MUTATION_ALLOWED', op, mode, target: targetPath });
  return true;
}

module.exports = {
  getMode,
  isBuildMode,
  isWriteAllowed,
  summary,
  enforceMutation,
};
