#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { moveFileWithLease } = require('./lease-write');

const LANE_DIRS = {
  archivist: 'S:/Archivist-Agent',
  library: 'S:/self-organizing-library',
  swarmmind: 'S:/SwarmMind',
  kernel: 'S:/kernel-lane',
};

function validateOutboxMessage(msg) {
  const errors = [];
  if (!msg.signature || typeof msg.signature !== 'string' || msg.signature.length < 10) {
    errors.push('MISSING_SIGNATURE');
  }
  if (!msg.key_id || typeof msg.key_id !== 'string' || msg.key_id.length < 16) {
    errors.push('MISSING_KEY_ID');
  }
  if (!msg.from && !msg.from_lane) {
    errors.push('MISSING_FROM');
  }
  if (!msg.id) {
    errors.push('MISSING_ID');
  }
  const lease = msg.lease;
  if (!lease || typeof lease !== 'object') {
    errors.push('MISSING_LEASE');
  } else {
    if (!lease.owner || typeof lease.owner !== 'string') {
      errors.push('MISSING_LEASE_OWNER');
    }
    if (!lease.acquired_at || Number.isNaN(Date.parse(lease.acquired_at))) {
      errors.push('MISSING_LEASE_ACQUIRED_AT');
    }
  }
  return { valid: errors.length === 0, errors };
}

function scanOutbox(laneId) {
  const baseDir = LANE_DIRS[laneId];
  if (!baseDir) throw new Error(`Unknown lane: ${laneId}`);

  const outboxPath = path.join(baseDir, 'lanes', laneId, 'outbox');
  if (!fs.existsSync(outboxPath)) {
    return { lane: laneId, total: 0, signed: 0, unsigned: 0, details: [] };
  }

  const files = fs.readdirSync(outboxPath).filter(f => f.endsWith('.json'));
  const results = [];
  let signed = 0;
  let unsigned = 0;

  for (const file of files) {
    const filePath = path.join(outboxPath, file);
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      const msg = JSON.parse(raw.replace(/^\uFEFF/, ''));
      const check = validateOutboxMessage(msg);
      if (check.valid) {
        signed++;
      } else {
        unsigned++;
        results.push({ file, errors: check.errors, id: msg.id || null });
      }
    } catch (err) {
      unsigned++;
      results.push({ file, errors: ['PARSE_ERROR: ' + err.message], id: null });
    }
  }

  return { lane: laneId, total: files.length, signed, unsigned, details: results };
}

function scanAllLanes() {
  const report = {};
  for (const laneId of Object.keys(LANE_DIRS)) {
    report[laneId] = scanOutbox(laneId);
  }
  return report;
}

function guardWrite(msg, outboxPath, filename) {
  const check = validateOutboxMessage(msg);
  if (!check.valid) {
    const logEntry = {
      timestamp: new Date().toISOString(),
      event: 'OUTBOX_WRITE_BLOCKED',
      filename,
      id: msg.id || null,
      from: msg.from || msg.from_lane || null,
      errors: check.errors,
    };
    const logPath = path.join(path.dirname(outboxPath), '..', '..', 'logs', 'outbox-guard.log');
    try {
      const logDir = path.dirname(logPath);
      if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
      fs.appendFileSync(logPath, JSON.stringify(logEntry) + '\n', 'utf8');
    } catch (_) {}
    const err = new Error(`OUTBOX_WRITE_BLOCKED: ${check.errors.join(', ')} — message ${msg.id || filename} rejected`);
    err.code = 'OUTBOX_GUARD_REJECTED';
    err.errors = check.errors;
    throw err;
  }
  return true;
}

async function remediateUnsigned(laneId) {
  const baseDir = LANE_DIRS[laneId];
  if (!baseDir) throw new Error(`Unknown lane: ${laneId}`);

  const outboxPath = path.join(baseDir, 'lanes', laneId, 'outbox');
  const unsignedPath = path.join(outboxPath, 'unsigned');

  if (!fs.existsSync(outboxPath)) return { moved: 0, files: [] };

  const files = fs.readdirSync(outboxPath).filter(f => f.endsWith('.json'));
  const moved = [];

  for (const file of files) {
    const filePath = path.join(outboxPath, file);
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      const msg = JSON.parse(raw.replace(/^\uFEFF/, ''));
      const check = validateOutboxMessage(msg);
      if (!check.valid) {
        if (!fs.existsSync(unsignedPath)) fs.mkdirSync(unsignedPath, { recursive: true });
        const dest = path.join(unsignedPath, file);
        await moveFileWithLease(filePath, dest, laneId, 30000);
        moved.push({ file, errors: check.errors, id: msg.id || null });
      }
    } catch (err) {
      if (!fs.existsSync(unsignedPath)) fs.mkdirSync(unsignedPath, { recursive: true });
      const dest = path.join(unsignedPath, file);
      try { await moveFileWithLease(filePath, dest, laneId, 30000); } catch (_) {}
      moved.push({ file, errors: ['PARSE_ERROR'], id: null });
    }
  }

  return { moved: moved.length, files: moved };
}

module.exports = { validateOutboxMessage, scanOutbox, scanAllLanes, guardWrite, remediateUnsigned };

if (require.main === module) {
  (async () => {
  const args = process.argv.slice(2);
  const command = args[0] || 'scan';

  if (command === 'scan') {
    const lane = args[1] || null;
    if (lane) {
      const report = scanOutbox(lane);
      console.log(JSON.stringify(report, null, 2));
    } else {
      const report = scanAllLanes();
      let totalUnsigned = 0;
      for (const [l, r] of Object.entries(report)) {
        console.log(`[${l}] total=${r.total} signed=${r.signed} unsigned=${r.unsigned}`);
        if (r.details.length > 0) {
          for (const d of r.details) {
            console.log(`  BLOCKED: ${d.file} — ${d.errors.join(', ')}`);
          }
        }
        totalUnsigned += r.unsigned;
      }
      console.log(`\nTOTAL UNSIGNED: ${totalUnsigned}`);
      if (totalUnsigned > 0) process.exit(1);
    }
  } else if (command === 'quarantine') {
    const lane = args[1];
    if (!lane) {
      console.error('Usage: node outbox-write-guard.js quarantine <lane>');
      process.exit(1);
    }
    const result = await remediateUnsigned(lane);
    console.log(`Quarantined ${result.moved} unsigned messages from ${lane} outbox`);
    if (result.files.length > 0) {
      for (const f of result.files) {
        console.log(`  ${f.file}: ${f.errors.join(', ')}`);
      }
    }
  } else if (command === 'guard') {
    const msgPath = args[1];
    if (!msgPath) {
      console.error('Usage: node outbox-write-guard.js guard <message.json>');
      process.exit(1);
    }
    const raw = fs.readFileSync(msgPath, 'utf8');
    const msg = JSON.parse(raw.replace(/^\uFEFF/, ''));
    try {
      guardWrite(msg, '/dev/null', path.basename(msgPath));
      console.log('PASS: message has valid signature + key_id');
    } catch (err) {
      console.error(`FAIL: ${err.message}`);
      process.exit(1);
    }
  } else {
    console.error('Commands: scan [lane], quarantine <lane>, guard <message.json>');
    process.exit(1);
  }
  })().catch((err) => {
    console.error(`FAIL: ${err.message}`);
    process.exit(1);
  });
}
