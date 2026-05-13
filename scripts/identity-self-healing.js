#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getAllBroadcastTrustStorePaths, getLaneRoots, computeKeyIdFromPem } = require('./canonical-trust-resolver');
const { deriveKeyId } = require(path.join(__dirname, '..', '.global', 'deriveKeyId.js'));
const { loadPrivateKey: loadPrivateKeyHelper, getAlgorithmParams, sign: algoSign, isPassphraseRequired, generateKeyPair, SUPPORTED_ALGORITHMS, getAlgorithmForLane } = require(path.join(__dirname, '..', '.global', 'algorithm-helpers.js'));
const IS_WIN32 = process.platform === 'win32';

const PASSFILE_SEARCH = IS_WIN32
  ? [
      'S:/Archivist-Agent/.runtime/lane-passphrases.json',
      'S:/self-organizing-library/.runtime/lane-passphrases.json',
      'S:/SwarmMind/.runtime/lane-passphrases.json',
      'S:/kernel-lane/.runtime/lane-passphrases.json',
    ]
  : [
      '/home/we4free/agent/repos/Archivist-Agent/.runtime/lane-passphrases.json',
      '/home/we4free/agent/repos/self-organizing-library/.runtime/lane-passphrases.json',
      '/home/we4free/agent/repos/SwarmMind/.runtime/lane-passphrases.json',
      '/home/we4free/agent/repos/kernel-lane/.runtime/lane-passphrases.json',
    ];

const LANE_IDENTITY_DIRS = IS_WIN32
  ? {
      archivist: 'S:/Archivist-Agent/.identity',
      library: 'S:/self-organizing-library/.identity',
      swarmmind: 'S:/SwarmMind/.identity',
      kernel: 'S:/kernel-lane/.identity',
    }
  : {
      archivist: '/home/we4free/agent/repos/Archivist-Agent/.identity',
      library: '/home/we4free/agent/repos/self-organizing-library/.identity',
      swarmmind: '/home/we4free/agent/repos/SwarmMind/.identity',
      kernel: '/home/we4free/agent/repos/kernel-lane/.identity',
    };

class IdentitySelfHealing {
  constructor(options = {}) {
    this.laneId = options.laneId || 'unknown';
    this.identityDir = options.identityDir || LANE_IDENTITY_DIRS[this.laneId];
    this.passfilePath = options.passfilePath || null;
    this._log = options.logger || ((level, msg) => console.log(`[identity-heal] [${level}] ${msg}`));
  }

  check() {
    const result = {
      laneId: this.laneId,
      identityDir: this.identityDir,
      keysPresent: false,
      keysRegenerated: false,
      trustStoreUpdated: false,
      passphraseSource: null,
      keyId: null,
      error: null,
      skipped: false,
    };

    if (!this.identityDir) {
      result.error = 'NO_IDENTITY_DIR';
      result.skipped = true;
      this._log('INFO', `identity dir not configured for ${this.laneId} — trust-store is canonical, skipping self-heal`);
      return result;
    }

    if (!fs.existsSync(this.identityDir)) {
      result.skipped = true;
      this._log('INFO', `.identity/ deleted per P0 ruling for ${this.laneId} — trust-store is canonical, skipping self-heal`);
      return result;
    }

    const pubPath = path.join(this.identityDir, 'public.pem');
    const privPath = path.join(this.identityDir, 'private.pem');
    result.keysPresent = fs.existsSync(pubPath) && fs.existsSync(privPath);

    if (result.keysPresent) {
      try {
        const pub = fs.readFileSync(pubPath, 'utf8');
        result.keyId = deriveKeyId(pub);
        this._log('INFO', `keys present: ${this.laneId} keyId=${result.keyId}`);
      } catch (e) {
        result.error = `KEY_READ_FAILED: ${e.message}`;
        result.keysPresent = false;
      }
    }

    if (!result.keysPresent) {
      this._log('WARN', `keys MISSING for ${this.laneId} — attempting self-heal`);
      const healed = this._regenerate();
      if (healed) {
        result.keysRegenerated = true;
        result.trustStoreUpdated = healed.trustStoreUpdated;
        result.passphraseSource = healed.passphraseSource;
        result.keyId = healed.keyId;
        result.keysPresent = true;
      } else {
        result.error = (healed && healed.error) || 'REGENERATION_FAILED';
      }
    }

    return result;
  }

