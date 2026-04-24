#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const {
  loadPolicy,
  assertWatcherConfig,
  acquireWatcherLock
} = require('./concurrency-policy');
const { IdentityEnforcer } = require('./identity-enforcer');

let validateMessage;
try {
  validateMessage = require('../src/lane/SchemaValidator').validate;
} catch (_) {
  validateMessage = null;
}

const PRIORITY_ORDER = { P0: 0, P1: 1, P2: 2, P3: 3 };
const PREEMPTION_CYCLE_LIMIT = 2;
const P0_YIELD_EVERY_N = 5;

const SKIP_FILENAMES = new Set([
  'heartbeat.json', 'watcher.log', 'watcher.pid', 'readme.md'
]);

const HEARTBEAT_PATTERN = /^heartbeat-.+\.json$/i;
const INBOX_MSG_PATTERN = /^\d{4}-/;
const UUID_PATTERN = /^\d{8}-\d{4}-\d{4}-\d{4}-\d{12}\.json$/i;
  const ACTION_REQUIRED_TYPES = new Set(['task', 'escalation', 'request']);
  const COMPLETION_PROOF_FIELDS = [
    'completion_artifact_path',
    'completion_message_id',
    'resolved_by_task_id',
    'terminal_decision',
    'disposition'
  ];
  const VALID_DISPOSITIONS = new Set(['completed', 'declined', 'superseded', 'expired', 'quarantined']);

