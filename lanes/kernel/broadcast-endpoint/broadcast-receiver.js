#!/usr/bin/env node
/**
 * Broadcast Receiver - Emergency P0 Alert Processor
 * Lane: kernel
 */

'use strict';

const fs = require('fs');
const path = require('path');

const LANE_ID = 'kernel';
const LANE_ROOT = 'S:/kernel-lane';
const INBOX_DIR = path.join(LANE_ROOT, 'lanes', LANE_ID, 'inbox');
const PROCESSED_DIR = path.join(LANE_ROOT, 'lanes', LANE_ID, 'inbox', 'processed');
const BROADCAST_LOG = path.join(LANE_ROOT, 'lanes', LANE_ID, 'broadcast-endpoint', 'broadcast-received.log');
const OUTBOX_DIR = path.join(LANE_ROOT, 'lanes', LANE_ID, 'outbox');

const SCHEMAS_DIR = path.join(__dirname, '..', '..', '..', 'schemas');
const BROADCAST_SCHEMA_PATH = path.join(SCHEMAS_DIR, 'broadcast-message-v1.json');

const VALID_ORIGINATORS = ['swarmmind'];

const UNICODE_NORMALIZE_MAP = {
  '\u2014': '--', '\u2013': '-', '\u2018': "'", '\u2019': "'",
  '\u201C': '"', '\u201D': '"', '\u2026': '...', '\u00A0': ' ',
  '\u2022': '*', '\u2010': '-', '\u2011': '-', '\u2012': '-',
  '\u2015': '--', '\u2212': '-'
};

function normalizeToAscii(str) {
  const UNICODE_NORMALIZE_RE = new RegExp('[' + Object.keys(UNICODE_NORMALIZE_MAP).join('') + ']', 'g');
  return str.replace(UNICODE_NORMALIZE_RE, ch => UNICODE_NORMALIZE_MAP[ch] || '?');
}

function nowIso() { return new Date().toISOString(); }
function ensureDir(p) { if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }); }
function log(msg) {
  const ts = nowIso();
  const line = `[${ts}] ${msg}\n`;
  fs.appendFileSync(BROADCAST_LOG, line, 'utf8');
  console.log(`[broadcast-receiver-${LANE_ID}] ${msg}`);
}

function isBroadcastMessage(msg) {
  if (!msg || typeof msg !== 'object') return false;
  if (msg.type !== 'alert') return false;
  if (msg.priority !== 'P0') return false;
  if (!msg.broadcast_metadata) return false;
  if (!VALID_ORIGINATORS.includes(msg.from)) return false;
  return true;
}

function validateBroadcastSchema(msg) {
  if (!fs.existsSync(BROADCAST_SCHEMA_PATH)) {
    return { ok: false, error: `Broadcast schema not found: ${BROADCAST_SCHEMA_PATH}` };
  }

  if (msg.type !== 'alert') return { ok: false, error: `Invalid type: ${msg.type}` };
  if (msg.priority !== 'P0') return { ok: false, error: `Invalid priority: ${msg.priority}` };
  if (!msg.broadcast_metadata) return { ok: false, error: `Missing broadcast_metadata` };

  const bm = msg.broadcast_metadata;
  if (!bm.broadcast_id || typeof bm.broadcast_id !== 'string') {
    return { ok: false, error: `Missing or invalid broadcast_id` };
  }
  if (!bm.originator || typeof bm.originator !== 'string') {
    return { ok: false, error: `Missing or invalid originator` };
  }
  if (!bm.transmitted_at || typeof bm.transmitted_at !== 'string') {
    return { ok: false, error: `Missing or invalid transmitted_at` };
  }

  return { ok: true };
}

