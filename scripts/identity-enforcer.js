#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TRUST_STORE_SEARCH_PATHS = [
  'S:/SwarmMind/lanes/broadcast/trust-store.json',
  'S:/Archivist-Agent/lanes/broadcast/trust-store.json',
  'S:/self-organizing-library/lanes/broadcast/trust-store.json',
  'S:/kernel-lane/lanes/broadcast/trust-store.json',
];

const TRUST_STORE_PRECOMMIT_CHECKS = [
  'signature_validates_against_key_id',
  'key_id_matches_trust_store_entry',
  'lane_id_invariant'
];
const CONVERGED_STATUSES = new Set(['proven', 'approved', 'ratified', 'accept', 'accepted']);

class IdentityEnforcer {
  constructor(options = {}) {
    this.trustStore = null;
    this.trustStorePath = options.trustStorePath || this._findTrustStore();
    this.enforcementMode = options.enforcementMode || 'enforce'; // 'enforce' | 'warn' | 'audit'
    this.verificationLog = [];
    this._loadTrustStore();
  }

  _findTrustStore() {
    for (const p of TRUST_STORE_SEARCH_PATHS) {
      if (fs.existsSync(p)) return p;
    }
    return null;
  }

  _loadTrustStore() {
    if (!this.trustStorePath || !fs.existsSync(this.trustStorePath)) {
      console.error('[identity] No trust store found — identity enforcement DISABLED');
      this.trustStore = null;
      return;
    }

    try {
      const raw = fs.readFileSync(this.trustStorePath, 'utf8');
      const parsed = JSON.parse(raw);

      if (parsed.keys && typeof parsed.keys === 'object') {
        this.trustStore = parsed;
      } else {
        this.trustStore = { keys: {}, version: '1.0' };
        for (const [laneId, entry] of Object.entries(parsed)) {
          if (entry && entry.public_key_pem && entry.lane_id) {
            this.trustStore.keys[laneId] = entry;
          }
        }
      }

      const laneCount = Object.keys(this.trustStore.keys || {}).length;
      console.log(`[identity] Trust store loaded: ${laneCount} lanes from ${this.trustStorePath}`);
    } catch (e) {
      console.error('[identity] Trust store load failed:', e.message);
      this.trustStore = null;
    }
  }

  _base64UrlDecode(str) {
    let base64 = str.replace(/-/g, '+').replace(/_/g, '/');
    while (base64.length % 4) base64 += '=';
    return Buffer.from(base64, 'base64');
  }

  _parseJWS(jws) {
    const parts = jws.split('.');
    if (parts.length !== 3) return null;
    try {
      return {
        header: JSON.parse(this._base64UrlDecode(parts[0]).toString('utf8')),
        payload: JSON.parse(this._base64UrlDecode(parts[1]).toString('utf8')),
        signature: parts[2],
        signingInput: `${parts[0]}.${parts[1]}`
      };
    } catch (_) {
      return null;
    }
  }

  _getPublicKey(laneId) {
    const entry = this.trustStore?.keys?.[laneId];
    if (!entry) return null;
    if (entry.revoked_at) return null;
    return entry.public_key_pem;
  }

  verifyJWS(jws, expectedLaneId) {
    if (!this.trustStore) {
      return { valid: false, error: 'NO_TRUST_STORE', authenticated: false };
    }

    const parsed = this._parseJWS(jws);
    if (!parsed) {
      return { valid: false, error: 'JWS_PARSE_FAILED', authenticated: false };
    }

    if (parsed.header.alg !== 'RS256') {
      return { valid: false, error: 'UNSUPPORTED_ALGORITHM', authenticated: false };
    }

    if (parsed.payload.exp && parsed.payload.exp < Math.floor(Date.now() / 1000)) {
      return { valid: false, error: 'SIGNATURE_EXPIRED', authenticated: false };
    }

    if (expectedLaneId && parsed.payload.lane !== expectedLaneId) {
      return {
        valid: false,
        error: 'LANE_MISMATCH',
        note: `payload.lane=${parsed.payload.lane} expected=${expectedLaneId}`,
        authenticated: false
      };
    }

    const laneId = parsed.payload.lane || expectedLaneId;
    if (!laneId) {
      return { valid: false, error: 'NO_LANE_ID', authenticated: false };
    }

    const publicKey = this._getPublicKey(laneId);
    if (!publicKey) {
      return { valid: false, error: 'KEY_NOT_FOUND', lane: laneId, authenticated: false };
    }

    try {
      const signature = this._base64UrlDecode(parsed.signature);
      const verified = crypto.verify(
        'RSA-SHA256',
        Buffer.from(parsed.signingInput),
        { key: publicKey, format: 'pem' },
        signature
      );

      if (verified) {
        return {
          valid: true,
          authenticated: true,
          lane: laneId,
          key_id: parsed.header.kid,
          payload: parsed.payload,
          mode: 'JWS_VERIFIED'
        };
      } else {
        return { valid: false, error: 'SIGNATURE_MISMATCH', lane: laneId, authenticated: false };
      }
    } catch (e) {
      return { valid: false, error: 'VERIFICATION_ERROR', message: e.message, authenticated: false };
    }
  }

