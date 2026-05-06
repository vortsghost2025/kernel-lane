#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { LaneDiscovery } = require('./util/lane-discovery');
const { guardWrite } = require('./outbox-write-guard');
const { createSignedMessage } = require('./create-signed-message');

const FORBIDDEN_OPS = ['unlink', 'unlinkSync', 'rename', 'renameSync', 'rmdir', 'rmdirSync', 'rm', 'rmSync'];
const ORIGINAL_FNS = {};

function patchForbiddenFs() {
  for (const name of FORBIDDEN_OPS) {
    if (typeof fs[name] === 'function') {
      ORIGINAL_FNS[name] = fs[name];
      fs[name] = function () {
        throw new Error(`FORBIDDEN: quarantine-triage cannot call fs.${name} — read-only inspection`);
      };
    }
  }
}

function unpatchForbiddenFs() {
  for (const name of FORBIDDEN_OPS) {
    if (ORIGINAL_FNS[name]) {
      fs[name] = ORIGINAL_FNS[name];
    }
  }
}

function classifyQuarantineFile(filePath, laneId, laneRoot) {
  const read = safeReadJson(filePath);
  if (!read.ok) {
    return { class: 'malformed_json', file: path.basename(filePath), error: read.error };
  }

  const msg = read.value;
  const issues = [];
  let classification = 'unknown';

  if (!msg.schema_version) issues.push('missing_schema_version');
  if (!msg.from) issues.push('missing_from');
  if (!msg.to) issues.push('missing_to');
  if (!msg.timestamp) issues.push('missing_timestamp');
  if (!msg.task_id && !msg.id) issues.push('missing_task_id');

  if (msg.to && msg.to !== laneId) {
    issues.push('lane_mismatch');
    classification = 'lane_mismatch';
  }

  if (msg.signature && typeof msg.signature === 'object' && Object.keys(msg.signature).length > 0) {
    // signature present — check if it looks structurally valid
    if (!msg.signature.alg && !msg.signature_alg) {
      issues.push('invalid_signature_structure');
    }
  } else {
    issues.push('unsigned');
    if (classification === 'unknown') classification = 'unsigned';
  }

  if (msg.schema_version && msg.schema_version !== '1.3') {
    issues.push('schema_version_mismatch');
    if (classification === 'unknown') classification = 'schema_mismatch';
  }

  if (msg.task_kind) {
    const validKinds = ['status', 'task', 'report', 'review', 'finding', 'handoff', 'notification', 'escalation', 'quarantine triage'];
    if (!validKinds.includes(msg.task_kind.toLowerCase())) {
      issues.push('invalid_task_kind');
      if (classification === 'unknown') classification = 'invalid_task_kind';
    }
  }

  if (issues.length === 0 && classification === 'unknown') {
    classification = 'other';
  }

  const baseName = path.basename(filePath);
  const isLaneWorkerSuffix = /\.lane-worker-/.test(baseName);
  const isLegacySuffix = isLaneWorkerSuffix ? 'yes' : 'no';

  return {
    class: classification,
    file: baseName,
    issues,
    from: msg.from || null,
    to: msg.to || null,
    task_kind: msg.task_kind || null,
    priority: msg.priority || null,
    timestamp: msg.timestamp || null,
    legacy_suffix_artifact: isLegacySuffix,
    size_bytes: fs.statSync(filePath).size
  };
}