  _regenerate() {
    let passphrase = null;
    const algorithm = this._getAlgorithm();

    if (algorithm === 'RS256') {
      passphrase = this._findPassphrase();
      if (!passphrase) {
        this._log('ERROR', `no passphrase found for ${this.laneId} — cannot self-heal RSA key`);
        return { error: 'NO_PASSPHRASE' };
      }
    }

    try {
      fs.mkdirSync(this.identityDir, { recursive: true });

      const { publicKey, privateKey } = generateKeyPair(algorithm);

      fs.writeFileSync(path.join(this.identityDir, 'public.pem'), publicKey);
      fs.writeFileSync(path.join(this.identityDir, 'private.pem'), privateKey);

      const keyId = deriveKeyId(publicKey);

      const algLabel = algorithm === 'EdDSA' ? 'EdDSA' : 'RS256';
      const meta = {
        lane_id: this.laneId,
        key_id: keyId,
        algorithm: algLabel,
        generated_at: new Date().toISOString(),
        self_healed: true,
      };
      fs.writeFileSync(path.join(this.identityDir, 'meta.json'), JSON.stringify(meta, null, 2));

      this._log('INFO', `keys regenerated: ${this.laneId} keyId=${keyId} algorithm=${algLabel}`);

      const trustStoreUpdated = this._updateTrustStores(publicKey, keyId, algLabel);

      return { keyId, passphraseSource: algorithm === 'RS256' ? this._passphraseSource : 'none-ed25519', trustStoreUpdated };
    } catch (e) {
      this._log('ERROR', `regeneration failed for ${this.laneId}: ${e.message}`);
      return { error: `REGENERATION_ERROR: ${e.message}` };
    }
  }

  _getAlgorithm() {
    const tsPath = path.join(
      path.dirname(this.identityDir),
      'lanes', 'broadcast', 'trust-store.json'
    );
    try {
      if (fs.existsSync(tsPath)) {
        const ts = JSON.parse(fs.readFileSync(tsPath, 'utf8'));
        const stored = getAlgorithmForLane(ts, this.laneId);
        if (stored) return stored === 'EdDSA' ? 'EdDSA' : 'RS256';
      }
    } catch (_) {}

    const trustStoreDirs = getAllBroadcastTrustStorePaths();
    for (const [laneName, dir] of Object.entries(trustStoreDirs)) {
      try {
        const tsPath2 = path.join(dir, 'trust-store.json');
        if (!fs.existsSync(tsPath2)) continue;
        const ts = JSON.parse(fs.readFileSync(tsPath2, 'utf8'));
        const stored = getAlgorithmForLane(ts, this.laneId);
        if (stored) return stored === 'EdDSA' ? 'EdDSA' : 'RS256';
      } catch (_) {}
    }

    this._log('INFO', `no trust store algorithm found for ${this.laneId} — defaulting to EdDSA`);
    return 'EdDSA';
  }

  _findPassphrase() {
    if (process.env.LANE_KEY_PASSPHRASE) {
      this._passphraseSource = 'env';
      return process.env.LANE_KEY_PASSPHRASE;
    }

    const laneKeyVar = `LANE_KEY_PASSPHRASE_${this.laneId.toUpperCase()}`;
    if (process.env[laneKeyVar]) {
      this._passphraseSource = 'env-lane';
      return process.env[laneKeyVar];
    }

    for (const passfile of PASSFILE_SEARCH) {
      try {
        if (!fs.existsSync(passfile)) continue;
        const parsed = JSON.parse(fs.readFileSync(passfile, 'utf8'));
        if (parsed && parsed[this.laneId]) {
          const val = parsed[this.laneId];
          this._passphraseSource = 'passfile';
          return typeof val === 'object' && val.passphrase ? val.passphrase : val;
        }
      } catch (_) {}
    }

    this._passphraseSource = null;
    return null;
  }

  _updateTrustStores(publicKey, keyId, algorithm) {
    const trustStorePaths = getAllBroadcastTrustStorePaths();

    let updated = 0;
    for (const [laneName, tsPath] of Object.entries(trustStorePaths)) {
      try {
        if (!fs.existsSync(tsPath)) continue;
        const ts = JSON.parse(fs.readFileSync(tsPath, 'utf8'));
        if (ts[this.laneId]) {
          ts[this.laneId].public_key_pem = publicKey;
          ts[this.laneId].key_id = keyId;
          ts[this.laneId].algorithm = algorithm || 'EdDSA';
          ts[this.laneId].registered_at = new Date().toISOString();
          fs.writeFileSync(tsPath, JSON.stringify(ts, null, 2));
          updated++;
        }
      } catch (_) {}
    }

    if (updated > 0) {
      this._log('INFO', `trust stores updated: ${updated} lanes`);
    }
    return updated > 0;
  }
}

function healLaneIdentity(laneId, options = {}) {
  const healer = new IdentitySelfHealing({ laneId, ...options });
  return healer.check();
}

module.exports = { IdentitySelfHealing, healLaneIdentity };

if (require.main === module) {
  const lane = process.argv[2] || process.env.LANE_NAME || 'unknown';
  const result = healLaneIdentity(lane);
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.keysPresent ? 0 : 1);
}
