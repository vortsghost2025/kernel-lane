#!/usr/bin/env node
'use strict';

/**
 * mode-check.js
 *
 * Resolves the current lane/execution mode for create-signed-message.js
 * and other scripts that need to know whether writing is allowed.
 *
 * Source priority:
 *   1. Canonical cross-lane mode:
 *        <archivist-root>/lanes/broadcast/active-mode.json
 *      (this is the authoritative source per AGENTS.md / ARCHITECTURE)
 *   2. Per-lane local mode:
 *        <lane-root>/lanes/<lane>/state/watcher-mode.json
 *      (used when the archivist broadcast file is unreachable)
 *   3. Fallback: 'OBSERVE' (refuse writes by default)
 *
 * Exports:
 *   getMode()           -> 'BUILD' | 'OBSERVE' | 'SHARED' | 'EXCLUSIVE' | string
 *   isBuildMode()       -> boolean
 *   isWriteAllowed(op)  -> boolean (op is the operation name, e.g. 'write')
 *   summary()           -> { mode, source, writeAllowed }
 *
 * No external deps. Uses only Node-core modules.
 */

const fs = require('fs');
const path = require('path');

// --- Path discovery ---------------------------------------------------------
// This file is loaded by create-signed-message.js from <lane-root>/scripts/.
// We intentionally do not rely on require.main because the same script may be
// loaded as a library (not the program entry point).

// ARCHIVIST_ROOT is the canonical owner of the shared mode file.
const ARCHIVIST_ROOT = process.env.ARCHIVIST_ROOT || 'S:\\Archivist-Agent';

function findLaneRoot() {
  // scripts/mode-check.js -> scripts/ -> <lane-root>
  return path.resolve(__dirname, '..');
}

function laneRoot() {
  // Cached after first call.
  if (!laneRoot._value) laneRoot._value = findLaneRoot();
  return laneRoot._value;
}

// --- File readers -----------------------------------------------------------
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
  // The lane's own state dir mirrors the active mode locally.
  const p = path.join(laneRoot(), 'lanes', 'state', 'watcher-mode.json');
  return { source: p, data: readJsonSafe(p) };
}

// --- Public API -------------------------------------------------------------
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

  // OBSERVE implies no write-class ops unless explicitly listed.
  return [];
}

function isWriteAllowed(op) {
  if (!op || typeof op !== 'string') return false;

  // `read` is always allowed.
  if (op.toLowerCase() === 'read') return true;

  // BUILD mode + op listed in allowed_operations -> allow.
  const allowed = getAllowedOperations();
  if (allowed.length === 0) {
    // No allowlist = strict OBSERVE.
    return false;
  }
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
  // Best-effort debug logging. Failures must never propagate.
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
  // Message-mode paths also require the op to be in allowed_operations.
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
