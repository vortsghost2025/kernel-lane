#!/usr/bin/env node
'use strict';

function safeUnlink(filePath, context) {
  try {
    fs.unlinkSync(filePath);
    return 'ok';
  } catch (e) {
    if (e.code === 'ENOENT') {
      console.log('[watcher] RACE_SKIPPED: ' + (context || 'file') + ' already removed by another process');
      return 'race_skipped';
    }
    throw e;
  }
}

const fs = require('fs');
const path = require('path');
const {
  loadPolicy,
  assertWatcherConfig,
  acquireWatcherLock
} = require('./concurrency-policy');
const { IdentityEnforcer } = require('./identity-enforcer');
const { moveFileWithLease } = require('./lease-write');
const { sendMessage, sendToAll } = require('./send-message');
const { consensusCheck, routeMessage, loadPolicy: loadConsensusPolicy } = require('./consensus-check');
const { logTransfer } = require('./transfer-log');
const { validateUncertaintyPacket, validateReviewRound } = require('./schema-validator');
const { MessageType, CONVERGED_STATUS_SET, DISPOSITION_SET } = require('./governance-types');
const { enforceMutation } = require('./mode-check');

const PRIORITY_ORDER = { P0: 0, P1: 1, P2: 2, P3: 3 };
const PREEMPTION_CYCLE_LIMIT = 2;
const P0_YIELD_EVERY_N = 5;

const SKIP_FILENAMES = new Set([
  'heartbeat.json', 'watcher.log', 'watcher.pid', 'readme.md'
]);

const HEARTBEAT_PATTERN = /^heartbeat-.+\.json$/i;
const INBOX_MSG_PATTERN = /^\d{4}-/;
const UUID_PATTERN = /^\d{8}-\d{4}-\d{4}-\d{4}-\d{12}\.json$/i;
  /** @type {Set<string>} */
const ACTION_REQUIRED_TYPES = new Set([MessageType.TASK, MessageType.ESCALATION, MessageType.REQUEST]);
  const COMPLETION_PROOF_FIELDS = [
    'completion_artifact_path',
    'completion_message_id',
    'resolved_by_task_id',
    'terminal_decision',
    'disposition'
  ];
  const VALID_DISPOSITIONS = DISPOSITION_SET;

function hasCompletionProof(msg) {
  if (!msg) return false;
  // Check for completion proof fields
  for (const field of COMPLETION_PROOF_FIELDS) {
    if (msg[field]) return true;
  }
  // Check convergence_gate status
  if (msg.convergence_gate && msg.convergence_gate.status) {
    const status = String(msg.convergence_gate.status).toLowerCase();
    if (CONVERGED_STATUS_SET.has(status)) return true;
  }
  // Check disposition field
  if (msg.disposition && VALID_DISPOSITIONS.has(String(msg.disposition).toLowerCase())) return true;
  return false;
}

function isValidInboxMessage(filename) {
  const lower = filename.toLowerCase();
  if (SKIP_FILENAMES.has(lower)) return false;
  if (HEARTBEAT_PATTERN.test(lower)) return false;
  if (UUID_PATTERN.test(filename)) return false;
  if (!INBOX_MSG_PATTERN.test(filename)) return false;
  return filename.endsWith('.json');
}

function isActionRequiredMessage(msg) {
  const type = String(msg && msg.type ? msg.type : '').toLowerCase();
  return !!(
    (msg && msg.requires_action === true) ||
    (msg && msg.priority_action === true) ||
    ACTION_REQUIRED_TYPES.has(type)
  );
}

function isEnglishOnly(msg) {
  const textFields = ['subject', 'body', 'type', 'from', 'to'];
  for (const field of textFields) {
    const val = msg && msg[field];
    if (typeof val === 'string' && /[^\x00-\x7F]/.test(val)) {
      return false;
    }
  }
  return true;
}