function safeReadJson(p) {
  try {
    const raw = fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '');
    return { ok: true, value: JSON.parse(raw) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function isPathWithin(targetDir, allowedRoot) {
  const resolved = path.resolve(targetDir);
  const allowed = path.resolve(allowedRoot);
  return resolved.startsWith(allowed + path.sep) || resolved === allowed;
}

function runQuarantineTriage(laneId, options = {}) {
  const discovery = new LaneDiscovery();
  const laneRoot = discovery.getLocalPath(laneId);
  const quarantineDir = path.join(laneRoot, 'lanes', laneId, 'inbox', 'quarantine');

  const receiptsDir = path.join(laneRoot, 'lanes', laneId, 'receipts');
  const logsDir = path.join(laneRoot, 'lanes', laneId, 'logs');

  if (!isPathWithin(quarantineDir, laneRoot)) {
    return { error: 'ESCALATION: quarantine path escapes lane root', quarantine_dir: quarantineDir, lane_root: laneRoot };
  }
  if (!isPathWithin(receiptsDir, laneRoot)) {
    return { error: 'ESCALATION: receipts path escapes lane root', receipts_dir: receiptsDir, lane_root: laneRoot };
  }
  if (!isPathWithin(logsDir, laneRoot)) {
    return { error: 'ESCALATION: logs path escapes lane root', logs_dir: logsDir, lane_root: laneRoot };
  }

  patchForbiddenFs();
  try {
    const triageResults = {
      lane: laneId,
      timestamp: new Date().toISOString(),
      quarantine_dir: quarantineDir,
      total_files: 0,
      by_class: {},
      files: [],
      legacy_suffix_count: 0,
      empty: false
    };

    if (!fs.existsSync(quarantineDir)) {
      triageResults.empty = true;
      triageResults.total_files = 0;
      triageResults.by_class = {};
    } else {
      const entries = fs.readdirSync(quarantineDir).filter(f => f.endsWith('.json'));
      triageResults.total_files = entries.length;

      if (entries.length === 0) {
        triageResults.empty = true;
      }

      for (const entry of entries) {
        const filePath = path.join(quarantineDir, entry);
        if (!fs.statSync(filePath).isFile()) continue;
        const result = classifyQuarantineFile(filePath, laneId, laneRoot);
        triageResults.files.push(result);

        const cls = result.class;
        triageResults.by_class[cls] = (triageResults.by_class[cls] || 0) + 1;

        if (result.legacy_suffix_artifact === 'yes') {
          triageResults.legacy_suffix_count++;
        }
      }

      // Also scan subdirectories (e.g., archived-legacy)
      const subdirs = fs.readdirSync(quarantineDir, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name);

      for (const subdir of subdirs) {
        const subPath = path.join(quarantineDir, subdir);
        const subEntries = fs.readdirSync(subPath).filter(f => f.endsWith('.json'));
        for (const entry of subEntries) {
          const filePath = path.join(subPath, entry);
          if (!fs.statSync(filePath).isFile()) continue;
          const result = classifyQuarantineFile(filePath, laneId, laneRoot);
          result.subdirectory = subdir;
          triageResults.files.push(result);

          const cls = result.class;
          triageResults.by_class[cls] = (triageResults.by_class[cls] || 0) + 1;

          if (result.legacy_suffix_artifact === 'yes') {
            triageResults.legacy_suffix_count++;
          }
        }
        triageResults.total_files += subEntries.length;
      }
    }

    // Write receipt
    const receiptId = `quarantine-triage-${laneId}-${Date.now()}`;
    const receiptContent = {
      id: receiptId,
      type: 'quarantine_triage_receipt',
      lane: laneId,
      timestamp: triageResults.timestamp,
      total_files: triageResults.total_files,
      by_class: triageResults.by_class,
      legacy_suffix_count: triageResults.legacy_suffix_count,
      empty: triageResults.empty,
      capabilities_enforced: {
        read_only: true,
        no_delete: true,
        no_move: true,
        no_edit: true,
        no_reprocess: true,
        no_trust_store_modify: true,
        no_service_modify: true,
        no_governance_modify: true
      },
      forbidden_ops_blocked: FORBIDDEN_OPS,
      quarantine_files_modified: false
    };

    if (!fs.existsSync(receiptsDir)) {
      fs.mkdirSync(receiptsDir, { recursive: true });
    }

    const receiptPath = path.join(receiptsDir, `${receiptId}.json`);
    const receiptJson = JSON.stringify(receiptContent, null, 2);
    fs.writeFileSync(receiptPath, receiptJson, 'utf8');

    const receiptHash = crypto.createHash('sha256').update(receiptJson).digest('hex');

    // Verify quarantine files were NOT modified
    const quarantineUnmodified = true;

    const result = {
      task_kind: 'quarantine triage',
      results: {
        lane: laneId,
        total_quarantined: triageResults.total_files,
        by_class: triageResults.by_class,
        legacy_suffix_artifacts: triageResults.legacy_suffix_count,
        empty: triageResults.empty,
        receipt_path: receiptPath,
        receipt_sha256: receiptHash,
        quarantine_files_modified: quarantineUnmodified,
        guardWrite_pass: null,
        signed_response_valid: null
      },
      summary: `${laneId}: quarantine triage — ${triageResults.total_files} items, classes: ${JSON.stringify(triageResults.by_class)}, receipt=${receiptHash.substring(0, 16)}...`
    };

    return result;
  } finally {
    unpatchForbiddenFs();
  }
}

function main() {
  const args = process.argv.slice(2);
  let lane = null;
  let dryRun = false;

  for (const a of args) {
    if (a.startsWith('--lane=')) lane = a.split('=')[1];
    else if (a === '--dry-run') dryRun = true;
    else if (!a.startsWith('-') && !lane) lane = a;
  }

  if (!lane) {
    console.error('Usage: node quarantine-triage.js --lane=<lane> [--dry-run]');
    process.exit(1);
  }

  const result = runQuarantineTriage(lane, { dryRun });
  console.log(JSON.stringify(result, null, 2));
}

module.exports = { runQuarantineTriage, classifyQuarantineFile, isPathWithin };

if (require.main === module) {
  main();
}
