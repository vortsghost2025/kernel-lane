/**
 * KeyManager.js - Phase 4.3 PKI Key Management
 *
 * Manages RSA keypair generation, storage, and rotation for lane identity.
 * Private keys encrypted with passphrase derived from environment.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const KEY_SIZE = 2048;
const PUBLIC_KEY_FILE = 'public.pem';
const PRIVATE_KEY_FILE = 'private.pem';

// Import canonical deriveKeyId function
const { deriveKeyId } = require('../../.global/deriveKeyId.js');

class KeyManager {
	constructor(options = {}) {
		this.identityDir = options.identityDir || path.join(process.cwd(), '.identity');
		this.laneId = options.laneId || process.env.LANE_NAME || 'unknown';
		this.algorithm = 'RS256';
		this._ensureIdentityDir();
	}

	_ensureIdentityDir() {
		if (!fs.existsSync(this.identityDir)) {
			fs.mkdirSync(this.identityDir, { recursive: true });
		}
	}

	_getPassphrase() {
		const passphrase = process.env.LANE_KEY_PASSPHRASE;
		if (!passphrase) {
			throw new Error('LANE_KEY_PASSPHRASE environment variable not set');
		}
		return passphrase;
	}

	generateKeyPair(passphrase) {
		const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
			modulusLength: KEY_SIZE,
			publicKeyEncoding: { type: 'spki', format: 'pem' },
			privateKeyEncoding: {
				type: 'pkcs8',
				format: 'pem',
				cipher: 'aes-256-cbc',
				passphrase: passphrase
			}
		});

		return { publicKey, privateKey };
	}

	saveKeyPair(publicKey, privateKey, passphrase) {
		const publicKeyPath = path.join(this.identityDir, PUBLIC_KEY_FILE);
		const privateKeyPath = path.join(this.identityDir, PRIVATE_KEY_FILE);

		fs.writeFileSync(publicKeyPath, publicKey, 'utf8');
		fs.writeFileSync(privateKeyPath, privateKey, 'utf8');

		const keyId = this._generateKeyId(publicKey);
		return { publicKeyPath, privateKeyPath, keyId };
	}

  _generateKeyId(publicKey) {
    return deriveKeyId(publicKey);
  }

	loadPublicKey() {
		const publicKeyPath = path.join(this.identityDir, PUBLIC_KEY_FILE);
		if (!fs.existsSync(publicKeyPath)) {
			return null;
		}
		return fs.readFileSync(publicKeyPath, 'utf8');
	}

	loadPrivateKey(passphrase) {
		const privateKeyPath = path.join(this.identityDir, PRIVATE_KEY_FILE);
		if (!fs.existsSync(privateKeyPath)) {
			return null;
		}
		const encryptedPrivateKey = fs.readFileSync(privateKeyPath, 'utf8');
		try {
			return crypto.createPrivateKey({
				key: encryptedPrivateKey,
				passphrase: passphrase,
				format: 'pem'
			});
		} catch (e) {
			throw new Error('Failed to decrypt private key: invalid passphrase');
		}
	}

	hasKeys() {
		const publicKeyPath = path.join(this.identityDir, PUBLIC_KEY_FILE);
		const privateKeyPath = path.join(this.identityDir, PRIVATE_KEY_FILE);
		return fs.existsSync(publicKeyPath) && fs.existsSync(privateKeyPath);
	}

	initialize(passphrase) {
		if (this.hasKeys()) {
			const publicKey = this.loadPublicKey();
			return { initialized: true, keyId: this._generateKeyId(publicKey) };
		}

		const { publicKey, privateKey } = this.generateKeyPair(passphrase);
		const result = this.saveKeyPair(publicKey, privateKey, passphrase);
		return { initialized: true, keyId: result.keyId, generated: true };
	}

	rotateKeyPair(newPassphrase) {
		const oldPublicKey = this.loadPublicKey();
		const oldKeyId = oldPublicKey ? this._generateKeyId(oldPublicKey) : null;

		const { publicKey, privateKey } = this.generateKeyPair(newPassphrase);
		const result = this.saveKeyPair(publicKey, privateKey, newPassphrase);

		return {
			oldKeyId,
			newKeyId: result.keyId,
			rotatedAt: new Date().toISOString()
		};
	}

	getPublicKeyInfo() {
		const publicKey = this.loadPublicKey();
		if (!publicKey) return null;

		return {
			lane_id: this.laneId,
			public_key_pem: publicKey,
			algorithm: this.algorithm,
			key_id: this._generateKeyId(publicKey),
			key_size: KEY_SIZE
		};
	}

	exportForTrustStore() {
		const info = this.getPublicKeyInfo();
		if (!info) return null;

		return {
			lane_id: info.lane_id,
			public_key_pem: info.public_key_pem,
			algorithm: info.algorithm,
			key_id: info.key_id,
			registered_at: new Date().toISOString(),
			expires_at: null,
			revoked_at: null
		};
	}
}

module.exports = { KeyManager, KEY_SIZE };