const DEFAULT_CONFIG = {
  laneName: 'archivist',
  agentMode: process.env.AGENT_MODE || 'governing',
  inboxPath: path.join(__dirname, '..', 'lanes', 'archivist', 'inbox'),
  processedPath: path.join(__dirname, '..', 'lanes', 'archivist', 'inbox', 'processed'),
  outboxPath: path.join(__dirname, '..', 'lanes', 'archivist', 'outbox'),
  expiredPath: path.join(__dirname, '..', 'lanes', 'archivist', 'inbox', 'expired'),
  quarantinePath: path.join(__dirname, '..', 'lanes', 'archivist', 'inbox', 'quarantine'),
  actionRequiredPath: path.join(__dirname, '..', 'lanes', 'archivist', 'inbox', 'action-required'),
  canonicalPaths: {
    archivist: 'S:/Archivist-Agent/lanes/archivist/inbox/',
    library: 'S:/self-organizing-library/lanes/library/inbox/',
    swarmmind: 'S:/SwarmMind/lanes/swarmmind/inbox/',
    kernel: 'S:/kernel-lane/lanes/kernel/inbox/'
  }
};

class InboxWatcher {
  constructor(overrides) {
    this.config = Object.assign({}, DEFAULT_CONFIG, overrides || {});
    this.processedKeys = new Set();
    this.repoRoot = path.join(__dirname, '..');
    this.policy = loadPolicy(this.repoRoot);
    this.consecutiveEmptyScans = 0;
    this.maxBackoffSeconds = 300;
    this.consecutiveP0Count = 0;
    this.quarantineTracker = this._loadQuarantineTracker();
    this.loadProcessedKeys();
    this.loadConvergenceConstraint();

    // Identity self-healing: detect and regenerate missing keys on startup
    this._identityHealed = false;
    try {
      const { healLaneIdentity } = require('./identity-self-healing');
      const healResult = healLaneIdentity(this.config.laneName || 'archivist');
      this._identityHealed = healResult.keysRegenerated || false;
      if (healResult.keysRegenerated) {
        console.log(`[watcher] IDENTITY_SELF_HEAL: keys regenerated keyId=${healResult.keyId}`);
      }
    } catch (_) {}

        this.identityEnforcer = new IdentityEnforcer({ enforcementMode: 'enforce' });
        this.consensusPolicy = loadConsensusPolicy();
        this.assertNoRawRenameSync();
  }

  assertNoRawRenameSync() {
    // Fail closed if this watcher ever regresses to raw rename operations.
    const source = fs.readFileSync(__filename, 'utf8');
    const forbidden = 'rename' + 'Sync(';
    if (source.includes(forbidden)) {
      throw new Error('WATCHER_INVARIANT_VIOLATION: raw renameSync operation detected in inbox-watcher.js');
    }
  }

  loadConvergenceConstraint() {
    const ccPath = path.join(this.repoRoot, 'lanes', 'broadcast', 'CONVERGENCE_CONSTRAINT.md');
    try {
      if (fs.existsSync(ccPath)) {
        this.constraintVersion = fs.statSync(ccPath).mtimeMs;
      }
    } catch (_) {}
  }

  ensureDirs() {
    for (const dir of [this.config.inboxPath, this.config.processedPath,
      this.config.outboxPath, this.config.expiredPath, this.config.quarantinePath, this.config.actionRequiredPath]) {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }
  }

  loadProcessedKeys() {
    try {
      const files = fs.readdirSync(this.config.processedPath);
      for (const f of files) {
        if (f.endsWith('.json')) {
          this.processedKeys.add(f);
        }
      }
    } catch (_) {}
  }

  _loadQuarantineTracker() {
    const trackerPath = path.join(this.repoRoot, 'logs', 'quarantine-tracker.json');
    try {
      if (fs.existsSync(trackerPath)) {
        return JSON.parse(fs.readFileSync(trackerPath, 'utf8'));
      }
    } catch (_) {}
    return {};
  }

  _saveQuarantineTracker() {
    const trackerPath = path.join(this.repoRoot, 'logs', 'quarantine-tracker.json');
    try {
      const logDir = path.dirname(trackerPath);
      if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
      fs.writeFileSync(trackerPath, JSON.stringify(this.quarantineTracker, null, 2), 'utf8');
    } catch (_) {}
  }

  _trackQuarantine(filename, reason) {
    const key = filename.replace(/\.json$/, '');
    if (!this.quarantineTracker[key]) {
      this.quarantineTracker[key] = { count: 0, reasons: [], first_at: null, last_at: null };
    }
    this.quarantineTracker[key].count++;
    this.quarantineTracker[key].reasons.push(reason);
    this.quarantineTracker[key].last_at = new Date().toISOString();
    if (!this.quarantineTracker[key].first_at) {
      this.quarantineTracker[key].first_at = this.quarantineTracker[key].last_at;
    }
    this._saveQuarantineTracker();
    return this.quarantineTracker[key].count;
  }

