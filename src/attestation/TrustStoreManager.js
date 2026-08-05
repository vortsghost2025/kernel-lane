/**
 * TrustStoreManager.js - Phase 4.3 Trust Store Management
 *
 * Manages public key registration, revocation, and verification
 * for the Archivist governance-root lane.
 */

const fs = require('fs');
const path = require('path');

class TrustStoreManager {
	constructor(options = {}) {
		this.trustStorePath = options.trustStorePath || path.join('S:', 'Archivist-Agent', 'lanes', 'broadcast', 'trust-store.json');
		this.trustStore = null;
		this._load();
	}

	_load() {
		if (!fs.existsSync(this.trustStorePath)) {
			throw new Error(`Trust store not found: ${this.trustStorePath}`);
		}
		const raw = fs.readFileSync(this.trustStorePath, 'utf8');
		this.trustStore = JSON.parse(raw);
	}

	_save() {
		this.trustStore.updated_at = new Date().toISOString();
		fs.writeFileSync(this.trustStorePath, JSON.stringify(this.trustStore, null, 2), 'utf8');
	}

	registerKey(laneId, publicKeyPem, keyId) {
		if (!this.trustStore[laneId]) {
			throw new Error(`Unknown lane: ${laneId}`);
		}

		const existing = this.trustStore[laneId];
		if (existing.revoked_at) {
			throw new Error(`Lane ${laneId} is revoked`);
		}

		this.trustStore[laneId] = {
			...existing,
			public_key_pem: publicKeyPem,
			key_id: keyId,
			registered_at: new Date().toISOString(),
			revoked_at: null
		};

		this._save();
		return this.trustStore[laneId];
	}

	revokeKey(laneId, reason) {
		if (!this.trustStore[laneId]) {
			throw new Error(`Unknown lane: ${laneId}`);
		}

		this.trustStore[laneId].revoked_at = new Date().toISOString();
		this.trustStore[laneId].revocation_reason = reason || 'Key compromised';

		this._save();
		return this.trustStore[laneId];
	}

	getKey(laneId) {
		return this.trustStore[laneId];
	}

	getAllKeys() {
		const { preCommitChecks, ...keys } = this.trustStore;
		return keys;
	}

	getActiveKeys() {
		const active = {};
		for (const [laneId, key] of Object.entries(this.trustStore)) {
			if (laneId !== 'preCommitChecks' && !key.revoked_at && key.public_key_pem?.startsWith('-----BEGIN')) {
				active[laneId] = key;
			}
		}
		return active;
	}

	processApprovalQueueItem(item) {
		if (item.type !== 'key_registration') {
			return { processed: false, reason: 'Not a key registration' };
		}

		const { lane_id, public_key_pem, key_id } = item.payload;
		if (!lane_id || !public_key_pem || !key_id) {
			return { processed: false, reason: 'Missing required fields' };
		}

		try {
			this.registerKey(lane_id, public_key_pem, key_id);
			return { processed: true, lane_id, key_id };
		} catch (e) {
			return { processed: false, reason: e.message };
		}
	}

	getStats() {
		const lanes = Object.keys(this.trustStore.keys);
		const registered = lanes.filter(l => this.trustStore.keys[l]?.public_key_pem?.startsWith('-----BEGIN'));
		const pending = lanes.filter(l => this.trustStore.keys[l]?.public_key_pem === 'PENDING_GENERATION');
		const revoked = lanes.filter(l => this.trustStore.keys[l]?.revoked_at);

		return {
			total_lanes: lanes.length,
			registered: registered.length,
			pending: pending.length,
			revoked: revoked.length,
			migration: this.trustStore.migration,
			retention: this.trustStore.retention
		};
	}
}

module.exports = { TrustStoreManager };
