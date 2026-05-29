/**
* Verifier.js - JWS Verification
*
* Verifies JSON Web Signatures against public keys from trust store.
* HMAC mode removed per anchor policy (hmac_accepted: false).
*/

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { ALG_MAP, VERIFY_REASON, TRUST_STORE_VERSION, TRUST_STORE_PATH } = require('./constants');
const { stableStringify } = require('./stableStringify');

class Verifier {
  constructor(options = {}) {
    this.trustStorePath = options.trustStorePath || this._defaultTrustStorePath();
    this.trustStore = null;
    this._loadTrustStore();
  }

  _defaultTrustStorePath() {
    const envPath = process.env.TRUST_STORE_PATH;
    if (envPath) return envPath;
    return TRUST_STORE_PATH;
  }

	_loadTrustStore() {
		if (!fs.existsSync(this.trustStorePath)) {
			this.trustStore = { keys: {}, migration: {} };
			return;
		}
		try {
			const raw = fs.readFileSync(this.trustStorePath, 'utf8');
			this.trustStore = JSON.parse(raw);
			
			// Schema version check
			if (this.trustStore.version && this.trustStore.version !== TRUST_STORE_VERSION) {
				console.warn(`[Verifier] Trust store version mismatch: expected ${TRUST_STORE_VERSION}, got ${this.trustStore.version}`);
			}
			
			// Ensure keys map exists
			if (!this.trustStore.keys) {
				console.warn('[Verifier] Trust store missing keys map, initializing empty');
				this.trustStore.keys = {};
			}
		} catch (e) {
			this.trustStore = { keys: {}, migration: {} };
		}
	}

	reloadTrustStore() {
		this._loadTrustStore();
	}

	_base64UrlDecode(str) {
		let base64 = str.replace(/-/g, '+').replace(/_/g, '/');
		while (base64.length % 4) {
			base64 += '=';
		}
		return Buffer.from(base64, 'base64');
	}

	_parseJWS(jws) {
		const parts = jws.split('.');
		if (parts.length !== 3) {
			return null;
		}
		return {
			header: JSON.parse(this._base64UrlDecode(parts[0]).toString('utf8')),
			payload: JSON.parse(this._base64UrlDecode(parts[1]).toString('utf8')),
			signature: parts[2],
			signingInput: `${parts[0]}.${parts[1]}`
		};
	}

	getPublicKey(laneId) {
		// Support both flat and nested trust store formats
		let keyEntry = this.trustStore.keys?.[laneId] || this.trustStore[laneId];
		if (!keyEntry) return null;
		if (keyEntry.revoked_at) return null;
		return keyEntry.public_key_pem;
	}

	verify(jws, publicKey) {
		try {
			const parsed = this._parseJWS(jws);
			if (!parsed) return { valid: false, error: 'INVALID_JWS_FORMAT' };

			if (parsed.header.alg !== 'RS256' && parsed.header.alg !== 'EdDSA') {
				return { valid: false, error: 'UNSUPPORTED_ALGORITHM' };
			}

			if (parsed.payload.exp && parsed.payload.exp < Math.floor(Date.now() / 1000)) {
				return { valid: false, error: 'SIGNATURE_EXPIRED' };
			}

			const signature = this._base64UrlDecode(parsed.signature);
			const verifyAlg = parsed.header.alg === 'EdDSA' ? null : 'RSA-SHA256';
			const verified = crypto.verify(
				verifyAlg,
				Buffer.from(parsed.signingInput),
				{ key: publicKey, format: 'pem' },
				signature
			);

			if (!verified) {
				return { valid: false, error: 'SIGNATURE_INVALID' };
			}

			return { valid: true, payload: parsed.payload, header: parsed.header };
		} catch (e) {
			return { valid: false, error: e.message };
		}
	}

	verifyAgainstTrustStore(jws, laneId) {
		const publicKey = this.getPublicKey(laneId);
		if (!publicKey) {
			return { valid: false, error: 'LANE_NOT_IN_TRUST_STORE' };
		}

		return this.verify(jws, publicKey);
	}

  verifyQueueItem(item) {
    // ANCHOR ENFORCEMENT: missing_signature_mode = "REJECT"
    // No HMAC acceptance regardless of cutoff date
    if (!item.signature) {
      return { valid: false, reason: VERIFY_REASON.MISSING_SIGNATURE, error: 'SIGNATURE_REQUIRED' };
    }

    // Step 1: Parse JWS WITHOUT trusting it yet
    const parsed = this._parseJWS(item.signature);
    if (!parsed) {
      return { valid: false, reason: VERIFY_REASON.MISSING_SIGNATURE, error: 'INVALID_JWS_FORMAT' };
    }

    // Step 2: Extract signedPayloadLane from parsed JWS
    const signedPayloadLane = parsed.payload?.lane;

    // Step 3: Require signed lane exists
    if (!signedPayloadLane) {
      return { valid: false, reason: VERIFY_REASON.MISSING_LANE, error: 'Signed payload missing lane field' };
    }

    // Step 4: Get outer lane from envelope
    const outerLane = item.origin_lane || item.lane;

    // Step 5: Compare signed lane to outer lane (Invariant: A = B)
    if (outerLane !== signedPayloadLane) {
      return {
        valid: false,
        reason: VERIFY_REASON.LANE_MISMATCH,
        note: `Outer lane (${outerLane}) differs from signed payload lane (${signedPayloadLane})`
      };
    }

    // Step 6: Only NOW fetch key for the agreed lane (Invariant: A = B = C)
    const laneId = signedPayloadLane;
    const publicKey = this.getPublicKey(laneId);
    if (!publicKey) {
      return { valid: false, reason: VERIFY_REASON.KEY_NOT_FOUND, error: 'LANE_NOT_IN_TRUST_STORE' };
    }

    // Step 7: Verify crypto signature
    const result = this.verify(item.signature, publicKey);

    if (!result.valid) {
      return { ...result, reason: VERIFY_REASON.SIGNATURE_MISMATCH };
    }

    return { ...result, mode: 'JWS_VERIFIED' };
  }

  verifyAuditEvent(event) {
    if (!event.signature) {
      // ANCHOR ENFORCEMENT: All events require signature
      // Legacy unsigned events no longer accepted
      return { valid: false, error: 'UNSIGNED_AUDIT_EVENT_REJECTED' };
    }

    const laneId = event.lane;
    return this.verifyAgainstTrustStore(event.signature, laneId);
  }

  // HMAC-related methods removed per anchor policy (hmac_accepted: false)
  // isHMACAccepted() and getMigrationStatus() removed to eliminate
  // contradictory bypass surfaces

  getTrustStoreStats() {
		const lanes = Object.keys(this.trustStore.keys || {});
		const registered = lanes.filter(l => this.trustStore.keys[l]?.public_key_pem?.startsWith('-----BEGIN'));
		const pending = lanes.filter(l => this.trustStore.keys[l]?.public_key_pem === 'PENDING_GENERATION');
		const revoked = lanes.filter(l => this.trustStore.keys[l]?.revoked_at);

		return {
			total_lanes: lanes.length,
			registered: registered.length,
			pending: pending.length,
			revoked: revoked.length,
			registered_lanes: registered,
			pending_lanes: pending
		};
	}
}

module.exports = { Verifier };