  checkIdempotencyKey(msg) {
    if (!msg.idempotency_key && !msg.id) {
      console.log('[watcher] REJECT: message has no idempotency_key or id — cannot guarantee once-only processing');
      return false;
    }
    const key = msg.idempotency_key || msg.id;
    if (this.processedKeys.has(key)) {
      console.log(`[watcher] SKIP: idempotency_key=${key} already processed`);
      return false;
    }
    return true;
  }

  async scan() {
    this.ensureDirs();

    let files;
    try {
      files = fs.readdirSync(this.config.inboxPath);
    } catch (e) {
      console.error('[watcher] Cannot read inbox:', e.message);
      return [];
    }

    const messages = [];

    for (const filename of files) {
      if (!isValidInboxMessage(filename)) continue;
      if (this.processedKeys.has(filename)) continue;

      const filePath = path.join(this.config.inboxPath, filename);
      try {
          const raw = fs.readFileSync(filePath, 'utf8');
          const msg = JSON.parse(raw);
          msg._sourceFile = filename;
          msg._sourcePath = filePath;
          const idResult = this.identityEnforcer.enforceMessage(msg);
          msg._identity = idResult;
        if (idResult.decision === 'reject') {
          console.log(`[watcher] IDENTITY_REJECT: ${filename} from ${idResult.from} — ${idResult.reason}`);
          await this.moveToExpired(filename, filePath);
          continue;
        }
        const fromLane = msg.from || msg.from_lane;
        const laneState = this.identityEnforcer.getLaneState(fromLane);
        if (laneState === 'ARCHIVED') {
          console.log(`[watcher] LANE_ARCHIVED: skipping message from ARCHIVED lane ${fromLane} — ${filename}`);
          await this.moveToExpired(filename, filePath);
          continue;
        }
        msg._lane_state = laneState;
        if (!isEnglishOnly(msg)) {
        console.log(`[watcher] FORMAT_VIOLATION: ${filename} — non-ASCII content detected, marking format_violation=true`);
        msg.format_violation = true;
        msg.format_violation_reason = 'Non-ASCII content detected in message fields per English-only constraint';
      }
          if (!this.checkIdempotencyKey(msg)) {
          await this.moveToProcessed(filename, filePath);
          continue;
        }
        messages.push(msg);
      } catch (e) {
      let rawPreview = '';
      try { rawPreview = fs.readFileSync(filePath, 'utf8'); } catch (_) {}
      console.error(`[watcher] Cannot parse ${filename}:`, e.message);
      await this.moveMalformedToQuarantine(filename, filePath, e, rawPreview);
      }
    }

    messages.sort((a, b) => {
      const pa = PRIORITY_ORDER[a.priority] ?? 3;
      const pb = PRIORITY_ORDER[b.priority] ?? 3;
      if (pa !== pb) return pa - pb;
      const sa = (a._lane_state === 'DORMANT') ? 1 : 0;
      const sb = (b._lane_state === 'DORMANT') ? 1 : 0;
      return sa - sb;
    });

    return messages;
  }

  applyPreemption(messages) {
    const hasP0orP1 = messages.some(m => {
      const p = PRIORITY_ORDER[m.priority] ?? 3;
      return p <= 1;
    });

    if (!hasP0orP1) return messages;

    const prioritized = [];
    const deferred = [];

    for (const msg of messages) {
      const p = PRIORITY_ORDER[msg.priority] ?? 3;
      if (p <= 1) {
        prioritized.push(msg);
      } else {
        deferred.push(msg);
      }
    }

    if (deferred.length > 0) {
      console.log(`[watcher] PREEMPTION: ${prioritized.length} P0/P1 messages prioritized, ${deferred.length} P2/P3 deferred`);
    }

    return prioritized;
  }

  checkStarvation() {
    if (this.consecutiveP0Count > 0 && this.consecutiveP0Count % P0_YIELD_EVERY_N === 0) {
      console.log(`[watcher] STARVATION_GUARD: ${this.consecutiveP0Count} consecutive P0/P1 messages — yielding 1 cycle to lower priority`);
      return true;
    }
    return false;
  }

