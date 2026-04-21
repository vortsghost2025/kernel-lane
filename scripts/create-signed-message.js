#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PASSFILE = 'S:/Archivist-Agent/.runtime/lane-passphrases.json';

const LANE_IDENTITY_DIRS = {
  archivist: 'S:/Archivist-Agent/.identity',
  library: 'S:/self-organizing-library/.identity',
  swarmmind: 'S:/SwarmMind Self-Optimizing Multi-Agent AI System/.identity',
  kernel: 'S:/kernel-lane/.identity',
};

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
  try {
    if (fs.existsSync(PASSFILE)) {
      const parsed = JSON.parse(fs.readFileSync(PASSFILE, 'utf8'));
      if (parsed && parsed[laneId]) {
        const val = parsed[laneId];
        return typeof val === 'object' && val.passphrase ? val.passphrase : val;
      }
    }
  } catch (_) {}
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
  if (!passphrase) throw new Error(`PASSPHRASE_MISSING for lane ${laneId}`);

  const publicPem = fs.readFileSync(pubPath, 'utf8');
  const privatePem = fs.readFileSync(privPath, 'utf8');

  let privateKey;
  try {
    privateKey = crypto.createPrivateKey({ key: privatePem, format: 'pem', passphrase });
  } catch (e) {
    throw new Error(`PRIVATE_KEY_DECRYPT_FAILED for ${laneId}: ${e.message}`);
  }

  const keyId = crypto.createHash('sha256').update(publicPem).digest('hex').substring(0, 16);
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
  };
}

function writeSignedMessage(msg, laneId, outboxPath) {
  const signed = createSignedMessage(msg, laneId);
  if (!fs.existsSync(outboxPath)) {
    fs.mkdirSync(outboxPath, { recursive: true });
  }
  const filename = `${msg.id || 'msg-' + Date.now()}.json`;
  const filePath = path.join(outboxPath, filename);
  fs.writeFileSync(filePath, JSON.stringify(signed, null, 2) + '\n', 'utf8');
  return { filePath, keyId: signed.key_id, filename };
}

module.exports = { createSignedMessage, writeSignedMessage, findPassphrase, stableStringify };

if (require.main === module) {
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
    const result = writeSignedMessage(msg, lane, outboxDir);
    console.error(`[signed] Written: ${result.filePath} key_id=${result.keyId}`);
  }
}
