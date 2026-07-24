/**
 * PhenotypeStore.js - Phase 4.4 Lane Phenotype Persistence
 *
 * Stores "last known synchronized phenotype" for each lane.
 * Enables drift detection and rollback during quarantine loop.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { TRUST_STORE_PATH, TRUST_STORE_VERSION } = require('./constants');

class PhenotypeStore {
  constructor(options = {}) {
    this.trustStorePath = options.trustStorePath || TRUST_STORE_PATH;
    this.phenotypes = null;
    this._load();
  }

  _load() {
    if (!fs.existsSync(this.trustStorePath)) {
      this.phenotypes = {};
      return;
    }
    try {
      const raw = fs.readFileSync(this.trustStorePath, 'utf8');
      const data = JSON.parse(raw);
      this.phenotypes = data.phenotypes || {};
    } catch (e) {
      this.phenotypes = {};
    }
  }

  _save() {
    if (!fs.existsSync(this.trustStorePath)) {
      return;
    }
    try {
      const raw = fs.readFileSync(this.trustStorePath, 'utf8');
      const data = JSON.parse(raw);
      data.phenotypes = this.phenotypes;
      fs.writeFileSync(this.trustStorePath, JSON.stringify(data, null, 2));
    } catch (e) {
      console.error('[PhenotypeStore] Failed to save:', e.message);
    }
  }

  computeHash(state) {
    const normalized = JSON.stringify(state, Object.keys(state).sort());
    return 'sha256:' + crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 16);
  }

  getLastSync(laneId) {
    return this.phenotypes[laneId] || null;
  }

  setLastSync(laneId, state) {
    const hash = this.computeHash(state);
    this.phenotypes[laneId] = {
      hash,
      last_sync: new Date().toISOString(),
      state_summary: typeof state === 'object' ? Object.keys(state).join(',') : String(state).slice(0, 50)
    };
    this._save();
    return hash;
  }

  compareWithLast(laneId, currentState) {
    const last = this.getLastSync(laneId);
    if (!last) {
      return { match: false, reason: 'NO_PREVIOUS_PHENOTYPE' };
    }
    const currentHash = this.computeHash(currentState);
    return {
      match: last.hash === currentHash,
      last_hash: last.hash,
      current_hash: currentHash,
      last_sync: last.last_sync
    };
  }

  async syncFromAuthority(laneId, authorityClient) {
    const authoritative = await authorityClient.fetchPhenotype(laneId);
    if (authoritative) {
      this.setLastSync(laneId, authoritative);
      return { success: true, hash: this.phenotypes[laneId].hash };
    }
    return { success: false, reason: 'AUTHORITY_UNREACHABLE' };
  }

  getAllPhenotypes() {
    return { ...this.phenotypes };
  }

  clearPhenotype(laneId) {
    delete this.phenotypes[laneId];
    this._save();
  }
}

module.exports = { PhenotypeStore };