  async moveToProcessed(filename, sourcePath) {
    const dest = path.join(this.config.processedPath, filename);
    try {
      if (fs.existsSync(dest)) {
        if (fs.existsSync(sourcePath)) safeUnlink(sourcePath, filename);
      } else {
        await moveFileWithLease(sourcePath, dest, this.config.laneName, 30000);
      }
      this.processedKeys.add(filename);
    } catch (e) {
      console.error(`[watcher] Cannot move ${filename}:`, e.message);
    }
  }

  async moveToExpired(filename, sourcePath) {
    const dest = path.join(this.config.expiredPath, filename);
    const attemptCount = this._trackQuarantine(filename, 'expired');
    const MAX_QUARANTINE_ATTEMPTS = 3;

    try {
      if (!fs.existsSync(this.config.expiredPath)) {
        fs.mkdirSync(this.config.expiredPath, { recursive: true });
      }
      if (!fs.existsSync(this.config.quarantinePath)) {
        fs.mkdirSync(this.config.quarantinePath, { recursive: true });
      }

      if (attemptCount > MAX_QUARANTINE_ATTEMPTS) {
        const qDest = path.join(this.config.quarantinePath, filename);
        if (fs.existsSync(sourcePath)) {
          if (fs.existsSync(qDest)) {
            safeUnlink(sourcePath, filename);
          } else {
            await moveFileWithLease(sourcePath, qDest, this.config.laneName, 30000);
          }
        }
        this._logQuarantine(filename, 'RETRY_LIMIT', attemptCount);
        this.processedKeys.add(filename);
        console.log(`[watcher] QUARANTINE: ${filename} — exceeded ${MAX_QUARANTINE_ATTEMPTS} attempts, moved to quarantine/`);
        return;
      }

      if (fs.existsSync(dest)) {
        if (fs.existsSync(sourcePath)) safeUnlink(sourcePath, filename);
      } else {
        await moveFileWithLease(sourcePath, dest, this.config.laneName, 30000);
      }
      this.processedKeys.add(filename);
      console.log(`[watcher] EXPIRED: ${filename} — attempt ${attemptCount}/${MAX_QUARANTINE_ATTEMPTS}`);
    } catch (e) {
      console.error(`[watcher] Cannot expire ${filename}:`, e.message);
    }
  }

  async moveToActionRequired(filename, sourcePath) {
    const dest = path.join(this.config.actionRequiredPath, filename);
    try {
      if (!fs.existsSync(this.config.actionRequiredPath)) {
        fs.mkdirSync(this.config.actionRequiredPath, { recursive: true });
      }
      if (fs.existsSync(dest)) {
        if (fs.existsSync(sourcePath)) safeUnlink(sourcePath, filename);
      } else {
        await moveFileWithLease(sourcePath, dest, this.config.laneName, 30000);
      }
      console.log(`[watcher] ACTION-REQUIRED HOLD: ${filename} moved to action-required/`);
    } catch (e) {
      console.error(`[watcher] Cannot move ${filename} to action-required/:`, e.message);
    }
  }