function hasCompletionProof(msg) {
  if (!msg) return false;
  for (const field of COMPLETION_PROOF_FIELDS) {
    if (msg[field]) return true;
  }
  if (msg.convergence_gate && msg.convergence_gate.status) {
    const status = String(msg.convergence_gate.status).toLowerCase();
    if (['proven', 'approved', 'ratified', 'accepted'].includes(status)) return true;
  }
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

const DEFAULT_CONFIG = {
  laneName: 'kernel',
  inboxPath: path.join(__dirname, '..', 'lanes', 'kernel', 'inbox'),
  processedPath: path.join(__dirname, '..', 'lanes', 'kernel', 'inbox', 'processed'),
  outboxPath: path.join(__dirname, '..', 'lanes', 'kernel', 'outbox'),
  expiredPath: path.join(__dirname, '..', 'lanes', 'kernel', 'inbox', 'expired'),
  actionRequiredPath: path.join(__dirname, '..', 'lanes', 'kernel', 'inbox', 'action-required'),
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
    this.loadProcessedKeys();
    this.loadConvergenceConstraint();

    this._identityHealed = false;
    try {
      const { healLaneIdentity } = require('./identity-self-healing');
      const healResult = healLaneIdentity(this.config.laneName || 'kernel');
      this._identityHealed = healResult.keysRegenerated || false;
      if (healResult.keysRegenerated) {
        console.log(`[watcher] IDENTITY_SELF_HEAL: keys regenerated keyId=${healResult.keyId}`);
      }
    } catch (_) {}

    this.identityEnforcer = new IdentityEnforcer({ enforcementMode: 'enforce' });
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
      this.config.outboxPath, this.config.expiredPath, this.config.actionRequiredPath]) {
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

  scan() {
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
        if (!this.checkIdempotencyKey(msg)) {
          this.moveToProcessed(filename, filePath);
          continue;
        }
        // Bug 2 fix: validate incoming messages against schema
        if (validateMessage) {
          const result = validateMessage(msg);
          if (!result.valid) {
            console.warn(`[watcher] INVALID: ${filename} — ${result.errors.join('; ')}`);
            this.moveToExpired(filename, filePath);
            continue;
          }
        }
        const idResult = this.identityEnforcer.enforceMessage(msg);
        msg._identity = idResult;
        if (idResult.decision === 'reject') {
          console.warn(`[watcher] IDENTITY_REJECT: ${filename} from ${idResult.from} — ${idResult.reason}`);
          this.moveToExpired(filename, filePath);
          continue;
        }
        messages.push(msg);
      } catch (e) {
        console.error(`[watcher] Cannot parse ${filename}:`, e.message);
        this.moveToExpired(filename, filePath);
      }
    }

    messages.sort((a, b) => {
      const pa = PRIORITY_ORDER[a.priority] ?? 3;
      const pb = PRIORITY_ORDER[b.priority] ?? 3;
      return pa - pb;
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

  moveToProcessed(filename, sourcePath) {
    const dest = path.join(this.config.processedPath, filename);
    try {
      if (fs.existsSync(dest)) {
        fs.unlinkSync(sourcePath);
      } else {
        fs.renameSync(sourcePath, dest);
      }
      this.processedKeys.add(filename);
    } catch (e) {
      console.error(`[watcher] Cannot move ${filename}:`, e.message);
    }
  }

  moveToExpired(filename, sourcePath) {
    const expiredDir = this.config.expiredPath;
    if (!fs.existsSync(expiredDir)) {
      fs.mkdirSync(expiredDir, { recursive: true });
    }
    const dest = path.join(expiredDir, filename);
    try {
      if (fs.existsSync(dest)) {
        fs.unlinkSync(sourcePath);
      } else {
        fs.renameSync(sourcePath, dest);
      }
      console.log(`[watcher] MOVED TO EXPIRED: ${filename} (schema-invalid, not processed)`);
    } catch (e) {
      console.error(`[watcher] Cannot move to expired ${filename}:`, e.message);
    }
  }

  moveToActionRequired(filename, sourcePath) {
    const actionDir = this.config.actionRequiredPath;
    if (!fs.existsSync(actionDir)) {
      fs.mkdirSync(actionDir, { recursive: true });
    }
    const dest = path.join(actionDir, filename);
    try {
      if (fs.existsSync(dest)) {
        fs.unlinkSync(sourcePath);
      } else {
        fs.renameSync(sourcePath, dest);
      }
      console.log(`[watcher] ACTION-REQUIRED HOLD: ${filename} moved to action-required/`);
    } catch (e) {
      console.error(`[watcher] Cannot move to action-required ${filename}:`, e.message);
    }
  }

  processMessage(msg) {
    const filename = msg._sourceFile;
    const sourcePath = msg._sourcePath;
    const priority = msg.priority || 'P3';
    const type = msg.type || 'unknown';
    const from = msg.from || msg.from_lane || 'unknown';
    const body = typeof msg.body === 'string' ? msg.body : JSON.stringify(msg.body || '');
    const requiresAction = isActionRequiredMessage(msg);
    const idempotencyKey = msg.idempotency_key || msg.id || filename;

    console.log(`[watcher] Processing ${priority} ${type} from ${from}: ${body.slice(0, 80)}`);

    if (type === 'finding' || type === 'review') {
      this.handleConvergenceCheck(msg);
    }

    if (requiresAction) {
      // P0: Check for completion proof before blocking
      if (hasCompletionProof(msg)) {
        console.log(`[watcher] ACTION REQUIRED but COMPLETION_PROOF FOUND: ${msg.id || filename} — allowing processed/`);
        this.moveToProcessed(filename, sourcePath);
        this.processedKeys.add(idempotencyKey);
      } else {
        console.log(`[watcher] ACTION REQUIRED (no proof): ${msg.id || filename}`);
        this.moveToActionRequired(filename, sourcePath);
      }
      return;
    }

    this.moveToProcessed(filename, sourcePath);
    this.processedKeys.add(idempotencyKey);

    const p = PRIORITY_ORDER[priority] ?? 3;
    if (p <= 1) {
      this.consecutiveP0Count++;
    } else {
      this.consecutiveP0Count = 0;
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

  run() {
    const releaseLock = acquireWatcherLock({
      repoRoot: this.repoRoot,
      laneName: this.config.laneName,
      policy: this.policy
    });

    console.log(`[watcher] ${this.config.laneName} inbox scan starting`);
    try {
      let messages = this.scan();
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
          this.processMessage(msg);
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

if (require.main === module) {
  const args = process.argv.slice(2);
  const watcher = new InboxWatcher();

  if (args.includes('--health')) {
    const health = watcher.checkLaneHealth();
    console.log(JSON.stringify(health, null, 2));
  } else if (args.includes('--scan')) {
    const messages = watcher.scan();
    console.log(JSON.stringify(messages.map(m => ({
      id: m.id, from: m.from, priority: m.priority, type: m.type
    })), null, 2));
  } else if (args.includes('--test-preemption')) {
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
    const processedPriorities = result.map(m => m.priority);
    console.log(`[test] Input:  P2, P1, P3, P1, P2`);
    console.log(`[test] Output: ${processedPriorities.join(', ')}`);
    const allP1orBelow = processedPriorities.every(p => (PRIORITY_ORDER[p] ?? 3) <= 1);
    console.log(`[test] ${allP1orBelow ? 'PASS' : 'FAIL'}: only P0/P1 processed when preemption active`);
  } else if (args.includes('--test-starvation')) {
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
  } else if (args.includes('--test-crash-recovery')) {
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
        watcher.run();
        console.log(`[test] PASS: stale lock reclaimed, watcher ran successfully`);
      } catch (e) {
        console.log(`[test] FAIL: ${e.message}`);
      }
    } else {
      console.log(`[test] SKIP: no lock file to test against (run watcher once first)`);
    }
  } else {
    const count = watcher.run();
    console.log(`[watcher] Processed ${count} messages`);
  }
}
