#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { deriveKeyId } = require(path.join(__dirname, '..', '.global', 'deriveKeyId.js'));

// LEASE + ATOMIC WRITE: Require kernel primitives for cross-lane mutation safety
const KERNEL_ROOT = 'S:/kernel-lane';
const { atomicWriteWithLease } = require(path.join(KERNEL_ROOT, 'scripts', 'atomic-write-util'));
const { guardWrite } = require(path.join(__dirname, 'outbox-write-guard'));

const PASSFILE_CANDIDATES = [
  path.join(__dirname, '..', '.runtime', 'lane-passphrases.json'),
  'S:/Archivist-Agent/.runtime/lane-passphrases.json'
];

const LANE_IDENTITY_DIRS = {
  archivist: 'S:/Archivist-Agent/.identity',
  library: 'S:/self-organizing-library/.identity',
  swarmmind: 'S:/SwarmMind/.identity',
  kernel: 'S:/kernel-lane/.identity',
};

const DEFAULT_PAYLOAD = { mode: 'inline', compression: 'none' };
const DEFAULT_EXECUTION = { mode: 'manual', engine: 'pipeline', actor: 'lane' };
const DEFAULT_RETRY = { attempt: 1, max_attempts: 3 };
const DEFAULT_HEARTBEAT = {
  status: 'pending',
  last_heartbeat_at: null,
  interval_seconds: 300,
  timeout_seconds: 900,
};

