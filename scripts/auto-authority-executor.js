#!/usr/bin/env node
'use strict';
/**
 * auto-authority-executor.js
 *
 * Monitors lanes/broadcast/ for new authority approval artifacts.
 * When detected, automatically executes trust-store synchronization for the target lane.
 *
 * Usage: node auto-authority-executor.js --watch
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const BROADCAST_DIR = path.join(__dirname, '..', 'lanes', 'broadcast');
const APPROVAL_GLOB = 'authority-approval-*.json';
const CHECK_INTERVAL_MS = 60 * 1000; // 1 minute
const STATE_FILE = path.join(__dirname, '..', 'lanes', 'kernel', 'inbox', 'auto-authority-state.json');

function loadJSON(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (_) { return null; }
}

function writeJSON(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

function computeHash(obj) {
  return crypto.createHash('sha256').update(JSON.stringify(obj, null, 2)).digest('hex');
}

// Previous approvals tracking
let processedApprovals = new Set();
try {
  if (fs.existsSync(STATE_FILE)) {
    const state = loadJSON(STATE_FILE);
    if (state && state.processed_approvals) {
      processedApprovals = new Set(state.processed_approvals);
    }
  }
} catch (_) {}

function executeApproval(approvalPath, approvalData) {
  console.log(`[auto-authority]Processing approval: ${approvalPath}`);

  // Validate required fields
  const required = ['from', 'to', 'to_lane', 'canonical_key_id', 'action'];
  for (const f of required) {
    if (!approvalData[f]) {
      console.error(`[auto-authority] Missing field ${f} in ${approvalPath}`);
      return false;
    }
  }

  const targetLane = approvalData.to_lane;
  const canonicalKeyId = approvalData.canonical_key_id;
  const action = approvalData.action;

  // Only act on kernel-targeted approvals in this lane
  if (targetLane !== 'kernel') {
    console.log(`[auto-authority] Skipping: target lane is ${targetLane}, not kernel`);
    return false;
  }

  // Map lane name to trust store path
  const trustStorePath = path.join(__dirname, '..', 'lanes', 'broadcast', 'trust-store.json');
  if (!fs.existsSync(trustStorePath)) {
    console.error(`[auto-authority] Trust store not found: ${trustStorePath}`);
    return false;
  }

  const trustStore = loadJSON(trustStorePath);
  if (!trustStore || !trustStore.lanes) {
    console.error(`[auto-authority] Invalid trust store structure`);
    return false;
  }

  // Update or add lane entry
  if (!trustStore.lanes.kernel) {
    trustStore.lanes.kernel = {};
  }
  trustStore.lanes.kernel.key_id = canonicalKeyId;
  trustStore.lanes.kernel.algorithm = 'RS256';
  trustStore.lanes.kernel.revoked = false;

  // Write updated trust store
  writeJSON(trustStorePath, trustStore);
  console.log(`[auto-authority] Trust store updated: kernel key_id -> ${canonicalKeyId}`);

  // Update kernel's .identity/snapshot.json if present
  const snapshotPath = path.join(__dirname, '..', '.identity', 'snapshot.json');
  if (fs.existsSync(snapshotPath)) {
    const snapshot = loadJSON(snapshotPath);
    if (snapshot) {
      snapshot.key_id = canonicalKeyId;
      snapshot.updated_at = new Date().toISOString();
      writeJSON(snapshotPath, snapshot);
      console.log(`[auto-authority] Identity snapshot updated`);
    }
  }

  // Create completion artifact
  const artifact = {
    schema_version: "1.1",
    artifact_id: `auto-authority-execution-${Date.now()}`,
    executed_at: new Date().toISOString(),
    source_approval: approvalPath,
    target_lane: targetLane,
    action_taken: action,
    canonical_key_id: canonicalKeyId,
    trust_store_updated: true,
    identity_snapshot_updated: fs.existsSync(snapshotPath),
    approval_hash: computeHash(approvalData)
  };

  const artifactPath = path.join(__dirname, '..', 'lanes', 'kernel', 'outbox', `auto-authority-execution-${Date.now()}.json`);
  writeJSON(artifactPath, artifact);
  console.log(`[auto-authority] Completion artifact written: ${artifactPath}`);

  return true;
}

function scanForApprovals() {
  try {
    const files = fs.readdirSync(BROADCAST_DIR).filter(f => f.startsWith('authority-approval-') && f.endsWith('.json'));
    for (const file of files) {
      const fullPath = path.join(BROADCAST_DIR, file);
      const stat = fs.statSync(fullPath);
      const fileId = `${file}:${stat.mtimeMs}`;

      if (!processedApprovals.has(fileId)) {
        const data = loadJSON(fullPath);
        if (data && data.type === 'task' && data.priority === 'P0') {
          const success = executeApproval(fullPath, data);
          if (success) {
            processedApprovals.add(fileId);
            // Persist state
            writeJSON(STATE_FILE, {
              last_scan: new Date().toISOString(),
              processed_approvals: Array.from(processedApprovals)
            });
          }
        } else {
          processedApprovals.add(fileId); // skip non-P0 or invalid
        }
      }
    }
  } catch (err) {
    console.error('[auto-authority] Scan error:', err.message);
  }
}

// Single scan mode
if (process.argv.includes('--once')) {
  scanForApprovals();
  process.exit(0);
}

// Watch mode
console.log('[auto-authority] Starting watcher (Ctrl+C to stop)...');
setInterval(scanForApprovals, CHECK_INTERVAL_MS);
scanForApprovals(); // initial

// Graceful shutdown
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
