#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SESSION_ID = process.env.LANE_SESSION_ID || `sess_${Date.now().toString(36)}_${process.pid}`;

function nowIso() {
  return new Date().toISOString();
}

function sha256(data) {
  return crypto.createHash('sha256').update(data, 'utf8').digest('hex');
}

function signReceipt(receipt, privateKey, keyId) {
  try {
    const { IdentityEnforcer } = require('./identity-enforcer');
    const signed = IdentityEnforcer.signMessage(receipt, privateKey, keyId);
    return signed;
  } catch (e) {
    console.error(`[quarantine-triage] Signing failed: ${e.message}`);
    return null;
  }
}

function safeReadJson(filePath) {
  try {
    return { ok: true, value: JSON.parse(fs.readFileSync(filePath, 'utf8')) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function classifyQuarantineFile(filePath, content) {
  const filename = path.basename(filePath);
  const classification = {
    filename,
    path: filePath,
    class: 'unknown',
    reason: null,
    malformed_json: false,
    missing_fields: [],
    schema_violation: false,
    lane_mismatch: false,
    duplicate_suffix: false,
  };

  // Check for malformed JSON
  if (content === null) {
    classification.malformed_json = true;
    classification.class = 'malformed_json';
    classification.reason = 'File contains invalid JSON';
    return classification;
  }

  // Check for missing required fields
  const required = ['from', 'to', 'type', 'timestamp'];
  const missing = required.filter(f => !(f in content));
  if (missing.length > 0) {
    classification.missing_fields = missing;
    classification.schema_violation = true;
    if (classification.class === 'unknown') {
      classification.class = 'schema_violation';
      classification.reason = `Missing required fields: ${missing.join(', ')}`;
    }
  }

  // Check for .lane-worker suffix artifacts (duplicates/legacy)
  if (filename.includes('.lane-worker-')) {
    classification.duplicate_suffix = true;
    classification.class = 'duplicate_suffix';
    classification.reason = 'Legacy .lane-worker suffix artifact detected';
  }

  // Check lane mismatch
  if (content.from && content.to && content.from !== content.to) {
    // This is normal for cross-lane messages, but quarantine may have mismatches
    if (classification.class === 'unknown') {
      classification.class = 'cross_lane';
      classification.reason = 'Cross-lane message in quarantine';
    }
  }

  // Check for common failure reasons
  if (content.type === 'heartbeat' && classification.class === 'unknown') {
    classification.class = 'heartbeat_stale';
    classification.reason = 'Stale heartbeat detected';
  }

  return classification;
}

function runQuarantineTriage(options = {}) {
  const repoRoot = options.repoRoot || path.resolve(__dirname, '..');
  const lane = options.lane || 'kernel';
  const quarantineDir = path.join(repoRoot, 'lanes', lane, 'inbox', 'quarantine');

  if (!fs.existsSync(quarantineDir)) {
    return {
      success: true,
      lane,
      quarantine_dir: quarantineDir,
      scanned: 0,
      counts: {
        total: 0,
        malformed_json: 0,
        schema_violation: 0,
        duplicate_suffix: 0,
        cross_lane: 0,
        heartbeat_stale: 0,
        unknown: 0,
      },
      files: [],
      receipt_path: null,
      receipt_sha256: null,
      timestamp: nowIso(),
      session_id: SESSION_ID,
    };
  }

  const files = fs.readdirSync(quarantineDir, { withFileTypes: true })
    .filter(ent => ent.isFile() && ent.name.endsWith('.json'))
    .map(ent => path.join(quarantineDir, ent.name));

  const classifications = [];
  const counts = {
    total: 0,
    malformed_json: 0,
    schema_violation: 0,
    duplicate_suffix: 0,
    cross_lane: 0,
    heartbeat_stale: 0,
    unknown: 0,
  };

  for (const filePath of files) {
    const read = safeReadJson(filePath);
    const content = read.ok ? read.value : null;
    const classif = classifyQuarantineFile(filePath, content);
    classifications.push(classif);

    // Update counts
    counts.total++;
    if (classif.class && counts.hasOwnProperty(classif.class)) {
      counts[classif.class]++;
    } else {
      counts.unknown++;
    }
  }

  // Write receipt - guardWrite: only write to receipts/logs directory
  const receiptsDir = path.join(repoRoot, 'lanes', lane, 'receipts', 'logs');
  const resolvedReceiptsDir = path.resolve(receiptsDir);

  // guardWrite: verify receipts directory is within allowed root
  if (!resolvedReceiptsDir.includes(lane) || !resolvedReceiptsDir.includes('receipts')) {
    throw new Error(`guardWrite: receipt path outside allowed directory: ${resolvedReceiptsDir}`);
  }

  if (!fs.existsSync(receiptsDir)) {
    fs.mkdirSync(receiptsDir, { recursive: true });
  }

  const receipt = {
    schema_version: '1.0',
    task_kind: 'quarantine_triage',
    lane,
    timestamp: nowIso(),
    session_id: SESSION_ID,
    quarantine_dir: quarantineDir,
    scanned: counts.total,
    counts,
    classifications,
    provenance: {
      agent: 'opencode',
      generated_at: nowIso(),
    },
  };

  const receiptPath = path.join(receiptsDir, `quarantine-triage-${Date.now()}.json`);
  fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2), 'utf8');

  return {
    success: true,
    lane,
    quarantine_dir: quarantineDir,
    scanned: counts.total,
    counts,
    files: classifications,
    receipt_path: receiptPath,
    receipt_sha256: sha256(JSON.stringify(receipt, null, 2)),
    timestamp: nowIso(),
    session_id: SESSION_ID,
  };
}

if (require.main === module) {
  const repoRoot = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(__dirname, '..');
  const lane = process.argv[3] || 'kernel';
  const result = runQuarantineTriage({ repoRoot, lane });
  console.log(JSON.stringify(result, null, 2));
}

module.exports = { runQuarantineTriage };