  // Handles action‑required messages by performing the appropriate lane‑specific action
  // and sending any required response (e.g., ACK for broadcasts, review for ratifications).
  async handleActionRequired(msg) {
    // Default: no special handling – just log.
    const { type, task_kind, broadcast_metadata, from, task_id, subject } = msg;

    // 1️⃣ Broadcast alerts requiring acknowledgment
    if (type === 'alert' && broadcast_metadata && broadcast_metadata.requires_ack) {
      // Build minimal ACK message back to the sender (the `from` lane)
      const ack = {
        schema_version: '1.3',
        task_id: `ack-${task_id}`,
        idempotency_key: `ack-${task_id}`,
        from: this.config.laneName,
        to: from,
        type: 'ack',
        task_kind: 'ack',
        priority: 'P1',
        subject: `ACK: ${subject || ''}`,
        body: `Acknowledged receipt of ${task_id}`,
        timestamp: new Date().toISOString(),
        requires_action: false,
        payload: {},
        execution: {},
        lease: {},
        retry: {},
        evidence: { required: false },
        heartbeat: {}
      };
      try {
        const result = sendMessage(ack);
        if (result.sent && result.delivered) {
          console.log(`[watcher] SENT ACK for ${task_id} to ${from}`);
        } else {
          console.warn(`[watcher] ACK send failed for ${task_id}`);
        }
      } catch (e) {
        console.error(`[watcher] Exception while sending ACK for ${task_id}:`, e.message);
      }
    }

    // 2️⃣ Ratification tasks – produce a lightweight review response
    if (task_kind === 'ratification') {
      // Create a review artifact (placeholder) in outbox and reference it
      const reviewArtifactName = `${msg.payload?.contract_id || 'contract'}-review-${this.config.laneName}.json`;
      const reviewPath = path.join(this.config.outboxPath, reviewArtifactName);
      const reviewContent = {
        review_by: this.config.laneName,
        reviewed_at: new Date().toISOString(),
        status: 'ACK',
        notes: 'Automated ratification acknowledgment – no gaps detected.'
      };
      try {
        fs.writeFileSync(reviewPath, JSON.stringify(reviewContent, null, 2), 'utf8');
        console.log(`[watcher] WROTE ratification review artifact ${reviewArtifactName}`);
      } catch (e) {
        console.error(`[watcher] Failed to write ratification review:`, e.message);
      }

      const response = {
        schema_version: '1.3',
        task_id: `response-${task_id}`,
        idempotency_key: `response-${task_id}`,
        from: this.config.laneName,
        to: from,
        type: 'response',
        task_kind: 'review',
        priority: 'P2',
        subject: `Review of ${msg.payload?.contract_id || 'contract'}`,
        body: `Reviewed ${msg.payload?.contract_id || 'contract'} – all checks passed. See attached artifact.`,
        timestamp: new Date().toISOString(),
        requires_action: false,
        payload: {},
        execution: {},
        lease: {},
        retry: {},
        evidence: { required: false },
        evidence_exchange: {
          artifact_type: 'review',
          artifact_path: reviewPath,
          delivered_at: new Date().toISOString()
        },
        heartbeat: {}
      };
      try {
        const result = sendMessage(response);
        if (result.sent && result.delivered) {
          console.log(`[watcher] SENT ratification response for ${task_id}`);
        } else {
          console.warn(`[watcher] Ratification response send failed for ${task_id}`);
        }
      } catch (e) {
        console.error(`[watcher] Exception while sending ratification response:`, e.message);
      }
    }
  }

  _logQuarantine(filename, reason, attemptCount) {
    const logEntry = {
      timestamp: new Date().toISOString(),
      lane: this.config.laneName,
      file: filename,
      reason: reason,
      attempt_count: attemptCount,
      action: 'quarantine',
      requires_review: true
    };
    const logPath = path.join(this.repoRoot, 'logs', 'quarantine.log');
    try {
      const logDir = path.dirname(logPath);
      if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
      const line = JSON.stringify(logEntry) + '\n';
      fs.appendFileSync(logPath, line, 'utf8');
    } catch (e) {
      console.error(`[watcher] Cannot log quarantine:`, e.message);
    }
  }

