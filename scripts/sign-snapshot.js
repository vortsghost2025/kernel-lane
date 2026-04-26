#!/usr/bin/env node
/**
 * sign-snapshot.js - Sign Identity Snapshot v0.2
 *
 * Signs the current snapshot.json with the lane's private key,
 * producing snapshot.jws (a signed JWS artifact).
 *
 * Usage:
 *   LANE_KEY_PASSPHRASE=<pass> node sign-snapshot.js
 *
 * Outputs:
 *   .identity/snapshot.jws - Compact JWS over snapshot.json
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { atomicWriteWithLease } = require('S:/kernel-lane/scripts/atomic-write-util');

const ROOT = path.join(__dirname, '..');
const IDENTITY_DIR = path.join(ROOT, '.identity');
const TRUST_STORE_PATH = path.join(ROOT, '.trust', 'keys.json');
const SNAPSHOT_PATH = path.join(IDENTITY_DIR, 'snapshot.json');
const SNAPSHOT_JWS_PATH = path.join(IDENTITY_DIR, 'snapshot.jws');
const PRIVATE_KEY_PATH = path.join(IDENTITY_DIR, 'private.pem');

function stableStringify(value) {
  if (value === null) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map(stableStringify).join(',') + ']';
  }
  const keys = Object.keys(value).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
}

function base64UrlEncode(data) {
  const base64 = Buffer.isBuffer(data) ? data.toString('base64') : Buffer.from(data).toString('base64');
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function getPassphrase() {
  const passphrase = process.env.LANE_KEY_PASSPHRASE;
  if (!passphrase) {
    throw new Error('LANE_KEY_PASSPHRASE environment variable not set');
  }
  return passphrase;
}

function loadPrivateKey(passphrase) {
  if (!fs.existsSync(PRIVATE_KEY_PATH)) {
    throw new Error('Private key not found at ' + PRIVATE_KEY_PATH);
  }
  const encryptedKey = fs.readFileSync(PRIVATE_KEY_PATH, 'utf8');
  try {
    return crypto.createPrivateKey({
      key: encryptedKey,
      passphrase: passphrase,
      format: 'pem'
    });
  } catch (e) {
    throw new Error('Failed to decrypt private key: ' + e.message);
  }
}

function getKeyIdFromTrustStore() {
  const trustStore = JSON.parse(fs.readFileSync(TRUST_STORE_PATH, 'utf8'));
  const archivistEntry = trustStore.keys?.archivist;
  if (!archivistEntry) {
    throw new Error('Archivist key not found in trust store');
  }
  return archivistEntry.key_id;
}

async function signSnapshot() {
  console.log('=== Identity Snapshot Signing v0.2 ===\n');

  if (!fs.existsSync(SNAPSHOT_PATH)) {
    console.error('ERROR: snapshot.json not found at', SNAPSHOT_PATH);
    process.exit(1);
  }

  const snapshot = JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf8'));
  console.log('Loaded snapshot.json');
  console.log('  Version:', snapshot.version);
  console.log('  Identity ID:', snapshot.identity?.id);
  console.log('  Lane:', snapshot.identity?.lane);

  const passphrase = getPassphrase();
  const privateKey = loadPrivateKey(passphrase);
  console.log('\nPrivate key loaded and decrypted');

  const keyId = getKeyIdFromTrustStore();
  console.log('Key ID from trust store:', keyId);

  if (snapshot.identity?.key_id && snapshot.identity.key_id !== keyId) {
    console.error('WARNING: snapshot.key_id mismatch with trust store');
    console.error('  Snapshot:', snapshot.identity.key_id);
    console.error('  Trust store:', keyId);
  }

  const header = {
    alg: 'RS256',
    typ: 'JWS',
    kid: keyId
  };

  const headerB64 = base64UrlEncode(JSON.stringify(header));
  const payloadB64 = base64UrlEncode(stableStringify(snapshot));
  const signingInput = `${headerB64}.${payloadB64}`;

  const signature = crypto.sign('RSA-SHA256', Buffer.from(signingInput), privateKey);
  const signatureB64 = base64UrlEncode(signature);

  const jws = `${headerB64}.${payloadB64}.${signatureB64}`;

  await atomicWriteWithLease(SNAPSHOT_JWS_PATH, jws, 'archivist', 30000);

  console.log('\nSigned snapshot written to:', SNAPSHOT_JWS_PATH);
  console.log('JWS length:', jws.length, 'characters');
  console.log('\n=== SIGNING COMPLETE ===');

  return { success: true, jwsPath: SNAPSHOT_JWS_PATH, keyId };
}

if (require.main === module) {
  (async () => {
    await signSnapshot();
  })().catch((e) => {
    console.error('\nERROR:', e.message);
    process.exit(1);
  });
}
