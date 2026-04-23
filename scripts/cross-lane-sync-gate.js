#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const LANE_ROOTS = {
  archivist: 'S:/Archivist-Agent',
  kernel: 'S:/kernel-lane',
  library: 'S:/self-organizing-library',
  swarmmind: 'S:/SwarmMind'
};

const TRUST_STORE_PATHS = [
  'S:/Archivist-Agent/lanes/broadcast/trust-store.json',
  'S:/kernel-lane/lanes/broadcast/trust-store.json',
  'S:/self-organizing-library/lanes/broadcast/trust-store.json',
  'S:/SwarmMind/lanes/broadcast/trust-store.json'
];

function findTrustStore() {
  for (const p of TRUST_STORE_PATHS) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function loadTrustStore() {
  const p = findTrustStore();
  if (!p || !fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (_) {
    return null;
  }
}

function computeContentHash(obj) {
  const json = JSON.stringify(obj, Object.keys(obj).sort());
  return crypto.createHash('sha256').update(json).digest('hex');
}

function validateMessage(msg, options = {}) {
  const result = { valid: true, errors: [], warnings: [] };

  if (!msg || typeof msg !== 'object') {
    result.valid = false;
    result.errors.push('INVALID_MESSAGE: not an object');
    return result;
  }

  const isAuthority = msg.from === 'authority' || msg.type === 'authority-approval';

  if (options.enforceContentHash !== false) {
    if (!msg.content_hash) {
      result.warnings.push('MISSING_CONTENT_HASH');
    } else {
      const computed = computeContentHash(msg);
      if (computed !== msg.content_hash) {
        result.valid = false;
        result.errors.push('CONTENT_HASH_MISMATCH');
      }
    }
  }

  if (isAuthority && options.requireSignature !== false) {
    if (!msg.signature && !msg.jws) {
      result.valid = false;
      result.errors.push('AUTHORITY_MESSAGE_MISSING_SIGNATURE');
    }
  }

  if (msg.evidence && typeof msg.evidence === 'object') {
    if (options.requireArtifactPath !== false && !msg.evidence.artifact_path && !msg.evidence.evidence_path) {
      result.warnings.push('EVIDENCE_MISSING_ARTIFACT_PATH');
    }
  }

  const convergence = msg.convergence || msg.payload?.convergence;
  if (convergence && options.requireArtifactPath !== false) {
    if (!convergence.artifact_path && !msg.evidence?.artifact_path) {
      result.warnings.push('CONVERGENCE_MISSING_ARTIFACT_PATH');
    }
  }

  return result;
}

function checkLaneSync(laneId) {
  const root = LANE_ROOTS[laneId];
  if (!root) return { lane: laneId, ok: false, error: 'UNKNOWN_LANE' };

  const inboxPath = path.join(root, 'lanes', laneId, 'inbox');
  const outboxPath = path.join(root, 'lanes', laneId, 'outbox');
  const processedPath = path.join(inboxPath, 'processed');

  const result = {
    lane: laneId,
    ok: true,
    inbox_count: 0,
    processed_count: 0,
    outbox_count: 0,
    issues: []
  };

  try {
    if (fs.existsSync(inboxPath)) {
      result.inbox_count = fs.readdirSync(inboxPath).filter(f => f.endsWith('.json')).length;
    }
    if (fs.existsSync(processedPath)) {
      result.processed_count = fs.readdirSync(processedPath).filter(f => f.endsWith('.json')).length;
    }
    if (fs.existsSync(outboxPath)) {
      result.outbox_count = fs.readdirSync(outboxPath).filter(f => f.endsWith('.json')).length;
    }
  } catch (e) {
    result.ok = false;
    result.issues.push(`READ_ERROR: ${e.message}`);
  }

  return result;
}

function runSyncGate(options = {}) {
  const trustStore = loadTrustStore();
  const results = {
    trust_store_loaded: !!trustStore,
    lanes: {},
    overall_ok: true
  };

  for (const laneId of Object.keys(LANE_ROOTS)) {
    const sync = checkLaneSync(laneId);
    results.lanes[laneId] = sync;
    if (!sync.ok) results.overall_ok = false;
  }

  return results;
}

function main() {
  const args = process.argv.slice(2);
  const mode = args[0] || 'check';

  if (mode === 'check') {
    const results = runSyncGate();
    console.log(JSON.stringify(results, null, 2));
    process.exit(results.overall_ok ? 0 : 1);
  } else if (mode === 'validate') {
    const filePath = args[1];
    if (!filePath) {
      console.error('Usage: node cross-lane-sync-gate.js validate <file.json>');
      process.exit(1);
    }
    const msg = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const result = validateMessage(msg, { enforceContentHash: true, requireSignature: true, requireArtifactPath: true });
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.valid ? 0 : 1);
  } else {
    console.log('Usage:');
    console.log('  node cross-lane-sync-gate.js check');
    console.log('  node cross-lane-sync-gate.js validate <file.json>');
  }
}

module.exports = { validateMessage, runSyncGate, checkLaneSync, findTrustStore, loadTrustStore, computeContentHash };

if (require.main === module) {
  main();
}
