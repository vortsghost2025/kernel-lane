#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const KEY_SIZE = 2048;
const PASSFILE_SEARCH = [
  'S:/Archivist-Agent/.runtime/lane-passphrases.json',
];

const LANE_IDENTITY_DIRS = {
  archivist: 'S:/Archivist-Agent/.identity',
  library: 'S:/self-organizing-library/.identity',
  swarmmind: 'S:/SwarmMind Self-Optimizing Multi-Agent AI System/.identity',
  kernel: 'S:/kernel-lane/.identity',
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
    };

    if (!this.identityDir) {
      result.error = 'NO_IDENTITY_DIR';
      return result;
    }

    const pubPath = path.join(this.identityDir, 'public.pem');
    const privPath = path.join(this.identityDir, 'private.pem');
    result.keysPresent = fs.existsSync(pubPath) && fs.existsSync(privPath);

    if (result.keysPresent) {
      try {
        const pub = fs.readFileSync(pubPath, 'utf8');
        result.keyId = crypto.createHash('sha256').update(pub).digest('hex').substring(0, 16);
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
        result.error = healed?.error || 'REGENERATION_FAILED';
      }
    }

    return result;
  }

  _regenerate() {
    const passphrase = this._findPassphrase();
    if (!passphrase) {
      this._log('ERROR', `no passphrase found for ${this.laneId} — cannot self-heal`);
      return { error: 'NO_PASSPHRASE' };
    }

    try {
      fs.mkdirSync(this.identityDir, { recursive: true });

      const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
        modulusLength: KEY_SIZE,
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: {
          type: 'pkcs8',
          format: 'pem',
          cipher: 'aes-256-cbc',
          passphrase: passphrase,
        },
      });

      fs.writeFileSync(path.join(this.identityDir, 'public.pem'), publicKey);
      fs.writeFileSync(path.join(this.identityDir, 'private.pem'), privateKey);

      const keyId = crypto.createHash('sha256').update(publicKey).digest('hex').substring(0, 16);

      const meta = {
        lane_id: this.laneId,
        key_id: keyId,
        algorithm: 'RS256',
        generated_at: new Date().toISOString(),
        self_healed: true,
      };
      fs.writeFileSync(path.join(this.identityDir, 'meta.json'), JSON.stringify(meta, null, 2));

      this._log('INFO', `keys regenerated: ${this.laneId} keyId=${keyId}`);

      const trustStoreUpdated = this._updateTrustStores(publicKey, keyId);

      return { keyId, passphraseSource: this._passphraseSource, trustStoreUpdated };
    } catch (e) {
      this._log('ERROR', `regeneration failed for ${this.laneId}: ${e.message}`);
      return { error: `REGENERATION_ERROR: ${e.message}` };
    }
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

  _updateTrustStores(publicKey, keyId) {
    const trustStoreDirs = [
      'S:/Archivist-Agent/lanes/broadcast',
      'S:/self-organizing-library/lanes/broadcast',
      'S:/kernel-lane/lanes/broadcast',
    ];
    if (this.identityDir.includes('SwarmMind')) {
      trustStoreDirs.push('S:/SwarmMind Self-Optimizing Multi-Agent AI System/lanes/broadcast');
    }

    let updated = 0;
    for (const dir of trustStoreDirs) {
      const tsPath = path.join(dir, 'trust-store.json');
      try {
        if (!fs.existsSync(tsPath)) continue;
        const ts = JSON.parse(fs.readFileSync(tsPath, 'utf8'));
        if (ts[this.laneId]) {
          ts[this.laneId].public_key_pem = publicKey;
          ts[this.laneId].key_id = keyId;
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