const SESSION_ID = process.env.SESSION_ID || `sess-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
const ORIGIN_RUNTIME = process.env.ORIGIN_RUNTIME || 'opencode';
const ORIGIN_WORKSPACE = process.env.ORIGIN_WORKSPACE || process.cwd();
const SESSION_EPOCH = new Date().toISOString();

function canonicalId(prefix = 'task') {
  return `${prefix}-${Date.now()}`;
}

function buildCanonicalMessage(options = {}) {
  const {
    profile = 'default',
    schema_version = '1.3',
    task_id = canonicalId('task'),
    idempotency_key = null,
    from = 'archivist',
    to = 'swarmmind',
    type = 'task',
    task_kind = 'proposal',
    priority = 'P2',
    subject = '',
    body = '',
    requires_action = true,
    payload = {},
    execution = {},
    lease = {},
    retry = {},
    evidence = {},
    evidence_exchange = {},
    heartbeat = {},
    extra = {},
  } = options;

  const now = new Date().toISOString();
  const resolvedTaskId = task_id || canonicalId('task');
  const resolvedIdempotency = idempotency_key || `${from}-${to}-${resolvedTaskId}`;

  const profileDefaults = (() => {
    if (profile === 'control_actionable_pre_execution') {
      return {
        requires_action: true,
        evidence: { required: false, verified: false },
        evidence_exchange: {},
      };
    }
    return {};
  })();

  const mergedPayload = { ...DEFAULT_PAYLOAD, ...payload };
  const mergedExecution = { ...DEFAULT_EXECUTION, ...execution };
  const mergedLease = { owner: to, acquired_at: now, ...lease };
  const mergedRetry = { ...DEFAULT_RETRY, ...retry };
  const mergedEvidence = {
    required: false,
    verified: false,
    ...profileDefaults.evidence,
    ...evidence,
  };
  const mergedEvidenceExchange = {
    ...profileDefaults.evidence_exchange,
    ...evidence_exchange,
  };
  const mergedHeartbeat = {
    ...DEFAULT_HEARTBEAT,
    last_heartbeat_at: now,
    ...heartbeat,
  };

  return {
    schema_version,
    task_id: resolvedTaskId,
    idempotency_key: resolvedIdempotency,
    from,
    to,
    type,
    task_kind,
    priority,
    subject,
    body,
    timestamp: now,
    requires_action: profileDefaults.requires_action !== undefined ? profileDefaults.requires_action : requires_action,
    payload: mergedPayload,
    execution: mergedExecution,
    lease: mergedLease,
    retry: mergedRetry,
    evidence: mergedEvidence,
    evidence_exchange: mergedEvidenceExchange,
    heartbeat: mergedHeartbeat,
    ...extra,
  };
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const keys = Object.keys(value).sort();
  const parts = keys.map((k) => JSON.stringify(k) + ':' + stableStringify(value[k]));
  return '{' + parts.join(',') + '}';
}

function base64UrlEncode(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function findPassphrase(laneId) {
  if (process.env.LANE_KEY_PASSPHRASE) return process.env.LANE_KEY_PASSPHRASE;
  const envKey = `LANE_KEY_PASSPHRASE_${laneId.toUpperCase()}`;
  if (process.env[envKey]) return process.env[envKey];
    for (const passfile of PASSFILE_CANDIDATES) {
    try {
      if (!fs.existsSync(passfile)) continue;
      const parsed = JSON.parse(fs.readFileSync(passfile, 'utf8'));
      if (parsed && parsed[laneId]) {
        const val = parsed[laneId];
        return typeof val === 'object' && val.passphrase ? val.passphrase : val;
      }
    } catch (_) {}
  }
  return null;
}

function createSignedMessage(msg, laneId) {
  const identityDir = LANE_IDENTITY_DIRS[laneId];
  if (!identityDir) throw new Error(`Unknown lane: ${laneId}`);

  const pubPath = path.join(identityDir, 'public.pem');
  const privPath = path.join(identityDir, 'private.pem');

  if (!fs.existsSync(pubPath) || !fs.existsSync(privPath)) {
    throw new Error(`SIGNING_KEYS_MISSING: ${identityDir} — run identity-self-healing first`);
  }

  const passphrase = findPassphrase(laneId);
  const publicPem = fs.readFileSync(pubPath, 'utf8');
  const privatePem = fs.readFileSync(privPath, 'utf8');

  let privateKey;
  try {
    if (passphrase) {
      privateKey = crypto.createPrivateKey({ key: privatePem, format: 'pem', passphrase });
    } else {
      privateKey = crypto.createPrivateKey({ key: privatePem, format: 'pem' });
    }
  } catch (e) {
    throw new Error(`PRIVATE_KEY_LOAD_FAILED for ${laneId}: ${e.message}`);
  }

  const keyId = deriveKeyId(publicPem);
  const from = msg.from || msg.from_lane || laneId;
  const to = msg.to || msg.to_lane || null;
  const contentHash = 'sha256:' + crypto.createHash('sha256')
    .update(stableStringify({ body: msg.body || '', payload: msg.payload || {} }))
    .digest('hex');

  const header = { alg: 'RS256', typ: 'JWT', kid: keyId };
  const payload = {
    id: msg.id || null,
    task_id: msg.task_id || null,
    from,
    to,
    lane: from,
    priority: msg.priority || null,
    content_hash: contentHash,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor((Date.now() + 86400000) / 1000),
  };

  const signingInput = `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(stableStringify(payload))}`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(signingInput), privateKey);
  const jws = `${signingInput}.${base64UrlEncode(signature)}`;

  return {
    ...msg,
    from,
    to,
    content_hash: contentHash,
    signature: jws,
    signature_alg: 'RS256',
    key_id: keyId,
    session_identity: {
      session_id: SESSION_ID,
      session_epoch_started_at: SESSION_EPOCH,
      origin_runtime: ORIGIN_RUNTIME,
      origin_workspace: ORIGIN_WORKSPACE,
    },
  };
}

async function writeSignedMessage(msg, laneId, outboxPath) {
  const signed = createSignedMessage(msg, laneId);
  if (!fs.existsSync(outboxPath)) {
    fs.mkdirSync(outboxPath, { recursive: true });
  }
  const filename = `${msg.id || 'msg-' + Date.now()}.json`;
  const filePath = path.join(outboxPath, filename);
  // Governance invariant: every outbound write must carry explicit lease metadata.
  if (!signed.lease || typeof signed.lease !== 'object') {
    const now = Date.now();
    signed.lease = {
      owner: laneId,
      acquired_at: new Date(now).toISOString(),
      expires_at: new Date(now + 30000).toISOString(),
      renewal_count: 0,
      max_renewals: 3
    };
  }
  guardWrite(signed, outboxPath, filename);
  // Atomic write with mandatory lease
  await atomicWriteWithLease(filePath, signed, laneId, 30000);
  return { filePath, keyId: signed.key_id, filename };
}

module.exports = {
  createSignedMessage,
  writeSignedMessage,
  findPassphrase,
  stableStringify,
  buildCanonicalMessage,
};

if (require.main === module) {
  (async () => {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.error('Usage: node create-signed-message.js <message.json> <lane> [outbox-dir]');
    process.exit(1);
  }
  const messagePath = args[0];
  const lane = args[1];
  const outboxDir = args[2] || null;

  const raw = fs.readFileSync(messagePath, 'utf8').replace(/^\uFEFF/, '');
  const msg = JSON.parse(raw);
  const signed = createSignedMessage(msg, lane);
  console.log(JSON.stringify(signed, null, 2));

  if (outboxDir) {
    const result = await writeSignedMessage(msg, lane, outboxDir);
    console.error(`[signed] Written: ${result.filePath} key_id=${result.keyId}`);
  }
  })().catch((err) => {
    console.error(`[signed] ERROR: ${err.message}`);
    process.exit(1);
  });
}