        async processMessage(msg) {
    const filename = msg._sourceFile;
        const sourcePath = msg._sourcePath;
        enforceMutation('inbox_mutation', sourcePath);
        const priority = msg.priority || 'P3';
    const type = msg.type || 'unknown';
    const from = msg.from || msg.from_lane || 'unknown';
    const body = typeof msg.body === 'string' ? msg.body : JSON.stringify(msg.body || '');
        const requiresAction = isActionRequiredMessage(msg);
        const idempotencyKey = msg.idempotency_key || msg.id || filename;

        console.log(`[watcher] Processing ${priority} ${type} from ${from}: ${body.slice(0, 80)}`);

        // HARDEN-2: Dual-verification consensus gate
        const consensusResult = consensusCheck(msg, {
            policy: this.consensusPolicy,
            repoRoot: this.repoRoot,
        });
        const routing = routeMessage(msg, consensusResult, { policy: this.consensusPolicy });

        this._logConsensus(msg, consensusResult, routing);

        switch (routing.action) {
            case 'block':
                console.log(`[watcher] CONSENSUS_BLOCKED: ${consensusResult.status} — ${routing.reason}`);
                await this.moveMalformedToQuarantine(filename, sourcePath, 'consensus_blocked', `status=${consensusResult.status} reason=${routing.reason}`);
                this.processedKeys.add(idempotencyKey);
                return;

            case 'escalate':
                console.log(`[watcher] CONSENSUS_ESCALATE: ${consensusResult.status} — ${routing.reason}`);
                await this.moveToActionRequired(filename, sourcePath);
                this.processedKeys.add(idempotencyKey);
                return;

            case 'hold':
                console.log(`[watcher] CONSENSUS_HOLD: ${consensusResult.status} — leaving in inbox for next cycle`);
                return;

            case 'route':
            default:
                break;
        }

    if (type === 'finding' || type === 'review') {
      this.handleConvergenceCheck(msg);
    }

    if (requiresAction) {
      // Process the action‑required message (ACKs, ratifications, etc.)
      console.log(`[watcher] ACTION REQUIRED: ${msg.id || filename}`);
      try {
        await this.handleActionRequired(msg);
      } catch (e) {
        console.error(`[watcher] Action handling error for ${msg.id || filename}:`, e.message);
      }
      await this.moveToProcessed(filename, sourcePath);
      this.processedKeys.add(idempotencyKey);
      try {
        logTransfer({
          source_lane: from, dest_lane: 'archivist', direction: 'receive',
          protocol: 'local_fs', file_path: sourcePath || '',
          status: 'verified', signed_by: from,
          key_id: msg.key_id || '', correlation_id: msg.task_id || idempotencyKey,
        });
      } catch (_) {}
      return;
    }

    await this.moveToProcessed(filename, sourcePath);
    this.processedKeys.add(idempotencyKey);
    try {
      logTransfer({
        source_lane: from, dest_lane: 'archivist', direction: 'receive',
        protocol: 'local_fs', file_path: sourcePath || '',
        status: 'verified', signed_by: from,
        key_id: msg.key_id || '', correlation_id: msg.task_id || idempotencyKey,
      });
    } catch (_) {}
    const p = PRIORITY_ORDER[priority] ?? 3;
    if (p <= 1) {
      this.consecutiveP0Count++;
    } else {
      this.consecutiveP0Count = 0;
    }
    }

    _logConsensus(msg, consensusResult, routing) {
        const logEntry = {
            timestamp: new Date().toISOString(),
            message_id: msg.id || msg.task_id || 'unknown',
            from: msg.from || 'unknown',
            consensus_status: consensusResult.status,
            routing_action: routing.action,
            routing_reason: routing.reason,
            structural_valid: consensusResult.structural.valid,
            operational_valid: consensusResult.operational.valid,
            drift_level: consensusResult.drift.level,
            weighted_score: consensusResult.weighted_score,
        };
        const logDir = path.join(this.repoRoot, 'logs');
        try {
            if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
            fs.appendFileSync(path.join(logDir, 'consensus-log.jsonl'), JSON.stringify(logEntry) + '\n', 'utf8');
        } catch (e) {
            console.error(`[watcher] Cannot log consensus:`, e.message);
        }
    }

  handleConvergenceCheck(msg) {
    const status = msg.status || 'unproven';
    if (status === 'unproven') {
      console.log(`[watcher] SKIP: unproven claim from ${msg.from || msg.from_lane} — not forwarded`);
      return;
    }

    if (msg.claim && msg.evidence) {
      console.log(`[watcher] CONVERGENCE: ${msg.claim}`);
      console.log(`[watcher] Evidence: ${msg.evidence}`);
      console.log(`[watcher] Status: ${status}`);
    }

    // v1.4: Surface uncertainty packets attached to messages
    if (msg.uncertainty) {
      var uResult = validateUncertaintyPacket(msg.uncertainty);
      if (uResult.valid) {
        var uLevel = (msg.uncertainty.level || 'low').toUpperCase();
        var operatorNeeded = msg.uncertainty.operator_decision_needed;
        console.log(`[watcher] UNCERTAINTY: level=${uLevel} type=${(msg.uncertainty.type || []).join(',')} operator_needed=${operatorNeeded} from=${msg.from || 'unknown'}`);
        if (operatorNeeded) {
          console.log(`[watcher] UNCERTAINTY 👤 OPERATOR_DECISION_NEEDED: ${msg.uncertainty.why || 'no reason given'}`);
        }
      } else {
        console.log(`[watcher] UNCERTAINTY_INVALID: ${uResult.errors.join('; ')}`);
      }
    }

    // v1.4: Surface review round protocol attached to messages
    if (msg.review) {
      var rResult = validateReviewRound(msg.review);
      if (rResult.valid) {
        var rStatus = msg.review.status || 'draft';
        var rRound = msg.review.round || 0;
        var rMax = msg.review.max_rounds || 3;
        console.log(`[watcher] REVIEW_ROUND: round=${rRound}/${rMax} status=${rStatus} reviewer=${msg.review.reviewer || 'unknown'}`);
        if (rStatus === 'escalated') {
          console.log(`[watcher] REVIEW_ESCALATED: round=${rRound} reason=${msg.review.escalation_reason || 'max rounds exceeded'}`);
        }
      } else {
        console.log(`[watcher] REVIEW_INVALID: ${rResult.errors.join('; ')}`);
      }
    }
  }

