#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const cp = require('./completion-proof');
const { ArtifactResolver } = require('./artifact-resolver');
const { ExecutionGate } = require('./execution-gate');
const { evaluateVerificationDomain } = require('./verification-domain-gate');
const { getCodeVersionHash } = require('./code-version-hash');
const { getRoots } = require('./util/lane-discovery');
const { verifyOutputProvenance } = require('./output-provenance');

function runStoreJournalAppend(laneRoot, lane, event, subject, taskId) {
  var scriptPath = path.join(laneRoot, 'scripts', 'store-journal.js');
  if (!fs.existsSync(scriptPath)) return;
  try {
    var execSync = require('child_process').execSync;
    var agent = (process.env.AGENT_INSTANCE_ID || 'lane-worker');
    var safeSubject = String(subject || 'unknown').replace(/"/g, '').slice(0, 80);
    var safeTaskId = String(taskId || 'unknown').replace(/"/g, '').slice(0, 60);
    execSync('node "' + scriptPath + '" append --lane ' + lane +
      ' --event ' + event +
      ' --agent "' + agent + '"' +
      ' --subject "' + safeSubject + '"' +
      ' --task_id "' + safeTaskId + '"', { cwd: laneRoot, timeout: 10000 });
  } catch (e) {}
}

const ACTIONABLE_TYPES = new Set(['task', 'escalation', 'request']);
const NON_ASCII_PATTERN = /[^\x00-\x7F]/;

// NFM-019 fix: Unicode-to-ASCII normalization map for common typographic characters
// Policy: lane messages must be ASCII-only. Agents naturally produce Unicode punctuation
// (em-dashes, smart quotes, ellipsis). This map normalizes them BEFORE the ASCII check,
// so legitimate content is not quarantined for typographic conventions.
const UNICODE_NORMALIZE_MAP = {
  '\u2014': '--',   // em-dash
  '\u2013': '-',    // en-dash
  '\u2018': "'",    // left single quote
  '\u2019': "'",    // right single quote
  '\u201C': '"',    // left double quote
  '\u201D': '"',    // right double quote
  '\u2026': '...',  // ellipsis
  '\u00A0': ' ',    // non-breaking space
  '\u2022': '*',    // bullet
  '\u2010': '-',    // hyphen
  '\u2011': '-',    // non-breaking hyphen
  '\u2012': '-',    // figure dash
  '\u2015': '--',   // horizontal bar
  '\u2212': '-',    // minus sign
};

const UNICODE_NORMALIZE_RE = new RegExp('[' + Object.keys(UNICODE_NORMALIZE_MAP).join('') + ']', 'g');

function normalizeToAscii(str) {
  return str.replace(UNICODE_NORMALIZE_RE, ch => UNICODE_NORMALIZE_MAP[ch] || '?');
}

const SKIP_FILENAMES = new Set(['heartbeat.json', 'watcher.log', 'watcher.pid', 'readme.md']);
const HEARTBEAT_PATTERN = /^heartbeat-.+\.json$/i;

const SESSION_ID = process.env.LANE_SESSION_ID || `sess_${Date.now().toString(36)}_${process.pid}`;
const SESSION_EPOCH = new Date().toISOString();
const ORIGIN_RUNTIME = process.env.LANE_ORIGIN_RUNTIME || 'opencode';
const ORIGIN_WORKSPACE = process.cwd();
const WORKER_ID = process.pid.toString();

function getActiveOwner(laneRoot) {
  const lockPath = path.join(laneRoot, 'lanes', laneRoot.split('/').pop().toLowerCase(), 'state', 'active-owner.json');
  try {
    if (fs.existsSync(lockPath)) {
      return JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    }
  } catch (_) {}
  return null;
}

function claimActiveOwner(laneRoot, lane) {
  const stateDir = path.join(laneRoot, 'lanes', lane, 'state');
  if (!fs.existsSync(stateDir)) fs.mkdirSync(stateDir, { recursive: true });
  const lockPath = path.join(stateDir, 'active-owner.json');
  const owner = {
    session_id: SESSION_ID,
    lane,
    claimed_at: nowIso(),
    pid: process.pid,
    origin_runtime: ORIGIN_RUNTIME,
    origin_workspace: ORIGIN_WORKSPACE,
  };
  fs.writeFileSync(lockPath, JSON.stringify(owner, null, 2));
  return owner;
}

const LANE_HINTS = [
  { hint: 'archivist-agent', lane: 'archivist' },
  { hint: 'self-organizing-library', lane: 'library' },
  { hint: 'kernel-lane', lane: 'kernel' },
  { hint: 'swarmmind', lane: 'swarmmind' },
];

const LANE_ROOTS = getRoots();

function nowIso() {
  return new Date().toISOString();
}

function logAudit(sourcePath, targetPath, reason, workerId, sessionId, context = {}) {
  const timestamp = nowIso();
  const safeSessionId = sessionId || 'unknown';
  const logLine = `${timestamp},worker_id=${workerId},session_id=${safeSessionId},from_path="${sourcePath}",to_path="${targetPath}",reason="${reason}"\n`;

  process.stdout.write(logLine);

  try {
    const inboxPath = context.inboxPath;
    const lane = context.lane;
    if (!inboxPath || !lane) throw new Error('missing audit context (inboxPath/lane)');
    const laneRoot = path.resolve(inboxPath, '..', '..', '..');
    const logDir = path.join(laneRoot, 'lanes', lane, 'state');
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    const logFile = path.join(logDir, 'worker-audit.log');
    fs.appendFileSync(logFile, logLine, 'utf8');
  } catch (err) {
    process.stderr.write(`[lane-worker] Audit logging failed: ${err.message}\n`);
  }
}

// NFM-020: NACK chain prevention.
// Guard 1: never send NACK to yourself (senderLane === targetLane).
// Guard 2: never send NACK for a message that is already a NACK (nack_reason present).
// Guard 3: never send NACK for a message that carries exempt_from_nack flag.
// Guard 4: rate-limit — at most one NACK per (sender, original_task_id) per 60s window.
const NACK_RATE_LIMIT = new Map(); // key: `${senderLane}::${originalTaskId}`, value: last_nack_timestamp
const NACK_COOLDOWN_MS = 60000;

function sendNack(originalMsg, rejectionReason, rejectionDetail, targetLane, fromLane) {
  try {
    const senderLane = String(originalMsg.from || fromLane || 'unknown').toLowerCase();
    if (senderLane === String(targetLane || '').toLowerCase()) {
      return null;
    }
    // Guard 2: original is already a NACK — break the chain
    if (originalMsg.nack_reason) {
      return null;
    }
    // Guard 3: message carries anti-chain exemption
    if (originalMsg.exempt_from_nack === true) {
      return null;
    }
    // Guard 4: rate-limit NACKs per (sender, original task_id)
    const rateKey = `${senderLane}::${originalMsg.task_id || 'unknown'}`;
    const lastNack = NACK_RATE_LIMIT.get(rateKey);
    const now = Date.now();
    if (lastNack && (now - lastNack) < NACK_COOLDOWN_MS) {
      return null;
    }
    NACK_RATE_LIMIT.set(rateKey, now);
    // Clean stale rate-limit entries periodically
    if (NACK_RATE_LIMIT.size > 500) {
      for (const [k, t] of NACK_RATE_LIMIT) {
        if (now - t > NACK_COOLDOWN_MS * 2) NACK_RATE_LIMIT.delete(k);
      }
    }
    const senderRoot = LANE_ROOTS[senderLane];
    if (!senderRoot) {
      process.stderr.write(`[lane-worker] NACK: cannot determine root for sender lane "${senderLane}"\n`);
      return null;
    }
    const senderInbox = path.join(senderRoot, 'lanes', senderLane, 'inbox');
    if (!fs.existsSync(senderInbox)) {
      fs.mkdirSync(senderInbox, { recursive: true });
    }
    const nackMsg = {
      schema_version: '1.3',
      task_id: `nack-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      idempotency_key: `nack-${originalMsg.task_id || 'unknown'}-${Date.now()}`,
      from: String(targetLane || 'unknown').toLowerCase(),
      to: senderLane,
      type: 'notification',
      task_kind: 'status',
      priority: 'P2',
      subject: `NACK: message rejected at ${targetLane}`,
      body: `Your message (task_id=${originalMsg.task_id || 'unknown'}, type=${originalMsg.type || 'unknown'}) was rejected.\nReason: ${rejectionReason}\nDetail: ${rejectionDetail || 'none'}\nOriginal subject: ${originalMsg.subject || 'unknown'}`,
      timestamp: nowIso(),
      requires_action: false,
      payload: { mode: 'inline', compression: 'none' },
      execution: { mode: 'manual', engine: 'kilo', actor: 'lane' },
      lease: { owner: null, acquired_at: null },
      retry: { attempt: 1, max_attempts: 1 },
      evidence: { required: false, verified: false },
      evidence_exchange: {},
      heartbeat: { status: 'done', last_heartbeat_at: nowIso() },
      nack_for_task_id: originalMsg.task_id || null,
      nack_reason: rejectionReason,
      nack_detail: rejectionDetail || null,
      exempt_from_nack: true,  // NFM-020: prevent NACK chains — NACKs are terminal
    };
    const nackPath = path.join(senderInbox, `nack-${nackMsg.task_id}.json`);
    fs.writeFileSync(nackPath, JSON.stringify(nackMsg, null, 2), 'utf8');
    return nackPath;
  } catch (err) {
    process.stderr.write(`[lane-worker] NACK delivery failed: ${err.message}\n`);
    return null;
  }
}

function parseArgs(argv) {
  const out = {
    lane: null,
    apply: false,
    applyOnce: false,
    watch: false,
    manualCadence: false,
    pollSeconds: 20,
    maxFiles: 200,
    json: false,
    enforceOwnership: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--lane' && argv[i + 1]) {
      out.lane = String(argv[i + 1]).toLowerCase();
      i += 1;
      continue;
    }
    if (a === '--apply') {
      out.apply = true;
      continue;
    }
    if (a === '--apply-once') {
      out.applyOnce = true;
      out.apply = true;
      out.watch = false;
      continue;
    }
    if (a === '--watch') {
      out.watch = true;
      continue;
    }
    if (a === '--manual-cadence') {
      out.manualCadence = true;
      continue;
    }
    if (a === '--poll-seconds' && argv[i + 1]) {
      out.pollSeconds = Math.max(1, Number(argv[i + 1]) || out.pollSeconds);
      i += 1;
      continue;
    }
    if (a === '--max-files' && argv[i + 1]) {
      out.maxFiles = Math.max(1, Number(argv[i + 1]) || out.maxFiles);
      i += 1;
      continue;
    }
    if (a === '--json') {
      out.json = true;
      continue;
    }
    if (a === '--enforce-ownership') {
      out.enforceOwnership = true;
      continue;
    }
  }

  return out;
}

function guessLane(repoRoot) {
  const lower = String(repoRoot || '').toLowerCase();
  for (const item of LANE_HINTS) {
    if (lower.includes(item.hint)) return item.lane;
  }
  return 'archivist';
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function safeReadJson(filePath) {
  try { return { ok: true, value: JSON.parse(fs.readFileSync(filePath, 'utf8')) }; }
  catch (err) { return { ok: false, error: err.message }; }
}

const REMEDIATABLE_DEFAULT_FIELDS = new Set([
  'timestamp', 'payload', 'execution', 'lease', 'retry',
  'evidence', 'evidence_exchange', 'heartbeat',
]);

function parseMissingRequiredFields(errors) {
  const out = [];
  for (const err of errors || []) {
    const m = String(err).match(/^Missing required field:\s*(.+)$/);
    if (m && m[1]) out.push(m[1].trim());
    else return null;
  }
  return out;
}

function applySchemaDefaults(msg, lane, missingFields) {
  const now = nowIso();
  const remediated = { ...msg };
  const applied = [];
  for (const field of missingFields) {
    if (!REMEDIATABLE_DEFAULT_FIELDS.has(field)) continue;
    switch (field) {
      case 'timestamp': remediated.timestamp = now; applied.push('timestamp'); break;
      case 'payload': remediated.payload = { mode: 'inline', compression: 'none' }; applied.push('payload'); break;
      case 'execution': remediated.execution = { mode: 'manual', engine: 'pipeline', actor: 'lane' }; applied.push('execution'); break;
      case 'lease': remediated.lease = { owner: remediated.to || lane, acquired_at: now }; applied.push('lease'); break;
      case 'retry': remediated.retry = { attempt: 1, max_attempts: 3 }; applied.push('retry'); break;
      case 'evidence': remediated.evidence = { required: false, verified: false }; applied.push('evidence'); break;
      case 'evidence_exchange': remediated.evidence_exchange = {}; applied.push('evidence_exchange'); break;
      case 'heartbeat': remediated.heartbeat = { status: 'pending', last_heartbeat_at: now, interval_seconds: 300, timeout_seconds: 900 }; applied.push('heartbeat'); break;
    }
  }
  return { remediated, applied };
}

function isActionable(msg) {
  const type = String(msg && msg.type ? msg.type : '').toLowerCase();
  return !!(
    (msg && msg.requires_action === true) ||
    (msg && msg.priority_action === true) ||
    ACTIONABLE_TYPES.has(type)
  );
}

function isEnglishOnly(msg) {
  if (!msg || typeof msg !== 'object') return true;
  const textFields = ['subject', 'body', 'type', 'from', 'to'];
  for (const field of textFields) {
    let val = msg[field];
    if (typeof val === 'string') {
      // NFM-019 fix: normalize common Unicode punctuation to ASCII before check
      val = normalizeToAscii(val);
      if (NON_ASCII_PATTERN.test(val)) {
        return false;
      }
    }
  }
  return true;
}

// Apply Unicode normalization to message text fields in-place before routing
function normalizeMessage(msg) {
  if (!msg || typeof msg !== 'object') return msg;
  const textFields = ['subject', 'body'];
  for (const field of textFields) {
    if (typeof msg[field] === 'string') {
      msg[field] = normalizeToAscii(msg[field]);
    }
  }
  return msg;
}

function evaluateOwnership(msg) {
  const ownership = msg && typeof msg === 'object' ? msg.ownership : null;
  if (!ownership || typeof ownership !== 'object') {
    return { present: false, malformed: false };
  }
  if (ownership.owner_agent_id !== undefined && typeof ownership.owner_agent_id !== 'string') {
    return { present: true, malformed: true, reason: 'owner_agent_id must be a string' };
  }
  if (ownership.lease_expires_at !== undefined && typeof ownership.lease_expires_at !== 'string') {
    return { present: true, malformed: true, reason: 'lease_expires_at must be an ISO string' };
  }
  const now = Date.now();
  const activeAgent = process.env.AGENT_INSTANCE_ID || null;
  const ownerAgent = ownership.owner_agent_id || null;
  let leaseExpired = false;
  if (ownership.lease_expires_at) {
    const leaseMs = Date.parse(String(ownership.lease_expires_at));
    if (!Number.isNaN(leaseMs) && leaseMs < now) leaseExpired = true;
  }
  const ownerMismatch = Boolean(activeAgent && ownerAgent && activeAgent !== ownerAgent);
  return {
    present: true,
    malformed: false,
    owner_agent_id: ownerAgent,
    mode: ownership.mode || null,
    coordination_group: ownership.coordination_group || null,
    lease_expires_at: ownership.lease_expires_at || null,
    lease_expired: leaseExpired,
    owner_mismatch: ownerMismatch,
    active_agent_id: activeAgent,
    conflict_policy: ownership.conflict_policy || null,
  };
}

function completionGateApprove(msg) {
  return cp.evaluate(msg);
}

function shouldAutoStart(msg) {
  if (!msg || typeof msg !== 'object') return false;
  if (msg.worker_claim === true) return true;
  if (msg.auto_execute === true || msg.auto_start === true) return true;
  if (msg.execution && msg.execution.mode === 'watcher') return true;
  return false;
}

function uniquePath(targetPath) {
  if (!fs.existsSync(targetPath)) return targetPath;
  const dir = path.dirname(targetPath);
  const ext = path.extname(targetPath);
  const base = path.basename(targetPath, ext);
  const stamp = nowIso().replace(/[:.]/g, '-');
  return path.join(dir, `${base}.lane-worker-${stamp}${ext}`);
}

function createDefaultConfig(repoRoot, lane) {
  const inboxRoot = path.join(repoRoot, 'lanes', lane, 'inbox');
  return {
    repoRoot,
    lane,
    queues: {
      inbox: inboxRoot,
      actionRequired: path.join(inboxRoot, 'action-required'),
      inProgress: path.join(inboxRoot, 'in-progress'),
      processed: path.join(inboxRoot, 'processed'),
      blocked: path.join(inboxRoot, 'blocked'),
      quarantine: path.join(inboxRoot, 'quarantine'),
      needsReview: path.join(inboxRoot, 'needs-review'),
      staleForeign: path.join(inboxRoot, 'stale-foreign'),
    },
  };
}

class LaneWorker {
  constructor(options = {}) {
    this.repoRoot = options.repoRoot || path.resolve(__dirname, '..');
    this.lane = options.lane || guessLane(this.repoRoot);
    this.dryRun = options.dryRun !== undefined ? !!options.dryRun : true;
    this.maxFiles = options.maxFiles || 200;
    this.manualCadence = options.manualCadence === true;
    this.enforceOwnership = options.enforceOwnership === true;
    this.config = options.config || createDefaultConfig(this.repoRoot, this.lane);
    this.schemaValidator = options.schemaValidator || this._loadSchemaValidator();
    this.signatureValidator = options.signatureValidator || this._loadSignatureValidator();
    this.artifactResolver = options.artifactResolver || new ArtifactResolver({
      dryRun: this.dryRun,
      configPath: path.join(this.repoRoot, 'config', 'allowed_roots.json'),
    });
    this.executionGate = options.executionGate || new ExecutionGate({
      lane: this.lane,
      dryRun: this.dryRun,
      resolver: this.artifactResolver,
    });
    this.codeVersionHash = getCodeVersionHash(this.repoRoot);
    this.lastRun = null;
    this.sessionId = SESSION_ID;
    this.isOwner = false;
    if (!this.dryRun) {
      const existing = getActiveOwner(this.repoRoot);
      if (!existing || existing.session_id === SESSION_ID || (Date.now() - new Date(existing.claimed_at).getTime()) > 900000) {
        claimActiveOwner(this.repoRoot, this.lane);
        this.isOwner = true;
      }
    } else {
      this.isOwner = true;
    }
  }

  _loadSchemaValidator() {
    try {
      const mod = require(path.join(this.repoRoot, 'src', 'lane', 'SchemaValidator'));
      if (mod && typeof mod.validate === 'function') {
        return (msg) => {
          const result = mod.validate(msg);
          return { valid: !!result.valid, errors: result.errors || [] };
        };
      }
    } catch (_) {}

    return (msg) => {
      const required = ['from', 'to', 'type', 'timestamp'];
      const errors = [];
      for (const field of required) {
        if (!(field in (msg || {}))) errors.push(`Missing required field: ${field}`);
      }
      return { valid: errors.length === 0, errors };
    };
  }

  _loadSignatureValidator() {
    try {
      const mod = require(path.join(this.repoRoot, 'scripts', 'identity-enforcer'));
      if (mod && typeof mod.IdentityEnforcer === 'function') {
        const enforcer = new mod.IdentityEnforcer({ enforcementMode: 'warn' });
        return (msg) => {
          try {
            const result = enforcer.enforceMessage(msg);
            const valid = !!result && result.decision !== 'reject';
            return { valid, reason: valid ? null : (result.reason || 'IDENTITY_REJECT'), details: result };
          } catch (err) {
            return { valid: false, reason: err.message, details: null };
          }
        };
      }
    } catch (_) {}

    return () => ({ valid: false, reason: 'IDENTITY_ENFORCER_UNAVAILABLE_FAIL_CLOSED', details: null });
  }

  ensureQueues() {
    const q = this.config.queues;
    if (!fs.existsSync(q.inbox)) {
      if (this.dryRun) {
        throw new Error(`Inbox missing in dry-run mode: ${q.inbox}`);
      }
      ensureDir(q.inbox);
    }
    if (this.dryRun) return;
    ensureDir(q.actionRequired);
    ensureDir(q.inProgress);
    ensureDir(q.processed);
    ensureDir(q.blocked);
    ensureDir(q.quarantine);
  }

  listInboxFiles() {
    const files = [];
    const inboxDir = this.config.queues.inbox;

    // Scan inbox root
    if (fs.existsSync(inboxDir)) {
      const entries = fs.readdirSync(inboxDir, { withFileTypes: true });
      for (const ent of entries) {
        if (!ent.isFile()) continue;
        const lower = ent.name.toLowerCase();
        if (!lower.endsWith('.json')) continue;
        if (SKIP_FILENAMES.has(lower)) continue;
        if (HEARTBEAT_PATTERN.test(lower)) continue;
        files.push(path.join(inboxDir, ent.name));
      }
    }

  // action-required/ is NOT scanned — it is the executor's domain.
  // The lane-worker routes new tasks there; re-scanning would cause
  // stale-foreign misrouting and duplicate .lane-worker suffix accumulation.
  // See: NFM-025 (action-required is executor-owned, not watcher-owned).

  return files.slice(0, this.maxFiles);
  }

  decideRoute(msg, schemaResult, signatureResult) {
    // NFM-019 fix: normalize Unicode punctuation to ASCII before any checks
    normalizeMessage(msg);
    if (!schemaResult.valid) {
      return { queue: 'quarantine', reason: 'SCHEMA_INVALID', detail: schemaResult.errors.join('; ') };
    }
    if (!signatureResult.valid) {
      return { queue: 'blocked', reason: 'SIGNATURE_INVALID', detail: signatureResult.reason || 'Signature validation failed' };
    }
    if (!isEnglishOnly(msg)) {
      return { queue: 'quarantine', reason: 'FORMAT_VIOLATION_NON_ASCII', detail: 'Message contains non-ASCII content. Re-request in English per governance constraint.' };
    }

    if (typeof msg.body === 'string') {
      var prov = verifyOutputProvenance(msg.body);
      if (!prov.ok) {
        return { queue: 'blocked', reason: 'OUTPUT_PROVENANCE_MISSING', detail: 'body lacks OUTPUT_PROVENANCE header. Missing: ' + prov.missing.join(', ') + '. All agent output must include OUTPUT_PROVENANCE:, agent:, lane:, target:.' };
      }
    }

  // NFM-022 fix: skip hasUnresolvableEvidence for actionable tasks
  // A new task (requires_action=true) hasn't been executed yet, so
  // evidence.required=true with no artifact is expected, not a violation.
  if (!isActionable(msg) && cp.hasUnresolvableEvidence(msg)) {
    return { queue: 'blocked', reason: 'EVIDENCE_REQUIRED_NO_ARTIFACT', detail: 'evidence.required=true but no evidence_exchange.artifact_path provided' };
  }

    if (cp.hasFakeProof(msg)) {
      return { queue: 'blocked', reason: 'FAKE_COMPLETION_PROOF', detail: 'terminal_decision/disposition present without evidence_exchange or legacy artifact' };
    }

    const ownership = evaluateOwnership(msg);
    const ownershipNotes = [];
    if (!ownership.present) ownershipNotes.push('OWNERSHIP_MISSING');
    if (ownership.present && ownership.lease_expired) ownershipNotes.push('OWNERSHIP_LEASE_EXPIRED');
    if (ownership.present && ownership.owner_mismatch) ownershipNotes.push('OWNERSHIP_OWNER_MISMATCH');

    if (ownership.malformed) {
      return {
        queue: 'quarantine',
        reason: 'OWNERSHIP_MALFORMED',
        detail: ownership.reason || 'ownership object malformed',
        ownership,
        ownership_notes: ownershipNotes.concat(['OWNERSHIP_MALFORMED'])
      };
    }

    if (
      this.enforceOwnership &&
      ownership.present &&
      ownership.owner_agent_id &&
      ownership.lease_expires_at &&
      !ownership.lease_expired &&
      ownership.owner_mismatch
    ) {
      return {
        queue: 'blocked',
        reason: 'OWNERSHIP_ENFORCED_MISMATCH',
        detail: `owner_agent_id=${ownership.owner_agent_id} does not match active agent`,
        ownership,
        ownership_notes: ownershipNotes.concat(['OWNERSHIP_BLOCKED_ENFORCED'])
      };
    }

    const gate = completionGateApprove(msg);
    if (isActionable(msg) && !cp.hasCompletionProof(msg)) {
      if (!this.manualCadence && shouldAutoStart(msg)) {
        return { queue: 'inProgress', reason: 'ACTIONABLE_NO_PROOF_AUTO_START', detail: gate.detail, ownership, ownership_notes: ownershipNotes };
      }
      return {
        queue: 'actionRequired',
        reason: this.manualCadence ? 'ACTIONABLE_NO_PROOF_MANUAL_CADENCE' : 'ACTIONABLE_NO_PROOF',
        detail: gate.detail,
        ownership,
        ownership_notes: ownershipNotes
      };
    }

    if (!gate.pass) {
      return { queue: 'blocked', reason: gate.reason, detail: gate.detail, ownership, ownership_notes: ownershipNotes };
    }

  // Artifact resolution check: any message claiming completion proof MUST verify.
  // Fail-closed: if proof exists but cannot be verified, route to blocked.
  // Legacy artifact paths bypass the verification domain gate and go directly
  // to execution gate verification, since they lack the structured fields
  // (evidence_exchange, timestamps) that the domain gate validates.
  if (gate.pass && cp.hasCompletionProof(msg)) {
    const proofClassification = this.artifactResolver.classifyProof(msg);
    const isLegacyPath = proofClassification.type === 'LEGACY_ARTIFACT_PATH';

    if (!isLegacyPath) {
      const domain = evaluateVerificationDomain(msg, {
        resolver: this.artifactResolver,
        localCodeVersionHash: this.codeVersionHash,
        repoRoot: this.repoRoot,
      });
      if (!domain.domain_valid) {
        // If the failure is due to observability (artifact not observable), allow execution verification to handle it.
        if (domain.observability && !domain.observability.valid) {
          // fall through to execution verification
        } else {
          // Fail-closed for other domain validation failures.
          return {
            queue: 'blocked',
            reason: domain.phase === 'post_execution' ? 'INVALID_DOMAIN_POST_EXECUTION' : 'INVALID_DOMAIN_PRE_EXECUTION',
            detail: domain.invalid_domain_reason,
            execution_verified: false,
            execution_would_verify: false,
            domain_gate_executed: true,
            verification_outcome: domain.verification_outcome || 'INVALID_DOMAIN',
            execution_preserved: domain.phase === 'post_execution',
            domain_validation: domain,
            verification_path: ['domain_gate', 'execution_check', 'response_validation'],
            ownership,
            ownership_notes: ownershipNotes,
          };
        }
      }
    }
    const executionResult = this.executionGate.verify(msg);
    if (!executionResult.execution_verified) {
      return {
        queue: 'blocked',
        reason: 'EXECUTION_NOT_VERIFIED',
        detail: `Execution verification failed: type=${executionResult.verification_type} reason=${executionResult.reason} artifact_path=${executionResult.artifact_path || 'null'}`,
        execution_verified: false,
        execution_would_verify: executionResult.would_verify === true,
        domain_gate_executed: !isLegacyPath,
        verification_outcome: 'FAIL',
        verification_path: isLegacyPath ? ['execution_check', 'response_validation'] : ['domain_gate', 'execution_check', 'response_validation'],
        domain_validation: isLegacyPath ? null : undefined,
        ownership,
        ownership_notes: ownershipNotes,
      };
    }
  }
  // Non-actionable messages claiming completion without verifiable artifact = blocked
  if (gate.pass && !isActionable(msg) && cp.hasCompletionProof(msg)) {
    const proofClassification2 = this.artifactResolver.classifyProof(msg);
    const isLegacyPath2 = proofClassification2.type === 'LEGACY_ARTIFACT_PATH';

    if (!isLegacyPath2) {
      const domain = evaluateVerificationDomain(msg, {
        resolver: this.artifactResolver,
        localCodeVersionHash: this.codeVersionHash,
        repoRoot: this.repoRoot,
      });
      if (!domain.domain_valid) {
        if (domain.observability && !domain.observability.valid) {
          // fall through to execution verification
        } else {
          return {
            queue: 'blocked',
            reason: domain.phase === 'post_execution' ? 'INVALID_DOMAIN_POST_EXECUTION' : 'INVALID_DOMAIN_PRE_EXECUTION',
            detail: domain.invalid_domain_reason,
            execution_verified: false,
            execution_would_verify: false,
            domain_gate_executed: true,
            verification_outcome: domain.verification_outcome || 'INVALID_DOMAIN',
            execution_preserved: domain.phase === 'post_execution',
            domain_validation: domain,
            verification_path: ['domain_gate', 'execution_check', 'response_validation'],
            ownership,
            ownership_notes: ownershipNotes,
          };
        }
      }
    }
    const executionResult = this.executionGate.verify(msg);
    if (!executionResult.execution_verified) {
      return {
        queue: 'blocked',
        reason: 'EXECUTION_NOT_VERIFIED',
        detail: `Execution verification failed: type=${executionResult.verification_type} reason=${executionResult.reason} artifact_path=${executionResult.artifact_path || 'null'}`,
        execution_verified: false,
        execution_would_verify: executionResult.would_verify === true,
        domain_gate_executed: !isLegacyPath2,
        verification_outcome: 'FAIL',
        verification_path: isLegacyPath2 ? ['execution_check', 'response_validation'] : ['domain_gate', 'execution_check', 'response_validation'],
        domain_validation: isLegacyPath2 ? null : undefined,
        ownership,
        ownership_notes: ownershipNotes,
      };
    }
  }

    return {
      queue: 'processed',
      reason: gate.reason,
      detail: gate.detail,
      execution_verified: cp.hasCompletionProof(msg),
      execution_would_verify: cp.hasCompletionProof(msg),
      domain_gate_executed: true,
      verification_outcome: 'PASS',
      verification_path: ['domain_gate', 'execution_check', 'response_validation'],
      ownership,
      ownership_notes: ownershipNotes
    };
  }

  _writeWithMetadata(targetPath, msg, decision, schemaResult, signatureResult, remediation = null) {
    const enriched = {
      ...msg,
      execution_verified: decision.execution_verified !== undefined ? decision.execution_verified : false,
      would_verify: decision.execution_would_verify === true,
      _lane_worker: {
        lane: this.lane,
        routed_at: nowIso(),
        dry_run: this.dryRun,
        route: decision.queue,
        reason: decision.reason,
        detail: decision.detail || null,
        schema_valid: !!schemaResult.valid,
        signature_valid: !!signatureResult.valid,
        schema_remediation: remediation,
        english_only: isEnglishOnly(msg),
        execution_verified: decision.execution_verified !== undefined ? decision.execution_verified : false,
        would_verify: decision.execution_would_verify === true,
        enforce_ownership: this.enforceOwnership,
        ownership_enforcement_enabled: this.enforceOwnership,
        ownership: decision.ownership || { present: false },
        ownership_notes: decision.ownership_notes || [],
        domain_gate_executed: decision.domain_gate_executed === true,
        verification_outcome: decision.verification_outcome || null,
        domain_validation: decision.domain_validation || null,
      verification_path: decision.verification_path || null,
      session_identity: {
        session_id: SESSION_ID,
        session_epoch_started_at: SESSION_EPOCH,
        origin_runtime: ORIGIN_RUNTIME,
        origin_workspace: ORIGIN_WORKSPACE,
      },
      output_provenance: {
        agent: `lane-worker-${WORKER_ID}`,
        lane: this.lane,
        generated_at: nowIso(),
        session_id: SESSION_ID,
      },
    },
    };
    if (decision.reason === 'FORMAT_VIOLATION_NON_ASCII') {
      enriched.format_violation = true;
      enriched.format_violation_reason = 'Non-ASCII content detected. Re-request in English per governance constraint.';
    }
    fs.writeFileSync(targetPath, JSON.stringify(enriched, null, 2), 'utf8');
  }

processFile(filePath) {
  const filename = path.basename(filePath);
  const rawRead = safeReadJson(filePath);

  if (!rawRead.ok) {
    return this._routeRaw(filePath, 'quarantine', {
      reason: 'INVALID_JSON',
      detail: rawRead.error,
      filename,
    });
  }

  let msg = rawRead.value;

  if (!this.isOwner && msg.requires_action === true) {
    const needsReviewDir = this.config.queues.needsReview || path.join(path.dirname(filePath), 'needs-review');
    if (!fs.existsSync(needsReviewDir)) fs.mkdirSync(needsReviewDir, { recursive: true });
    const nrPath = uniquePath(path.join(needsReviewDir, filename));
    if (!this.dryRun) {
      fs.renameSync(filePath, nrPath);
      // Audit log for file move
      logAudit(filePath, nrPath, 'FOREIGN_INSTANCE_ACTIONABLE', WORKER_ID, SESSION_ID, {
        inboxPath: this.config.queues.inbox,
        lane: this.lane,
      });
    }
    return {
      source: filePath, filename, target_queue: 'needs-review',
      target_path: nrPath, reason: 'FOREIGN_INSTANCE_ACTIONABLE',
      detail: `Non-owner session ${SESSION_ID.slice(0,12)}: actionable message from different instance deferred`,
      schema_valid: false, signature_valid: false, actionable: true,
      has_completion_proof: false, dry_run: this.dryRun,
    };
  }

  if (msg._lane_worker && msg._lane_worker.session_identity &&
      msg._lane_worker.session_identity.session_id &&
      msg._lane_worker.session_identity.session_id !== SESSION_ID) {
    if (!msg.allow_cross_instance && msg.requires_action === true) {
      const staleDir = this.config.queues.staleForeign || path.join(path.dirname(filePath), 'stale-foreign');
      if (!fs.existsSync(staleDir)) fs.mkdirSync(staleDir, { recursive: true });
      const sfPath = uniquePath(path.join(staleDir, filename));
      if (!this.dryRun) { 
        fs.renameSync(filePath, sfPath);
        // Audit log for file move
        logAudit(filePath, sfPath, 'STALE_FOREIGN_INSTANCE', WORKER_ID, SESSION_ID, {
          inboxPath: this.config.queues.inbox,
          lane: this.lane,
        });
      }
      return {
        source: filePath, filename, target_queue: 'stale-foreign',
        target_path: sfPath, reason: 'STALE_FOREIGN_INSTANCE',
        detail: `Message from foreign session ${msg._lane_worker.session_identity.session_id.slice(0,12)}, cross-instance not allowed`,
        schema_valid: false, signature_valid: false, actionable: true,
        has_completion_proof: false, dry_run: this.dryRun,
      };
    }
  }

  let schemaResult = this.schemaValidator(msg);
  const signatureResult = this.signatureValidator(msg);
  let remediation = null;
  if (!schemaResult.valid && signatureResult.valid) {
    const missingFields = parseMissingRequiredFields(schemaResult.errors || []);
    if (missingFields && missingFields.length > 0) {
      const patched = applySchemaDefaults(msg, this.lane, missingFields);
      if (patched.applied.length > 0) {
        msg = patched.remediated;
        schemaResult = this.schemaValidator(msg);
        remediation = { attempted: true, applied_fields: patched.applied, success: schemaResult.valid };
      }
    }
  }
  const decision = this.decideRoute(msg, schemaResult, signatureResult);
    const targetDir = this.config.queues[decision.queue];
    const targetPath = uniquePath(path.join(targetDir, filename));

    const record = {
      source: filePath,
      filename,
      target_queue: decision.queue,
      target_path: targetPath,
      reason: decision.reason,
      detail: decision.detail || null,
      schema_valid: !!schemaResult.valid,
      signature_valid: !!signatureResult.valid,
      english_only: isEnglishOnly(msg),
      actionable: isActionable(msg),
      has_completion_proof: cp.hasCompletionProof(msg),
      execution_verified: decision.execution_verified !== undefined ? decision.execution_verified : false,
      would_verify: decision.execution_would_verify === true,
      enforce_ownership: this.enforceOwnership,
      ownership_enforcement_enabled: this.enforceOwnership,
      ownership: decision.ownership || { present: false },
      ownership_notes: decision.ownership_notes || [],
      verification_outcome: decision.verification_outcome || null,
      domain_validation: decision.domain_validation || null,
      domain_gate_executed: decision.domain_gate_executed === true,
  verification_path: decision.verification_path || null,
  schema_remediation: remediation || null,
  dry_run: this.dryRun,
};

  if (!this.dryRun) {
      this._writeWithMetadata(targetPath, msg, decision, schemaResult, signatureResult, remediation);
      logAudit(filePath, targetPath, decision.reason, WORKER_ID, SESSION_ID, {
        inboxPath: this.config.queues.inbox,
        lane: this.lane,
      });
      fs.unlinkSync(filePath);
      var sjEvent = decision.queue === 'actionRequired' ? 'work_started' :
                    decision.queue === 'processed' ? 'work_completed' :
                    decision.queue === 'blocked' ? 'work_blocked' :
                    decision.queue === 'quarantine' ? 'work_quarantined' : 'work_routed';
      runStoreJournalAppend(this.repoRoot, this.lane, sjEvent, msg.subject || msg.task_id, msg.task_id);
      if (decision.queue === 'quarantine' || decision.queue === 'blocked') {
        sendNack(msg, decision.reason, decision.detail, this.lane, this.lane);
      }
    }

  return record;
}

_routeRaw(filePath, queueKey, meta) {
  const filename = path.basename(filePath);
  const targetDir = this.config.queues[queueKey];
  const targetPath = uniquePath(path.join(targetDir, filename));
  const record = {
    source: filePath,
    filename,
    target_queue: queueKey,
    target_path: targetPath,
    reason: meta.reason,
    detail: meta.detail || null,
    schema_valid: false,
    signature_valid: false,
    actionable: false,
    has_completion_proof: false,
    dry_run: this.dryRun,
  };

  if (!this.dryRun) {
      fs.renameSync(filePath, targetPath);
      logAudit(filePath, targetPath, meta.reason || 'UNKNOWN', WORKER_ID, SESSION_ID, {
        inboxPath: this.config.queues.inbox,
        lane: this.lane,
      });
      if (queueKey === 'quarantine' || queueKey === 'blocked') {
        try {
          const rawRead2 = safeReadJson(targetPath);
          if (rawRead2.ok) {
            sendNack(rawRead2.value, meta.reason, meta.detail, this.lane, this.lane);
          }
        } catch (_) {}
      }
    }
  return record;
}

  processOnce() {
    this.ensureQueues();
    const files = this.listInboxFiles();
    const routes = [];

    for (const filePath of files) {
      try {
        routes.push(this.processFile(filePath));
      } catch (err) {
        routes.push({
          source: filePath,
          filename: path.basename(filePath),
          target_queue: 'quarantine',
          reason: 'PROCESSING_EXCEPTION',
          detail: err.message,
          dry_run: this.dryRun,
        });
      }
    }

    const summary = {
      lane: this.lane,
      repo_root: this.repoRoot,
      dry_run: this.dryRun,
      scanned: files.length,
      routed: {
        action_required: routes.filter((r) => r.target_queue === 'actionRequired').length,
        in_progress: routes.filter((r) => r.target_queue === 'inProgress').length,
        processed: routes.filter((r) => r.target_queue === 'processed').length,
        blocked: routes.filter((r) => r.target_queue === 'blocked').length,
        quarantine: routes.filter((r) => r.target_queue === 'quarantine').length,
      },
      execution_verified_count: routes.filter((r) => r.execution_verified === true).length,
      execution_failed_count: routes.filter((r) => r.execution_verified === false && r.reason === 'EXECUTION_NOT_VERIFIED').length,
      liveness: this.executionGate.checkLiveness(this.config.queues.processed),
      manual_cadence: this.manualCadence,
      enforce_ownership: this.enforceOwnership,
      ownership_enforcement_enabled: this.enforceOwnership,
      ownership_warnings: routes.filter((r) => (r.ownership_notes || []).some((n) => n.startsWith('OWNERSHIP_'))).length,
      routes,
      timestamp: nowIso(),
    };

    this.lastRun = summary;
    return summary;
  }
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function runCli() {
  const args = parseArgs(process.argv.slice(2));
  if (args.applyOnce) {
    args.watch = false;
    args.apply = true;
  }
  const repoRoot = path.resolve(__dirname, '..');
  const lane = args.lane || guessLane(repoRoot);
  if (args.enforceOwnership) {
    const agentId = process.env.AGENT_INSTANCE_ID || 'unknown';
    console.log(`[lane-worker] Ownership enforcement enabled for agent ${agentId}`);
  }
  const worker = new LaneWorker({
    repoRoot,
    lane,
    dryRun: args.manualCadence ? true : !args.apply,
    maxFiles: args.maxFiles,
    manualCadence: args.manualCadence,
    enforceOwnership: args.enforceOwnership,
  });

  if (!args.watch) {
    const summary = worker.processOnce();
    if (args.json) {
      console.log(JSON.stringify(summary, null, 2));
    } else {
      console.log(
        `[lane-worker] lane=${summary.lane} dry_run=${summary.dry_run} scanned=${summary.scanned} ` +
        `processed=${summary.routed.processed} action-required=${summary.routed.action_required} ` +
        `in-progress=${summary.routed.in_progress} blocked=${summary.routed.blocked} quarantine=${summary.routed.quarantine}`
      );
    }
    return;
  }

  while (true) {
    const summary = worker.processOnce();
    if (args.json) {
      console.log(JSON.stringify(summary, null, 2));
    } else {
      console.log(
        `[lane-worker] lane=${summary.lane} dry_run=${summary.dry_run} scanned=${summary.scanned} ` +
        `processed=${summary.routed.processed} action-required=${summary.routed.action_required} ` +
        `in-progress=${summary.routed.in_progress} blocked=${summary.routed.blocked} quarantine=${summary.routed.quarantine}`
      );
    }
    await sleep(args.pollSeconds * 1000);
  }
}

if (require.main === module) {
  runCli().catch((err) => {
    console.error(`[lane-worker] FATAL: ${err.message}`);
    process.exit(1);
  });
}

module.exports = {
  LaneWorker,
  createDefaultConfig,
  completionGateApprove,
  isActionable,
  isEnglishOnly,
  hasCompletionProof: cp.hasCompletionProof,
  hasFakeProof: cp.hasFakeProof,
  hasUnresolvableEvidence: cp.hasUnresolvableEvidence,
};

