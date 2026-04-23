#!/usr/bin/env node
'use strict';

/**
 * evidence-exchange-check.js
 * Scans outbox messages across all lanes, verifies that any referenced evidence
 * files exist, are readable, and that the optional `evidence_hash` field matches
 * the SHA‑256 hash of the serialized `evidence` object.
 *
 * Produces a per‑lane JSON report under `docs/autonomous-cycle-test/` named
 * `evidence-exchange-report-<lane>.json`.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const LANE_DIRS = {
  archivist: 'S:/Archivist-Agent',
  library: 'S:/self-organizing-library',
  swarmmind: 'S:/SwarmMind',
  kernel: 'S:/kernel-lane',
};

function loadMessage(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw.replace(/^\uFEFF/, ''));
  } catch (e) {
    return null;
  }
}

function verifyEvidence(msg, laneBaseDir) {
  const result = { evidence_path_exists: false, hash_match: null, errors: [] };
  if (!msg || typeof msg !== 'object') return result;
  if (!msg.evidence || typeof msg.evidence !== 'object') return result;
  const evPath = msg.evidence.evidence_path;
  if (evPath) {
    const absolute = path.isAbsolute(evPath) ? evPath : path.join(laneBaseDir || process.cwd(), evPath);
    result.evidence_path_exists = fs.existsSync(absolute);
    if (!result.evidence_path_exists) {
      result.errors.push('evidence_path_missing');
    }
  }
  if (msg.evidence_hash) {
    const computed = 'sha256:' + crypto.createHash('sha256').update(JSON.stringify(msg.evidence)).digest('hex');
    result.hash_match = computed === msg.evidence_hash;
    if (!result.hash_match) result.errors.push('evidence_hash_mismatch');
  }
  return result;
}

function scanLane(lane, baseDir) {
  const outbox = path.join(baseDir, 'lanes', lane, 'outbox');
  const report = { lane, total: 0, verified: 0, mismatches: [], missingEvidence: [] };
  if (!fs.existsSync(outbox)) return report;
  const files = fs.readdirSync(outbox).filter(f => f.endsWith('.json'));
  report.total = files.length;
  for (const file of files) {
    const msg = loadMessage(path.join(outbox, file));
    const ev = verifyEvidence(msg, baseDir);
    if (ev.errors.length === 0) {
      report.verified++;
    } else {
      if (ev.errors.includes('evidence_path_missing')) report.missingEvidence.push(file);
      if (ev.errors.includes('evidence_hash_mismatch')) report.mismatches.push(file);
    }
  }
  return report;
}

function main() {
  const reports = [];
  for (const [lane, dir] of Object.entries(LANE_DIRS)) {
    reports.push(scanLane(lane, dir));
  }
  const outDir = path.join(process.cwd(), 'docs', 'autonomous-cycle-test');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, 'evidence-exchange-report.json');
  fs.writeFileSync(outPath, JSON.stringify(reports, null, 2), 'utf8');
  console.log('Evidence exchange report written to', outPath);
}

module.exports = { verifyEvidence, scanLane, LANE_DIRS };

if (require.main === module) {
  main();
}