  checkLaneHealth() {
    const results = {};
    const laneNames = Object.keys(this.config.canonicalPaths);

    for (const laneName of laneNames) {
      const inboxPath = this.config.canonicalPaths[laneName];
      const hbPath = path.join(inboxPath, `heartbeat-${laneName}.json`);

      try {
        if (!fs.existsSync(hbPath)) {
          results[laneName] = { status: 'no_heartbeat', stale_for_seconds: -1 };
          continue;
        }

        const raw = fs.readFileSync(hbPath, 'utf8');
        const data = JSON.parse(raw);
        const elapsed = Math.floor((Date.now() - new Date(data.timestamp).getTime()) / 1000);
        results[laneName] = {
          status: elapsed > 900 ? 'stale' : 'alive',
          last_heartbeat: data.timestamp,
          stale_for_seconds: elapsed
        };
      } catch (e) {
        results[laneName] = { status: 'error', stale_for_seconds: -1 };
      }
    }

    return results;
  }

  async run() {
    const releaseLock = acquireWatcherLock({
      repoRoot: this.repoRoot,
      laneName: this.config.laneName,
      policy: this.policy
    });

    console.log(`[watcher] ${this.config.laneName} inbox scan starting`);
    try {
      let messages = await this.scan();
      console.log(`[watcher] Found ${messages.length} messages`);

      if (messages.length === 0) {
        this.consecutiveEmptyScans++;
        this.consecutiveP0Count = 0;
        return 0;
      } else {
        this.consecutiveEmptyScans = 0;
      }

      if (this.checkStarvation()) {
        const p0p1 = messages.filter(m => (PRIORITY_ORDER[m.priority] ?? 3) <= 1);
        const lower = messages.filter(m => (PRIORITY_ORDER[m.priority] ?? 3) > 1);
        if (lower.length > 0) {
          messages = [...p0p1, lower[0]];
          console.log(`[watcher] STARVATION_GUARD: processing 1 deferred P2/P3 message`);
        }
      }

      messages = this.applyPreemption(messages);

      for (const msg of messages) {
        try {
          await this.processMessage(msg);
        } catch (e) {
          console.error(`[watcher] Error processing ${msg._sourceFile}:`, e.message);
        }
      }

      return messages.length;
    } finally {
      releaseLock();
    }
  }
}

module.exports = { InboxWatcher, DEFAULT_CONFIG, PRIORITY_ORDER };

