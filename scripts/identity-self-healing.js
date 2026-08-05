#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { IdentityEnforcer } = require('./identity-enforcer');
const {
  loadPrivateKey: loadPrivateKeyHelper,
  getAlgorithmParams,
  sign: algoSign,
  isPassphraseRequired,
  generateKeyPair,
  SUPPORTED_ALGORITHMS,
  getAlgorithmForLane
} = require(path.join(__dirname, '..', '.global', 'algorithm-helpers.js'));
const { deriveKeyId } = require(path.join(__dirname, '..', '.global', 'deriveKeyId.js'));

const isWin32 = process.platform === 'win32';
const UBUNTU_ROOT = path.join(require('os').homedir(), 'agent', 'repos');
function _resolve(winPath) {
  if (isWin32) return winPath;
  const m = winPath.match(/^S:\/(.+)$/);
  return m ? path.join(UBUNTU_ROOT, m[1]) : winPath;
}

const PASSFILE_SEARCH = [
  _resolve('S:/Archivist-Agent/.runtime/lane-passphrases.json'),
  _resolve('S:/self-organizing-library/.runtime/lane-passphrases.json'),
  _resolve('S:/SwarmMind/.runtime/lane-passphrases.json'),
  _resolve('S:/kernel-lane/.runtime/lane-passphrases.json'),
];

const TRUST_STORE_SEARCH_PATHS = [
  _resolve('S:/Archivist-Agent/lanes/broadcast/trust-store.json'),
  _resolve('S:/kernel-lane/lanes/broadcast/trust-store.json'),
  _resolve('S:/self-organizing-library/lanes/broadcast/trust-store.json'),
  _resolve('S:/SwarmMind/lanes/broadcast/trust-store.json'),
];

const LANE_IDENTITY_DIRS = {
  archivist: _resolve('S:/Archivist-Agent/.identity'),
  authority: _resolve('S:/Archivist-Agent/.identity/authority'),
  library: _resolve('S:/self-organizing-library/.identity'),
  swarmmind: _resolve('S:/SwarmMind/.identity'),
  kernel: _resolve('S:/kernel-lane/.identity'),
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

    for (const dir of TRUST_STORE_SEARCH_PATHS) {
      try {
        if (!fs.existsSync(dir)) continue;
        const ts = JSON.parse(fs.readFileSync(dir, 'utf8'));
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
    const trustStoreDirs = [
      'S:/Archivist-Agent/lanes/broadcast',
      'S:/self-organizing-library/lanes/broadcast',
      'S:/kernel-lane/lanes/broadcast',
    ];
    if (this.identityDir.includes('SwarmMind')) {
      trustStoreDirs.push('S:/SwarmMind/lanes/broadcast');
    }

    let updated = 0;
    for (const dir of trustStoreDirs) {
      const tsPath = path.join(dir, 'trust-store.json');
      try {
        if (!fs.existsSync(tsPath)) continue;
        const ts = JSON.parse(fs.readFileSync(tsPath, 'utf8'));
        const entry = (ts.keys && ts.keys[this.laneId]) || ts[this.laneId];
        if (entry) {
          entry.public_key_pem = publicKey;
          entry.key_id = keyId;
          entry.algorithm = algorithm || 'EdDSA';
          entry.registered_at = new Date().toISOString();
          IdentityEnforcer.writeTrustStoreStrict(tsPath, ts, { actorLane: this.laneId });
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