  enforceMessage(msg) {
    const result = {
      message_id: msg.id || msg._sourceFile || 'unknown',
      from: msg.from || msg.from_lane || 'unknown',
      authenticated: false,
      signature_present: false,
      decision: 'reject',
      reason: ''
    };

    if (!this.trustStore) {
      result.decision = this.enforcementMode === 'enforce' ? 'reject' : 'pass';
      result.reason = 'no_trust_store';
      result.authenticated = false;
      this._log(result);
      return result;
    }

    const fromLane = msg.from || msg.from_lane;

    if (!msg.signature && !msg.jws) {
      result.signature_present = false;
      result.decision = this.enforcementMode === 'enforce' ? 'reject' : 'pass';
      result.reason = 'unsigned_message';

      if (this.enforcementMode === 'warn') {
        console.log(`[identity] WARN: unsigned message from ${fromLane} — ${msg.id || msg._sourceFile}`);
      }

      this._log(result);
      return result;
    }

    result.signature_present = true;
    const jws = msg.signature || msg.jws;
    const verifyResult = this.verifyJWS(jws, fromLane);

    result.authenticated = verifyResult.authenticated;
    result.key_id = verifyResult.key_id;

    if (verifyResult.valid) {
      result.decision = 'accept';
      result.reason = 'identity_verified';
    } else {
      result.decision = this.enforcementMode === 'enforce' ? 'reject' : 'pass';
      result.reason = verifyResult.error;

      if (this.enforcementMode === 'warn') {
        console.log(`[identity] WARN: signature invalid from ${fromLane} — ${verifyResult.error}`);
      }
    }

    this._log(result);
    return result;
  }

  _log(result) {
    this.verificationLog.push({
      ...result,
      timestamp: new Date().toISOString()
    });

    if (this.verificationLog.length > 1000) {
      this.verificationLog = this.verificationLog.slice(-500);
    }
  }

  getStats() {
    const total = this.verificationLog.length;
    const authenticated = this.verificationLog.filter(r => r.authenticated).length;
    const unsigned = this.verificationLog.filter(r => !r.signature_present).length;
    const rejected = this.verificationLog.filter(r => r.decision === 'reject').length;

    return {
      total_verifications: total,
      authenticated,
      unsigned,
      rejected,
      trust_store_lanes: Object.keys(this.trustStore?.keys || {}).length,
      enforcement_mode: this.enforcementMode
    };
  }

  static signMessage(msg, privateKey, keyId) {
const { stableStringify } = require(path.join(
  fs.existsSync('S:/SwarmMind/src/attestation/stableStringify.js')
  ? 'S:/SwarmMind/src/attestation'
  : fs.existsSync('S:/self-organizing-library/src/attestation/stableStringify.js')
  ? 'S:/self-organizing-library/src/attestation'
  : 'S:/kernel-lane/src/attestation',
  'stableStringify.js'
));

    const header = { alg: 'RS256', typ: 'JWT', kid: keyId };
    const headerB64 = Buffer.from(JSON.stringify(header)).toString('base64')
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  const signablePayload = {
  id: msg.id || msg.task_id || 'unknown',
      lane: msg.from || msg.from_lane || msg.lane,
      from: msg.from || msg.from_lane,
      to: msg.to || msg.to_lane,
      timestamp: msg.timestamp,
      priority: msg.priority,
      type: msg.type,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor((Date.now() + 86400000) / 1000)
    };

    const payloadB64 = Buffer.from(stableStringify(signablePayload)).toString('base64')
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

    const signingInput = `${headerB64}.${payloadB64}`;
    const signature = crypto.sign('RSA-SHA256', Buffer.from(signingInput), privateKey);
    const signatureB64 = signature.toString('base64')
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

    return {
      ...msg,
      signature: `${headerB64}.${payloadB64}.${signatureB64}`,
      signature_alg: 'RS256',
      key_id: keyId
    };
  }

