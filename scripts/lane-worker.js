#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const cp = require('./completion-proof');
const { ArtifactResolver } = require('./artifact-resolver');
const { ExecutionGate } = require('./execution-gate');

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

const LANE_HINTS = [
  { hint: 'archivist-agent', lane: 'archivist' },
  { hint: 'self-organizing-library', lane: 'library' },
  { hint: 'kernel-lane', lane: 'kernel' },
  { hint: 'swarmmind', lane: 'swarmmind' },
];

function nowIso() {
  return new Date().toISOString();
}

function parseArgs(argv) {
  const out = {
    lane: null,
    apply: false,
    watch: false,
    pollSeconds: 20,
    maxFiles: 200,
    json: false,
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
    if (a === '--watch') {
      out.watch = true;
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
  try {
    return { ok: true, value: JSON.parse(fs.readFileSync(filePath, 'utf8')) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
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
    },
  };
}

class LaneWorker {
  constructor(options = {}) {
    this.repoRoot = options.repoRoot || path.resolve(__dirname, '..');
    this.lane = options.lane || guessLane(this.repoRoot);
    this.dryRun = options.dryRun !== undefined ? !!options.dryRun : true;
    this.maxFiles = options.maxFiles || 200;
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
    this.lastRun = null;
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
        const enforcer = new mod.IdentityEnforcer({ enforcementMode: 'enforce' });
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
    const entries = fs.readdirSync(this.config.queues.inbox, { withFileTypes: true });
    const files = [];
    for (const ent of entries) {
      if (!ent.isFile()) continue;
      const name = ent.name;
      const lower = name.toLowerCase();
      if (!lower.endsWith('.json')) continue;
      if (SKIP_FILENAMES.has(lower)) continue;
      if (HEARTBEAT_PATTERN.test(lower)) continue;
      files.push(path.join(this.config.queues.inbox, name));
    }
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

    if (cp.hasUnresolvableEvidence(msg)) {
      return { queue: 'blocked', reason: 'EVIDENCE_REQUIRED_NO_ARTIFACT', detail: 'evidence.required=true but no evidence_exchange.artifact_path provided' };
    }

    if (cp.hasFakeProof(msg)) {
      return { queue: 'blocked', reason: 'FAKE_COMPLETION_PROOF', detail: 'terminal_decision/disposition present without evidence_exchange or legacy artifact' };
    }

    const gate = completionGateApprove(msg);
    if (isActionable(msg) && !cp.hasCompletionProof(msg)) {
      if (shouldAutoStart(msg)) {
        return { queue: 'inProgress', reason: 'ACTIONABLE_NO_PROOF_AUTO_START', detail: gate.detail };
      }
      return { queue: 'actionRequired', reason: 'ACTIONABLE_NO_PROOF', detail: gate.detail };
    }

    if (!gate.pass) {
      return { queue: 'blocked', reason: gate.reason, detail: gate.detail };
    }

  // Artifact resolution check: only for processed/ admission
  // Actionable messages with artifact_path should go to actionRequired, not blocked
  // (the artifact won't exist until the lane completes the task)
  if (gate.pass && isActionable(msg) && cp.hasCompletionProof(msg)) {
    const executionResult = this.executionGate.verify(msg);
    if (!executionResult.execution_verified) {
      if (shouldAutoStart(msg)) {
        return { queue: 'inProgress', reason: 'ACTIONABLE_ARTIFACT_PENDING', detail: gate.detail, execution_would_verify: executionResult.would_verify === true };
      }
      return { queue: 'actionRequired', reason: 'ACTIONABLE_ARTIFACT_PENDING', detail: gate.detail, execution_would_verify: executionResult.would_verify === true };
    }
  }
  // Non-actionable messages claiming completion without verifiable artifact = blocked
  if (gate.pass && !isActionable(msg) && cp.hasCompletionProof(msg)) {
    const executionResult = this.executionGate.verify(msg);
    if (!executionResult.execution_verified) {
      return {
        queue: 'blocked',
        reason: 'EXECUTION_NOT_VERIFIED',
          detail: `Execution verification failed: type=${executionResult.verification_type} reason=${executionResult.reason} artifact_path=${executionResult.artifact_path || 'null'}`,
          execution_verified: false,
          execution_would_verify: executionResult.would_verify === true,
        };
      }
    }

    return { queue: 'processed', reason: gate.reason, detail: gate.detail, execution_verified: true, execution_would_verify: true };
  }

  _writeWithMetadata(targetPath, msg, decision, schemaResult, signatureResult) {
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
        english_only: isEnglishOnly(msg),
        execution_verified: decision.execution_verified !== undefined ? decision.execution_verified : false,
        would_verify: decision.execution_would_verify === true,
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

    const msg = rawRead.value;
    const schemaResult = this.schemaValidator(msg);
    const signatureResult = this.signatureValidator(msg);
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
      dry_run: this.dryRun,
    };

    if (!this.dryRun) {
      this._writeWithMetadata(targetPath, msg, decision, schemaResult, signatureResult);
      fs.unlinkSync(filePath);
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
  const repoRoot = path.resolve(__dirname, '..');
  const lane = args.lane || guessLane(repoRoot);
  const worker = new LaneWorker({
    repoRoot,
    lane,
    dryRun: !args.apply,
    maxFiles: args.maxFiles,
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
