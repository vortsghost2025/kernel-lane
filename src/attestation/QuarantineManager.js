/**
 * QuarantineManager.js - Phase 4.4 Quarantine-Compare-Rewind Loop
 *
 * Isolates suspicious items, logs events, enforces retry limits,
 * and signals human operator when intervention is needed.
 */

const fs = require('fs');
const path = require('path');
const { 
  QUARANTINE_MAX_RETRIES, 
  QUARANTINE_BACKOFF_MS, 
  QUARANTINE_LOG_PATH,
  HANDOFF_SIGNAL_FILE,
  VERIFY_REASON 
} = require('./constants');

class QuarantineManager {
  constructor(options = {}) {
    this.maxRetries = options.maxRetries || QUARANTINE_MAX_RETRIES;
    this.backoffMs = options.backoffMs || QUARANTINE_BACKOFF_MS;
    this.logPath = options.logPath || QUARANTINE_LOG_PATH;
    this.handoffFile = options.handoffFile || HANDOFF_SIGNAL_FILE;
    this.quarantinedItems = new Map();
    this.metrics = {
      total: 0,
      byLane: {},
      maxExceeded: 0
    };
    this._ensureLogPath();
  }

  _ensureLogPath() {
    const dir = path.dirname(this.logPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  _logEvent(event) {
    const entry = {
      timestamp: new Date().toISOString(),
      ...event
    };
    const line = JSON.stringify(entry) + '\n';
    try {
      fs.appendFileSync(this.logPath, line);
    } catch (e) {
      console.error('[QuarantineManager] Failed to log:', e.message);
    }
  }

  _emitMetric(type, lane) {
    if (!this.metrics.byLane[lane]) {
      this.metrics.byLane[lane] = { quarantined: 0, released: 0, failed: 0 };
    }
    switch (type) {
      case 'quarantine':
        this.metrics.total++;
        this.metrics.byLane[lane].quarantined++;
        break;
      case 'release':
        this.metrics.byLane[lane].released++;
        break;
      case 'max_exceeded':
        this.metrics.maxExceeded++;
        this.metrics.byLane[lane].failed++;
        break;
    }
  }

  quarantine(item, reason) {
    const itemId = item.id || item.signature?.slice(0, 16) || `unknown-${Date.now()}`;
    const lane = item.origin_lane || item.lane || 'unknown';

    const existing = this.quarantinedItems.get(itemId);
    if (existing) {
      existing.retryCount++;
    } else {
      this.quarantinedItems.set(itemId, {
        item,
        reason,
        lane,
        retryCount: 1,
        firstQuarantined: new Date().toISOString(),
        lastRetry: null
      });
    }

    const entry = this.quarantinedItems.get(itemId);

    this._logEvent({
      event: 'QUARANTINE',
      item_id: itemId,
      lane,
      reason,
      retry_count: entry.retryCount
    });

    this._emitMetric('quarantine', lane);

    // POLICY: 1-3 retries allowed, 4+ triggers handoff
  // MAX_RETRIES = 3 means: retryCount 1,2,3 → continue; retryCount 4 → handoff
  if (entry.retryCount > this.maxRetries) {
      this._emitMetric('max_exceeded', lane);
      this._signalHumanIntervention(itemId, lane, reason, entry.retryCount);
      return {
        status: 'MAX_RETRIES_EXCEEDED',
        itemId,
        lane,
        retryCount: entry.retryCount,
        handoffRequired: true
      };
    }

    return {
      status: 'QUARANTINED',
      itemId,
      lane,
      retryCount: entry.retryCount,
      nextRetryIn: this.backoffMs * entry.retryCount,
      reason
    };
  }

  _signalHumanIntervention(itemId, lane, reason, retryCount) {
    this._logEvent({
      event: 'HANDOFF_SIGNAL',
      item_id: itemId,
      lane,
      reason,
      retry_count: retryCount,
      message: 'Agent intervention required'
    });

    const signalContent = `# AGENT HANDOFF REQUIRED

**Status:** Quarantine max retries exceeded
**Item ID:** ${itemId}
**Lane:** ${lane}
**Reason:** ${reason}
**Retry Count:** ${retryCount}
**Timestamp:** ${new Date().toISOString()}

## Action Required
Review the quarantined item and decide:
1. Release with manual approval
2. Permanently reject
3. Force phenotype sync

## Logs
See: ${this.logPath}
`;

    try {
      fs.writeFileSync(this.handoffFile, signalContent);
    } catch (e) {
      console.error('[QuarantineManager] Failed to write handoff signal:', e.message);
    }
  }

  isQuarantined(itemId) {
    return this.quarantinedItems.has(itemId);
  }

  getQuarantineStatus(itemId) {
    return this.quarantinedItems.get(itemId) || null;
  }

  release(itemId) {
    const entry = this.quarantinedItems.get(itemId);
    if (!entry) {
      return { success: false, reason: 'NOT_IN_QUARANTINE' };
    }

    this._logEvent({
      event: 'RELEASE',
      item_id: itemId,
      lane: entry.lane,
      original_reason: entry.reason,
      total_retries: entry.retryCount
    });

    this._emitMetric('release', entry.lane);
    this.quarantinedItems.delete(itemId);

    return { success: true, reason: VERIFY_REASON.QUARANTINE_RELEASED };
  }

  reject(itemId) {
    const entry = this.quarantinedItems.get(itemId);
    if (!entry) {
      return { success: false, reason: 'NOT_IN_QUARANTINE' };
    }

    this._logEvent({
      event: 'REJECT',
      item_id: itemId,
      lane: entry.lane,
      original_reason: entry.reason,
      total_retries: entry.retryCount
    });

    this.quarantinedItems.delete(itemId);
    return { success: true };
  }

  clearHandoffSignal() {
    if (fs.existsSync(this.handoffFile)) {
      fs.unlinkSync(this.handoffFile);
    }
  }

  getMetrics() {
    return {
      ...this.metrics,
      currentlyQuarantined: this.quarantinedItems.size,
      quarantinedItems: Array.from(this.quarantinedItems.entries()).map(([id, entry]) => ({
        itemId: id,
        lane: entry.lane,
        retryCount: entry.retryCount,
        reason: entry.reason,
        firstQuarantined: entry.firstQuarantined
      }))
    };
  }

  scheduleRetry(itemId, callback) {
    const entry = this.quarantinedItems.get(itemId);
    if (!entry) {
      return false;
    }

    entry.lastRetry = new Date().toISOString();
    const delay = this.backoffMs * entry.retryCount;

    setTimeout(() => {
      if (this.quarantinedItems.has(itemId)) {
        callback(entry.item);
      }
    }, delay);

    return true;
  }
}

module.exports = { QuarantineManager };
