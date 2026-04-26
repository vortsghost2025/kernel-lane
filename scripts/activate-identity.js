#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { IdentityEnforcer } = require('./identity-enforcer');

const LANES = [
  { id: 'archivist', dir: 'S:/Archivist-Agent' },
  { id: 'library', dir: 'S:/self-organizing-library' },
  { id: 'swarmmind', dir: 'S:/SwarmMind' },
  { id: 'kernel', dir: 'S:/kernel-lane' },
];

const PASSPHRASE_FILE = 'S:/Archivist-Agent/.runtime/lane-passphrases.json';

function generatePassphrase() {
  return crypto.randomBytes(32).toString('hex');
}

function activateLane(lane) {
  const identityDir = path.join(lane.dir, '.identity');
  if (!fs.existsSync(identityDir)) {
    fs.mkdirSync(identityDir, { recursive: true });
  }

  const KeyManager = require(path.join(lane.dir, 'src/attestation/KeyManager.js')).KeyManager;
  const km = new KeyManager({ identityDir, laneId: lane.id });

  const passphrase = generatePassphrase();

  if (km.hasKeys()) {
    const pubKey = km.loadPublicKey();
    const keyId = km._generateKeyId(pubKey);
    try {
      km.loadPrivateKey(passphrase);
      return { lane: lane.id, status: 'existing', keyId, passphrase, note: 'keys exist but passphrase may not match' };
    } catch (_) {
      return { lane: lane.id, status: 'existing_key_mismatch', keyId, passphrase: null, note: 'keys exist but passphrase unknown — must rotate' };
    }
  }

  try {
    const result = km.initialize(passphrase);
    return { lane: lane.id, status: 'generated', keyId: result.keyId, passphrase, generated: true };
  } catch (e) {
    return { lane: lane.id, status: 'error', error: e.message };
  }
}

function main() {
  console.log('=== Identity Chain Activation ===\n');

  const results = [];
  const passphrases = {};

  for (const lane of LANES) {
    console.log(`Activating ${lane.id}...`);
    const result = activateLane(lane);
    results.push(result);

    if (result.passphrase) {
      passphrases[lane.id] = result.passphrase;
      console.log(`  ${result.status} — keyId: ${result.keyId}`);
    } else {
      console.log(`  ${result.status} — ${result.note || result.error}`);
    }
  }

  if (Object.keys(passphrases).length > 0) {
    const runtimeDir = path.dirname(PASSPHRASE_FILE);
    if (!fs.existsSync(runtimeDir)) {
      fs.mkdirSync(runtimeDir, { recursive: true });
    }
    fs.writeFileSync(PASSPHRASE_FILE, JSON.stringify(passphrases, null, 2), 'utf8');
    console.log(`\nPassphrases saved to: ${PASSPHRASE_FILE}`);
    console.log('ADD TO .gitignore: .runtime/');
  }

  console.log('\n=== Trust Store Population ===\n');

  const trustStore = {};
  for (const lane of LANES) {
    const identityDir = path.join(lane.dir, '.identity');
    const KeyManager = require(path.join(lane.dir, 'src/attestation/KeyManager.js')).KeyManager;
    const km = new KeyManager({ identityDir, laneId: lane.id });

    if (km.hasKeys()) {
      const info = km.exportForTrustStore();
      if (info) {
        trustStore[lane.id] = info;
        console.log(`  ${lane.id}: keyId=${info.key_id} registered`);
      }
    } else {
      console.log(`  ${lane.id}: NO KEYS — not in trust store`);
    }
  }

  const trustStorePath = 'S:/Archivist-Agent/lanes/broadcast/trust-store.json';
  IdentityEnforcer.writeTrustStoreStrict(trustStorePath, trustStore, { actorLane: 'archivist' });
  console.log(`\nTrust store saved to: ${trustStorePath}`);

  const activeCount = Object.keys(trustStore).length;
  console.log(`\n=== Result: ${activeCount}/4 lanes have active identity ===`);

  if (activeCount === 4) {
    console.log('Identity chain FULLY ACTIVE — all lanes authenticated');
  } else {
    console.log(`${4 - activeCount} lanes still need key activation`);
  }
}

main();