  static _extractConvergedApprovals(payload) {
    if (!payload || typeof payload !== 'object') return [];

    const normalized = [];
    if (Array.isArray(payload.approvals)) {
      for (const item of payload.approvals) {
        if (!item || typeof item !== 'object') continue;
        normalized.push({
          lane: item.lane || item.lane_id || item.from || item.from_lane || null,
          status: item.status || item.decision || null,
          signature: item.signature || item.jws || null
        });
      }
    }

    if (payload.lane_results && typeof payload.lane_results === 'object') {
      for (const [lane, result] of Object.entries(payload.lane_results)) {
        if (!result || typeof result !== 'object') continue;
        normalized.push({
          lane,
          status: result.status || result.decision || null,
          signature: result.signature || result.jws || null
        });
      }
    }

    if (payload.convergence && typeof payload.convergence === 'object') {
      const conv = payload.convergence;
      if (Array.isArray(conv.approvals)) {
        for (const item of conv.approvals) {
          if (!item || typeof item !== 'object') continue;
          normalized.push({
            lane: item.lane || item.lane_id || item.from || item.from_lane || null,
            status: item.status || item.decision || null,
            signature: item.signature || item.jws || null
          });
        }
      }
      if (conv.lane_results && typeof conv.lane_results === 'object') {
        for (const [lane, result] of Object.entries(conv.lane_results)) {
          if (!result || typeof result !== 'object') continue;
          normalized.push({
            lane,
            status: result.status || result.decision || null,
            signature: result.signature || result.jws || null
          });
        }
      }
    }

    const accepted = [];
    const seen = new Set();
    for (const entry of normalized) {
      const lane = typeof entry.lane === 'string' ? entry.lane.trim().toLowerCase() : '';
      const status = typeof entry.status === 'string' ? entry.status.trim().toLowerCase() : '';
      const signature = typeof entry.signature === 'string' ? entry.signature.trim() : '';
      if (!lane || !CONVERGED_STATUSES.has(status) || signature.length < 20) continue;
      if (seen.has(lane)) continue;
      seen.add(lane);
      accepted.push({ lane, status, signature });
    }
    return accepted;
  }

  static assertTrustStoreWriteAuthorized(options = {}) {
    const approvalPath = options.approvalPath || process.env.TRUST_STORE_CONVERGENCE_PATH || null;
    const approvalJson = options.approvalJson || process.env.TRUST_STORE_CONVERGENCE_JSON || null;

    if (!approvalPath && !approvalJson) {
      throw new Error('TRUST_STORE_WRITE_BLOCKED: missing convergence approval (set TRUST_STORE_CONVERGENCE_PATH or TRUST_STORE_CONVERGENCE_JSON)');
    }

    let payload;
    if (approvalJson) {
      payload = JSON.parse(approvalJson);
    } else {
      if (!fs.existsSync(approvalPath)) {
        throw new Error(`TRUST_STORE_WRITE_BLOCKED: convergence approval file not found (${approvalPath})`);
      }
      payload = JSON.parse(fs.readFileSync(approvalPath, 'utf8'));
    }

    const approvals = IdentityEnforcer._extractConvergedApprovals(payload);
    if (approvals.length < 3) {
      const lanes = approvals.map(a => a.lane).join(', ') || 'none';
      throw new Error(`TRUST_STORE_WRITE_BLOCKED: requires 3-lane convergence with signatures, got ${approvals.length} (${lanes})`);
    }
    return { ok: true, approvals };
  }

  static writeTrustStoreStrict(trustStorePath, trustStore, options = {}) {
    IdentityEnforcer.assertTrustStoreWriteAuthorized(options);
    const serialized = { ...trustStore };
    if (!Array.isArray(serialized.preCommitChecks)) {
      serialized.preCommitChecks = [...TRUST_STORE_PRECOMMIT_CHECKS];
    }
    fs.writeFileSync(trustStorePath, JSON.stringify(serialized, null, 2), 'utf8');
    return { path: trustStorePath, ok: true };
  }
}

module.exports = { IdentityEnforcer };

if (require.main === module) {
  const mode = process.argv[2] || 'audit';
  const enforcer = new IdentityEnforcer({ enforcementMode: mode });

  console.log('\n=== Identity Chain Status ===');
  console.log(`Mode: ${mode}`);
  console.log(`Trust store: ${enforcer.trustStorePath}`);

  if (enforcer.trustStore) {
    for (const [laneId, entry] of Object.entries(enforcer.trustStore.keys || {})) {
      console.log(`  ${laneId}: keyId=${entry.key_id} algorithm=${entry.algorithm} revoked=${!!entry.revoked_at}`);
    }
  } else {
    console.log('  NO TRUST STORE LOADED');
  }

  console.log('\nUsage: node identity-enforcer.js [audit|warn|enforce]');
  console.log('  audit  — log only, no rejection');
  console.log('  warn   — log + console warnings, no rejection');
  console.log('  enforce — reject unsigned/invalid messages');
}