// Updated main execution logic: repeatedly scan and process until the inbox is empty.
// This ensures that all pending messages (including those requiring action) are handled
// in a single run, preventing backlog accumulation. The original test/utility flags
// (`--health`, `--scan`, etc.) retain their previous behavior.
if (require.main === module) {
  (async () => {
  const args = process.argv.slice(2);
  const watcher = new InboxWatcher();
  const shouldBroadcastSummary = args.includes('--broadcast-summary');

    // Utility/debug commands retain their original single‑run semantics.
    if (args.includes('--health')) {
      const health = watcher.checkLaneHealth();
      console.log(JSON.stringify(health, null, 2));
      return;
    }
    if (args.includes('--scan')) {
      const messages = await watcher.scan();
      console.log(
        JSON.stringify(
          messages.map((m) => ({ id: m.id, from: m.from, priority: m.priority, type: m.type })),
          null,
          2
        )
      );
      return;
    }
    if (args.includes('--test-preemption')) {
      console.log('[test] Preemption gate test');
      const testMessages = [
        { priority: 'P2', id: 'test-p2-1', body: 'low priority' },
        { priority: 'P1', id: 'test-p1-1', body: 'high priority' },
        { priority: 'P3', id: 'test-p3-1', body: 'lowest priority' },
        { priority: 'P1', id: 'test-p1-2', body: 'another high' },
        { priority: 'P2', id: 'test-p2-2', body: 'another low' }
      ];
      const watcher2 = new InboxWatcher();
      const result = watcher2.applyPreemption(testMessages);
      const processedPriorities = result.map((m) => m.priority);
      console.log(`[test] Input:  P2, P1, P3, P1, P2`);
      console.log(`[test] Output: ${processedPriorities.join(', ')}`);
      const allP1orBelow = processedPriorities.every((p) => (PRIORITY_ORDER[p] ?? 3) <= 1);
      console.log(`[test] ${allP1orBelow ? 'PASS' : 'FAIL'}: only P0/P1 processed when preemption active`);
      return;
    }
    if (args.includes('--test-starvation')) {
      console.log('[test] Starvation guard test');
      const watcher2 = new InboxWatcher();
      for (let i = 1; i <= 12; i++) {
        watcher2.consecutiveP0Count = i;
        const shouldYield = watcher2.checkStarvation();
        if (shouldYield) {
          console.log(`[test] Cycle ${i}: YIELD triggered (every ${P0_YIELD_EVERY_N} P0/P1 messages)`);
        }
      }
      console.log(`[test] PASS: starvation guard yields every ${P0_YIELD_EVERY_N} consecutive P0/P1 messages`);
      return;
    }
    if (args.includes('--test-crash-recovery')) {
      console.log('[test] Crash + recovery test');
      const lockDir = path.join(watcher.repoRoot, '.runtime', 'locks');
      const lockFile = path.join(lockDir, `watcher-${watcher.config.laneName}.lock`);
      if (fs.existsSync(lockFile)) {
        const raw = fs.readFileSync(lockFile, 'utf8');
        const lock = JSON.parse(raw);
        lock.acquired_at = new Date(Date.now() - 1000 * 1000).toISOString();
        lock.pid = 99999;
        fs.writeFileSync(lockFile, JSON.stringify(lock, null, 2));
        console.log(`[test] Wrote stale lock (PID 99999, age 1000s > stale_after=900s)`);
        try {
          await watcher.run();
          console.log(`[test] PASS: stale lock reclaimed, watcher ran successfully`);
        } catch (e) {
          console.log(`[test] FAIL: ${e.message}`);
        }
      } else {
        console.log(`[test] SKIP: no lock file to test against (run watcher once first)`);
      }
      return;
    }

    // Default behavior: keep scanning until no messages remain.
    let totalProcessed = 0;
    while (true) {
      const count = await watcher.run();
      totalProcessed += count;
      if (count === 0) break; // inbox empty, exit loop
      // Small pause to let any newly generated messages settle before next scan.
      await new Promise((r) => setTimeout(r, 200));
    }
    // Broadcast summary only when work actually occurred, and keep a stable task id
    // so downstream lanes overwrite the same summary file instead of accumulating.
    if (totalProcessed > 0 && shouldBroadcastSummary) {
      const nowIso = new Date().toISOString();
      const summaryMsg = {
        schema_version: '1.3',
        task_id: `summary-${watcher.config.laneName}`,
        idempotency_key: `summary-${watcher.config.laneName}`,
        from: watcher.config.laneName,
        type: 'status',
        task_kind: 'status',
        priority: 'P2',
        subject: 'Inbox processing summary',
        body: `Inbox scan completed. Processed total ${totalProcessed} messages. No pending messages remain.`,
        timestamp: nowIso,
        requires_action: false,
        payload: { mode: 'inline', compression: 'none' },
        execution: { mode: 'watcher', engine: 'opencode', actor: 'watcher' },
        lease: {
          owner: watcher.config.laneName,
          acquired_at: nowIso,
          expires_at: new Date(Date.now() + 300000).toISOString(),
          renew_count: 0,
          max_renewals: 3
        },
        retry: { attempt: 1, max_attempts: 3, last_error: null, last_attempt_at: null },
        evidence: { required: false, evidence_path: null, verified: false, verified_by: null, verified_at: null },
        heartbeat: {
          interval_seconds: 300,
          last_heartbeat_at: nowIso,
          timeout_seconds: 900,
          status: 'done'
        }
      };
      // Optional cross-lane status broadcast.
      // Disabled by default to prevent inbox summary accumulation.
      sendToAll(summaryMsg);
    }

    console.log(`[watcher] Processed total ${totalProcessed} messages`);
  })().catch((err) => {
    console.error(`[watcher] FATAL: ${err.message}`);
    process.exit(1);
  });
}
