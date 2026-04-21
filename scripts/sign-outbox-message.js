#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PASSFILE_CANDIDATES = [
  path.join(__dirname, '..', '.runtime', 'lane-passphrases.json'),
  'S:/Archivist-Agent/.runtime/lane-passphrases.json'
];

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (!key.startsWith('--')) continue;
    const name = key.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      out[name] = 'true';
      continue;
    }
    out[name] = next;
    i += 1;
  }
  return out;
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return '[' + value.map(stableStringify).join(',') + ']';
  }

  const keys = Object.keys(value).sort();
  const parts = keys.map((k) => JSON.stringify(k) + ':' + stableStringify(value[k]));
  return '{' + parts.join(',') + '}';
}

function base64UrlEncode(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

const LANE_IDENTITY_DIRS = {
  archivist: 'S:/Archivist-Agent/.identity',
  library: 'S:/self-organizing-library/.identity',
  swarmmind: 'S:/SwarmMind Self-Optimizing Multi-Agent AI System/.identity',
  kernel: 'S:/kernel-lane/.identity',
};

function resolvePassphrase(lane) {
  if (process.env.LANE_KEY_PASSPHRASE) return process.env.LANE_KEY_PASSPHRASE;
  const laneKeyVar = `LANE_KEY_PASSPHRASE_${String(lane || '').toUpperCase()}`;
  if (process.env[laneKeyVar]) return process.env[laneKeyVar];

  for (const passfile of PASSFILE_CANDIDATES) {
    try {
      if (!fs.existsSync(passfile)) continue;
      const parsed = JSON.parse(fs.readFileSync(passfile, 'utf8'));
      if (parsed && typeof parsed === 'object' && parsed[lane]) {
        const val = parsed[lane];
        return typeof val === 'object' && val.passphrase ? val.passphrase : val;
      }
    } catch (_) {
      // continue
    }
  }

  return null;
}

function loadKeyMaterial(identityDir, lane, passphrase) {
  const privatePath = path.join(identityDir, 'private.pem');
  const publicPath = path.join(identityDir, 'public.pem');

  if (!fs.existsSync(privatePath) || !fs.existsSync(publicPath)) {
    throw new Error(`SIGNING_KEYS_MISSING: ${identityDir}`);
  }

  const privatePem = fs.readFileSync(privatePath, 'utf8');
  const publicPem = fs.readFileSync(publicPath, 'utf8');

  let privateKey;
  try {
    privateKey = crypto.createPrivateKey({
      key: privatePem,
      format: 'pem',
      passphrase
    });
  } catch (err) {
    throw new Error(`PRIVATE_KEY_DECRYPT_FAILED for lane ${lane}: ${err.message}`);
  }

  const keyId = crypto.createHash('sha256').update(publicPem).digest('hex').slice(0, 16);
  return { privateKey, keyId };
}

function signInboxShape(msg, lane, privateKey, keyId) {
  const from = msg.from || msg.from_lane || lane;
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
    exp: Math.floor((Date.now() + 86400000) / 1000)
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
    key_id: keyId
  };
}

function signMessageFile(messagePath, lane, force) {
  const absolutePath = path.resolve(messagePath);
  if (!fs.existsSync(absolutePath)) {
    throw new Error(`MESSAGE_FILE_MISSING: ${absolutePath}`);
  }

  const raw = fs.readFileSync(absolutePath, 'utf8');
  const msg = JSON.parse(raw.replace(/^\uFEFF/, ''));

  const effectiveLane = lane || msg.from || msg.from_lane;
  if (!effectiveLane) {
    throw new Error('LANE_REQUIRED: provide --lane or include from/from_lane in message');
  }

  if (!force && (msg.signature || msg.jws)) {
    console.log(`[sign-outbox] Already signed: ${absolutePath}`);
    return;
  }

  const passphrase = resolvePassphrase(effectiveLane);
  if (!passphrase) {
    throw new Error(`PASSPHRASE_MISSING: no passphrase found for lane ${effectiveLane}`);
  }

  const identityDir = LANE_IDENTITY_DIRS[effectiveLane] || path.join(__dirname, '..', '.identity');
  const { privateKey, keyId } = loadKeyMaterial(identityDir, effectiveLane, passphrase);
  const signed = signInboxShape(msg, effectiveLane, privateKey, keyId);

  fs.writeFileSync(absolutePath, JSON.stringify(signed, null, 2) + '\n', 'utf8');
  console.log(`[sign-outbox] Signed ${absolutePath} with key_id=${keyId}`);
}

(function main() {
  const args = parseArgs(process.argv.slice(2));
  const message = args.message || args.path;
  if (!message) {
    console.error('Usage: node scripts/sign-outbox-message.js --message <path> [--lane <lane>] [--force]');
    process.exit(1);
  }

  try {
    signMessageFile(message, args.lane || null, args.force === 'true');
  } catch (err) {
    console.error(`[sign-outbox] ERROR: ${err.message}`);
    process.exit(1);
  }
})();
