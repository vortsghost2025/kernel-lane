/**
 * VerifierWrapper.js - Phase 4.4 Unified Verification Entry Point
 *
 * Wraps Verifier.verifyQueueItem() and orchestrates quarantine loop.
 * Enforces: Identity checks BEFORE crypto verification.
 * Implements: Quarantine-Compare-Rewind cycle on failure.
 */

const { Verifier } = require('./Verifier');
const { QuarantineManager } = require('./QuarantineManager');
const { PhenotypeStore } = require('./PhenotypeStore');
const { VERIFY_REASON } = require('./constants');
const Outcome = require('../core/protocols/outcome');

class VerifierWrapper {
  constructor(options = {}) {
    this.verifier = options.verifier || new Verifier(options);
    this.quarantineManager = options.quarantineManager || new QuarantineManager(options);
    this.phenotypeStore = options.phenotypeStore || new PhenotypeStore(options);
    this.onQuarantineRetry = options.onQuarantineRetry || null;
  }

  async verify(item) {
    // ANCHOR ENFORCEMENT: missing_signature_mode = "REJECT"
    // No HMAC acceptance, no dual-mode bypass
    if (!item.signature) {
      return Outcome.quarantine({
        lane: item.origin_lane || item.lane || 'unknown',
        task_id: item.id || 'unknown',
        summary: 'Missing signature - rejected per anchor policy',
        reason: VERIFY_REASON.MISSING_SIGNATURE,
        evidence: [{ type: 'memory', value: `item:${item.id}` }]
      });
    }

    // Delegate to Verifier.verifyQueueItem which now implements:
    // 1. Parse JWS (without trusting)
    // 2. Extract signedPayloadLane from parsed JWS
    // 3. Require signedPayloadLane exists
    // 4. Compare signedPayloadLane to outerLane
    // 5. Fetch key for agreed lane
    // 6. Verify crypto
    const result = this.verifier.verifyQueueItem(item);

    if (!result.valid) {
      // Identity failures (MISSING_LANE, LANE_MISMATCH) should NOT go through quarantine
      // They are deterministic policy violations, not crypto failures
      const identityReasons = [VERIFY_REASON.MISSING_LANE, VERIFY_REASON.LANE_MISMATCH];
      if (identityReasons.includes(result.reason)) {
        return Outcome.quarantine({
          lane: item.origin_lane || item.lane || 'unknown',
          task_id: item.id || 'unknown',
          summary: result.note || `Identity verification failed: ${result.reason}`,
          reason: result.reason,
          evidence: [{ type: 'log', value: `verify.log#${result.reason}` }]
        });
      }
      // Crypto failures go through quarantine loop
      return this._handleFailure(item, result.reason || result.error, result.note);
    }

    // Success: update phenotype
    const laneId = result.payload?.lane || item.origin_lane || item.lane;
    if (laneId) {
      this.phenotypeStore.setLastSync(laneId, {
        lane: laneId,
        verified_at: new Date().toISOString(),
        key_id: result.header?.kid || 'unknown'
      });
    }

    // Release from quarantine if previously quarantined
    const quarantinedId = item.id || item.signature?.slice(0, 16);
    if (quarantinedId && this.quarantineManager.isQuarantined(quarantinedId)) {
      this.quarantineManager.release(quarantinedId);
    }

    // Return SUCCESS outcome
    return Outcome.success({
      lane: laneId,
      task_id: item.id || 'unknown',
      summary: 'JWS verification successful',
      confidence: 1.0,
      result: { ...result, mode: 'JWS_VERIFIED' }
    });
  }

  _handleFailure(item, reason, note) {
    const itemId = item.id || item.signature?.slice(0, 16) || `unknown-${Date.now()}`;
    const lane = item.origin_lane || item.lane || 'unknown';

    const quarantineResult = this.quarantineManager.quarantine(item, reason);

    if (quarantineResult.handoffRequired) {
      return Outcome.quarantine({
        lane,
        task_id: itemId,
        summary: note || 'Max retries exceeded, handoff required',
        reason: VERIFY_REASON.QUARANTINE_MAX_RETRIES,
        quarantine_id: quarantineResult.quarantineId,
        evidence: [
          { type: 'log', value: `quarantine.log#${quarantineResult.quarantineId}` }
        ]
      });
    }

    if (this.onQuarantineRetry) {
      this.quarantineManager.scheduleRetry(itemId, async (quarantinedItem) => {
        await this.onQuarantineRetry(quarantinedItem, quarantineResult.retryCount);
      });
    }

    // DEFER outcome for retry
    return Outcome.defer({
      lane,
      task_id: itemId,
      summary: note || 'Quarantined for retry',
      confidence: 0.0,
      reason: VERIFY_REASON.QUARANTINED,
      requires: [{ kind: 'verification_needed', detail: reason }]
    });
  }

  async compareAndSync(laneId, currentState) {
    const comparison = this.phenotypeStore.compareWithLast(laneId, currentState);
    
    if (!comparison.match) {
      console.log(`[VerifierWrapper] Phenotype drift detected for ${laneId}: ${comparison.reason}`);
      return {
        needsSync: true,
        lastHash: comparison.last_hash,
        currentHash: comparison.current_hash,
        lastSync: comparison.last_sync
      };
    }

    return { needsSync: false, hash: comparison.currentHash };
  }

  forceRelease(itemId) {
    const entry = this.quarantineManager.getQuarantineStatus(itemId);
    if (!entry) {
      return { success: false, reason: 'NOT_IN_QUARANTINE' };
    }

    this.quarantineManager.clearHandoffSignal();
    return this.quarantineManager.release(itemId);
  }

  getMetrics() {
    return {
      quarantine: this.quarantineManager.getMetrics(),
      phenotypes: this.phenotypeStore.getAllPhenotypes()
    };
  }
}

module.exports = { VerifierWrapper };