function buildAckMessage(originalMsg, processingTimeMs, actionsTaken = []) {
  const ts = nowIso();
  const broadcastId = originalMsg.broadcast_metadata.broadcast_id;
  const idempotencyKey = `${broadcastId}-${LANE_ID}-ack`;

  return {
    schema_version: '1.3',
    task_id: `broadcast-ack-${broadcastId}-${Date.now()}`,
    idempotency_key: idempotencyKey,
    from: LANE_ID,
    to: 'swarmmind',
    type: 'ack',
    task_kind: 'broadcast_ack',
    priority: 'P0',
    subject: `[BROADCAST_ACK] ${originalMsg.subject || 'Emergency Alert Received'}`,
    body: `Emergency broadcast acknowledged by ${LANE_ID}.\n\n` +
          `Broadcast ID: ${broadcastId}\n` +
          `Processing Time: ${processingTimeMs}ms\n` +
          `Timestamp: ${ts}\n\n` +
          `Actions: ${actionsTaken.join('; ') || 'monitored'}`,
    timestamp: ts,
    requires_action: false,
    payload: { mode: 'inline', compression: 'none' },
    execution: { mode: 'manual', engine: 'kilo', actor: 'lane' },
    lease: {
      owner: 'swarmmind',
      acquired_at: ts,
      expires_at: new Date(Date.now() + 60000).toISOString(),
      renewal_count: 0,
      max_renewals: 3
    },
    retry: { attempt: 1, max_attempts: 3 },
    evidence: { required: false, verified: false },
    evidence_exchange: {
      artifact_path: `lanes/${LANE_ID}/broadcast-endpoint/broadcast-received.log`,
      artifact_type: 'log',
      delivered_at: ts
    },
    heartbeat: { status: 'done', last_heartbeat_at: ts, interval_seconds: 300, timeout_seconds: 900 },
    broadcast_ack: {
      original_broadcast_id: broadcastId,
      original_task_id: originalMsg.task_id,
      acknowledged_by: LANE_ID,
      acknowledged_at: ts,
      processing_time_ms: processingTimeMs,
      status: 'received',
      actions_taken: actionsTaken,
      convergence_gate: {
        claim: `Broadcast ${broadcastId} received by ${LANE_ID}`,
        evidence: `lanes/${LANE_ID}/broadcast-endpoint/broadcast-received.log`,
        verified_by: LANE_ID,
        contradictions: [],
        status: 'proven'
      }
    }
  };
}

function signMessage(msg, laneId) {
  const createSignedMessagePath = path.join(__dirname, '..', 'create-signed-message.js');
  const { createSignedMessage: sign } = require(createSignedMessagePath);
  return sign(msg, laneId);
}

function processBroadcastFile(filePath, fileName) {
  const startTime = Date.now();

  try {
    const raw = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
    const msg = JSON.parse(raw);
    msg.subject = normalizeToAscii(msg.subject || '');

    log(`Processing: ${fileName} (broadcast_id=${msg.broadcast_metadata?.broadcast_id || 'unknown'})`);

    const validation = validateBroadcastSchema(msg);
    if (!validation.ok) {
      log(`ERROR: ${validation.error}`);
      moveToQuarantine(filePath, fileName, validation.error);
      return false;
    }

    const broadcastId = msg.broadcast_metadata.broadcast_id;
    log(`Valid P0 alert from ${msg.from}, broadcast_id=${broadcastId}`);

    const actions = determineEmergencyActions(msg);
    const processingTime = Date.now() - startTime;
    const ackMsg = buildAckMessage(msg, processingTime, actions);

    try {
      const signedAck = signMessage(ackMsg, LANE_ID);
      ensureDir(OUTBOX_DIR);
      const ackFileName = `${signedAck.task_id}.json`;
      const ackPath = path.join(OUTBOX_DIR, ackFileName);
      fs.writeFileSync(ackPath, JSON.stringify(signedAck, null, 2), 'utf8');
      log(`ACK sent: ${ackFileName}`);

      recordBroadcastReceipt(msg, signedAck, processingTime, actions);
      moveToProcessed(filePath, fileName, broadcastId);
      log(`Done (${processingTime}ms)`);
      return true;

    } catch (signErr) {
      log(`ERROR signing ACK: ${signErr.message}`);
      moveToProcessed(filePath, fileName, broadcastId);
      return false;
    }

  } catch (err) {
    log(`ERROR: ${err.message}`);
    moveToQuarantine(filePath, fileName, err.message);
    return false;
  }
}

function determineEmergencyActions(msg) {
  const actions = [];
  const subject = (msg.subject || '').toLowerCase();
  const body = (msg.body || '').toLowerCase();

  if (subject.includes('emergency') || subject.includes('🚨') || body.includes('immediate action')) {
    actions.push('[EMERGENCY] Immediate attention required');
  }
  if (subject.includes('convergence') || body.includes('convergence gate')) {
    actions.push('[CONVERGENCE] Gate verification needed');
  }
  if (subject.includes('sovereignty') || subject.includes('constraint')) {
    actions.push('[SOVEREIGNTY] Constraint check required');
  }
  if (actions.length === 0) {
    actions.push('[MONITOR] Broadcast logged');
  }
  return actions;
}

function moveToProcessed(originalPath, fileName, broadcastId) {
  ensureDir(PROCESSED_DIR);
  const destName = `broadcast-${broadcastId}-${fileName}`;
  const destPath = path.join(PROCESSED_DIR, destName);
  fs.renameSync(originalPath, destPath);
  log(`Archived: ${destName}`);
}

function moveToQuarantine(originalPath, fileName, reason) {
  const quarantineDir = path.join(LANE_ROOT, 'lanes', LANE_ID, 'inbox', 'quarantine');
  ensureDir(quarantineDir);
  const destName = `broadcast-quarantine-${Date.now()}-${fileName}`;
  fs.renameSync(originalPath, path.join(quarantineDir, destName));
  log(`Quarantined: ${reason}`);
}

function recordBroadcastReceipt(originalMsg, ackMsg, processingTime, actions) {
  const receipt = {
    received_at: nowIso(),
    broadcast_id: originalMsg.broadcast_metadata.broadcast_id,
    original_task_id: originalMsg.task_id,
    original_subject: originalMsg.subject,
    originator: originalMsg.from,
    processing_time_ms: processingTime,
    acknowledgment_sent: { task_id: ackMsg.task_id, timestamp: ackMsg.timestamp },
    actions_taken: actions
  };

  const receiptPath = path.join(LANE_ROOT, 'lanes', LANE_ID, 'broadcast-endpoint', 'receipts.json');
  let receipts = [];
  if (fs.existsSync(receiptPath)) {
    try { receipts = JSON.parse(fs.readFileSync(receiptPath, 'utf8')); } catch (_) {}
  }
  receipts.push(receipt);
  fs.writeFileSync(receiptPath, JSON.stringify(receipts, null, 2), 'utf8');
}

function scanInbox() {
  if (!fs.existsSync(INBOX_DIR)) {
    log(`ERROR: Inbox not found: ${INBOX_DIR}`);
    return 0;
  }

  const files = fs.readdirSync(INBOX_DIR).filter(f => f.endsWith('.json'));
  const broadcastFiles = files.filter(f => !f.startsWith('heartbeat-'));

  if (broadcastFiles.length === 0) {
    log('No messages in inbox');
    return 0;
  }

  log(`Scanning: ${broadcastFiles.length} file(s)`);
  let processed = 0;

  for (const file of broadcastFiles) {
    const filePath = path.join(INBOX_DIR, file);

    try {
      const stat = fs.statSync(filePath);
      if (Date.now() - stat.mtimeMs < 1000) continue;
    } catch (_) { continue; }

    try {
      const raw = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
      const msg = JSON.parse(raw);

      if (isBroadcastMessage(msg)) {
        log(`P0 broadcast: ${file}`);
        if (processBroadcastFile(filePath, file)) processed++;
      }
    } catch (err) {
      log(`ERROR reading ${file}: ${err.message}`);
    }
  }

  return processed;
}

function main() {
  const args = process.argv.slice(2);
  const testMode = args.includes('--test');

  ensureDir(PROCESSED_DIR);
  ensureDir(path.join(LANE_ROOT, 'lanes', LANE_ID, 'inbox', 'quarantine'));
  ensureDir(path.join(LANE_ROOT, 'lanes', LANE_ID, 'broadcast-endpoint'));

  log(`=== Broadcast Receiver [${LANE_ID}] ===`);

  if (testMode) {
    console.log(`[${LANE_ID}] Broadcast endpoint test - OK`);
    console.log(`Inbox: ${INBOX_DIR}`);
    console.log(`Schema: ${BROADCAST_SCHEMA_PATH}`);
    process.exit(0);
  }

  const processed = scanInbox();
  log(`Scan complete: ${processed} processed`);
  log(`=== Done ===`);

  process.exit(0);
}

if (require.main === module) main();
