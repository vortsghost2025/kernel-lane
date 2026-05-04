#!/usr/bin/env node
'use strict';

/**
 * CONVERGENCE GATE DAEMON
 *
 * Purpose: Watch outbox directories, validate lane messages, and enforce
 * convergence gate policy — only messages with proven status are delivered
 * to recipient inboxes. All rejections are logged to cps_log.jsonl.
 *
 * Usage:
 *   node convergence-gate-daemon.js [--apply] [--poll-seconds=N] [--json]
 *
 * Options:
 *   --apply          Actually move files (default: dry-run)
 *   --poll-seconds=N Polling interval in seconds (default: 60)
 *   --json           Output results as JSON
 *   --lane=NAME      Process only specified lane's outbox
 *
 * Integration:
 *   - Run as a daemon (e.g., via start-core.js or as a service)
 *   - Or run periodically via cron/Task Scheduler
 *
 * Gate Logic:
 *   1. Schema validation against inbox-message-v1.json
 *   2. convergence_gate.status must be in: proven, approved, ratified, accepted
 *   3. Signature and key_id must be present and valid format
 *   4. Required fields must be present
 *
 * Rejection reasons are logged to logs/cps_log.jsonl with full context.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { LaneDiscovery } = require('./util/lane-discovery');

// ── Configuration ────────────────────────────────────────────────────────────

const laneDiscovery = new LaneDiscovery();
const CANONICAL_INBOX = {};
const LANE_ROOTS = {};
try {
  for (const laneId of laneDiscovery.listLanes()) {
    CANONICAL_INBOX[laneId] = laneDiscovery.getInbox(laneId);
    LANE_ROOTS[laneId] = laneDiscovery.getLocalPath(laneId);
  }
} catch (e) {
  // Fallback if lane-discovery fails
  console.error('[convergence-gate] WARNING: lane-discovery failed, using hardcoded paths');
  LANE_ROOTS.archivist = 'S:/Archivist-Agent';
  LANE_ROOTS.kernel = 'S:/kernel-lane';
  LANE_ROOTS.library = 'S:/self-organizing-library';
  LANE_ROOTS.swarmmind = 'S:/SwarmMind';
  CANONICAL_INBOX.archivist = 'S:/Archivist-Agent/lanes/archivist/inbox';
  CANONICAL_INBOX.kernel = 'S:/kernel-lane/lanes/kernel/inbox';
  CANONICAL_INBOX.library = 'S:/self-organizing-library/lanes/library/inbox';
  CANONICAL_INBOX.swarmmind = 'S:/SwarmMind/lanes/swarmmind/inbox';
}

const SCHEMA_PATH = path.join(__dirname, '..', 'schemas', 'inbox-message-v1.json');
const CPS_LOG_PATH = path.join(__dirname, '..', 'logs', 'cps_log.jsonl');

const DEFAULT_CONFIG = {
  dryRun: true,
  pollSeconds: 60,
  jsonOutput: false,
  laneFilter: null, // null = all lanes, or specific lane name
  acceptedStatuses: ['proven', 'approved', 'ratified', 'accepted'],
  quarantineDirName: 'quarantine',
  processedDirName: 'processed',
  signatureRequired: true
};

// ── Utilities ────────────────────────────────────────────────────────────────

function nowIso() { return new Date().toISOString(); }

function safeReadJson(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    return { ok: true, value: JSON.parse(content) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function safeWriteJson(filePath, obj, ensureDir = true) {
  try {
    if (ensureDir) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
    }
    fs.writeFileSync(filePath, JSON.stringify(obj, null, 2), 'utf8');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function appendCpsLog(entry) {
  try {
    const logLine = JSON.stringify({
      timestamp: nowIso(),
      ...entry
    }) + '\n';
    fs.mkdirSync(path.dirname(CPS_LOG_PATH), { recursive: true });
    fs.appendFileSync(CPS_LOG_PATH, logLine, 'utf8');
    return true;
  } catch (err) {
    console.error('[convergence-gate] FAILED to write CPS log:', err.message);
    return false;
  }
}

function loadSchema() {
  if (!fs.existsSync(SCHEMA_PATH)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));
  } catch (e) {
    return null;
  }
}

// Minimal schema validation (no external deps)
function validateSchema(data, schema) {
  const errors = [];

  function validate(value, node, pathStr) {
    if (value === null || value === undefined) {
      if (node.required && node.required.includes(pathStr.split('.').pop())) {
        errors.push(`${pathStr}: required field missing`);
      }
      return;
    }

    // Type check
    if (node.type) {
      const types = Array.isArray(node.type) ? node.type : [node.type];
      let actualType = typeof value;
      if (Array.isArray(value)) actualType = 'array';
      else if (value instanceof Buffer) actualType = 'string'; // crude

      const matched = types.some(t => {
        if (t === 'integer') return Number.isInteger(value);
        if (t === 'array') return Array.isArray(value);
        if (t === 'object') return typeof value === 'object' && !Array.isArray(value);
        return t === actualType;
      });
      if (!matched) {
        errors.push(`${pathStr}: expected ${types.join('|')}, got ${actualType}`);
      }
    }

    // Enum check
    if (node.enum && !node.enum.includes(value)) {
      errors.push(`${pathStr}: value "${value}" not in enum [${node.enum.join(', ')}]`);
    }

    // Required check for objects
    if (node.required && typeof value === 'object' && !Array.isArray(value)) {
      for (const reqField of node.required) {
        if (!(reqField in value)) {
          errors.push(`${pathStr}.${reqField}: required field missing`);
        }
      }
    }

    // Properties recursive validation
    if (node.properties && typeof value === 'object' && !Array.isArray(value)) {
      for (const [propName, propSchema] of Object.entries(node.properties)) {
        if (value.hasOwnProperty(propName)) {
          validate(value[propName], propSchema, `${pathStr}.${propName}`);
        }
      }
    }

    // Items for arrays
    if (node.items && Array.isArray(value)) {
      value.forEach((item, idx) => validate(item, node.items, `${pathStr}[${idx}]`));
    }

    // Pattern check for strings
    if (node.pattern && typeof value === 'string') {
      const re = new RegExp(node.pattern);
      if (!re.test(value)) {
        errors.push(`${pathStr}: string doesn't match pattern ${node.pattern}`);
      }
    }

    // Format: date-time
    if (node.format === 'date-time' && typeof value === 'string') {
      if (isNaN(Date.parse(value))) {
        errors.push(`${pathStr}: invalid date-time format`);
      }
    }
  }

  validate(data, schema, 'root');
  return errors;
}

// Convergence gate check
function checkConvergenceGate(msg) {
  if (!msg.convergence_gate || typeof msg.convergence_gate !== 'object') {
    return { pass: false, reason: 'MISSING_CONVERGENCE_GATE', status: null };
  }

  const status = String(msg.convergence_gate.status || '').toLowerCase();
  if (!CONFIG.acceptedStatuses.includes(status)) {
    return { pass: false, reason: 'STATUS_NOT_PROVEN', status };
  }

  // Additional convergence gate structure validation
  const cg = msg.convergence_gate;
  if (!cg.claim) return { pass: false, reason: 'CONVERGENCE_GATE_MISSING_CLAIM', status };
  if (!cg.evidence) return { pass: false, reason: 'CONVERGENCE_GATE_MISSING_EVIDENCE', status };
  if (!cg.verified_by) return { pass: false, reason: 'CONVERGENCE_GATE_MISSING_VERIFIED_BY', status };
  if (!Array.isArray(cg.contradictions)) return { pass: false, reason: 'CONVERGENCE_GATE_MISSING_CONTRADICTIONS', status };

  return { pass: true, reason: 'PROVEN', status };
}

// Signature validation (basic format checks)
function validateSignature(msg) {
  if (!CONFIG.signatureRequired) return { valid: true, errors: [] };

  const errors = [];
  if (!msg.signature || typeof msg.signature !== 'string' || msg.signature.length < 10) {
    errors.push('MISSING_OR_INVALID_SIGNATURE');
  }
  if (!msg.key_id || typeof msg.key_id !== 'string' || !/^[a-f0-9]{16}$/.test(msg.key_id)) {
    errors.push('MISSING_OR_INVALID_KEY_ID');
  }
  return { valid: errors.length === 0, errors };
}

// Determine recipient's canonical inbox path
function getRecipientInbox(toLane) {
  if (!toLane || !CANONICAL_INBOX[toLane]) {
    return null;
  }
  return CANONICAL_INBOX[toLane];
}

// ── File Processing ──────────────────────────────────────────────────────────

function processMessage(filePath, filename, schema) {
  const read = safeReadJson(filePath);
  if (!read.ok) {
    return {
      file: filename,
      pass: false,
      reasons: ['PARSE_ERROR: ' + read.error],
      msg: null
    };
  }

  const msg = read.value;

  // 1. Schema validation
  const schemaErrors = validateSchema(msg, schema);
  if (schemaErrors.length > 0) {
    return {
      file: filename,
      pass: false,
      reasons: ['SCHEMA_VALIDATION_FAILED', ...schemaErrors],
      msg
    };
  }

  // 2. Signature validation
  const sigResult = validateSignature(msg);
  if (!sigResult.valid) {
    return {
      file: filename,
      pass: false,
      reasons: sigResult.errors,
      msg
    };
  }

  // 3. Convergence gate check
  const cgResult = checkConvergenceGate(msg);
  if (!cgResult.pass) {
    return {
      file: filename,
      pass: false,
      reasons: [cgResult.reason],
      msg,
      convergence_status: cgResult.status
    };
  }

  // All checks passed
  return {
    file: filename,
    pass: true,
    reasons: [],
    msg,
    convergence_status: cgResult.status
  };
}

function processOutbox(laneId, outboxDir, schema, dryRun) {
  if (!fs.existsSync(outboxDir)) {
    return { lane: laneId, scanned: 0, delivered: 0, rejected: 0, errors: [], details: [] };
  }

  const files = fs.readdirSync(outboxDir).filter(f => f.endsWith('.json'));
  const result = {
    lane: laneId,
    scanned: files.length,
    delivered: 0,
    rejected: 0,
    errors: [],
    details: []
  };

  for (const filename of files) {
    const filePath = path.join(outboxDir, filename);
    const processResult = processMessage(filePath, filename, schema);

    if (processResult.pass) {
      const toLane = processResult.msg.to;
      const inboxDir = getRecipientInbox(toLane);
      if (!inboxDir) {
        result.rejected++;
        result.errors.push({ file: filename, error: `Unknown recipient lane: ${toLane}` });
        continue;
      }

      const destPath = path.join(inboxDir, filename);

      if (dryRun) {
        result.delivered++;
        result.details.push({
          file: filename,
          from: laneId,
          to: toLane,
          dest: destPath,
          dry_run: true,
          status: processResult.convergence_status
        });
      } else {
        try {
          fs.mkdirSync(inboxDir, { recursive: true });
          // Atomic move: copy then delete
          fs.copyFileSync(filePath, destPath);
          fs.unlinkSync(filePath);
          result.delivered++;
          result.details.push({
            file: filename,
            from: laneId,
            to: toLane,
            dest: destPath,
            status: processResult.convergence_status
          });
        } catch (err) {
          result.rejected++;
          result.errors.push({ file: filename, error: `DELIVERY_FAILED: ${err.message}` });
        }
      }
    } else {
      result.rejected++;
      // Log rejection to CPS log
      appendCpsLog({
        event: 'MESSAGE_REJECTED',
        lane: laneId,
        file: filename,
        reasons: processResult.reasons,
        msg_id: processResult.msg?.task_id || processResult.msg?.id || null,
        from: processResult.msg?.from || null,
        to: processResult.msg?.to || null,
        convergence_status: processResult.convergence_status || 'none'
      });

      // Move to quarantine (if not applying, just log)
      if (!dryRun) {
        const quarantineDir = path.join(outboxDir, '..', 'quarantine');
        const quarantinePath = path.join(quarantineDir, filename);
        try {
          fs.mkdirSync(quarantineDir, { recursive: true });
          fs.renameSync(filePath, quarantinePath);
        } catch (e) {
          // If move fails, leave file but still log
        }
      }

      result.details.push({
        file: filename,
        status: 'rejected',
        reasons: processResult.reasons
      });
    }
  }

  return result;
}

function runOnce(config) {
  const schema = loadSchema();
  if (!schema) {
    console.error('[convergence-gate] FATAL: Could not load schema from', SCHEMA_PATH);
    process.exit(1);
  }

  const lanesToProcess = config.laneFilter ? [config.laneFilter] : Object.keys(LANE_ROOTS);
  const allResults = [];

  for (const laneId of lanesToProcess) {
    const root = LANE_ROOTS[laneId];
    if (!root) continue;
    const outboxDir = path.join(root, 'lanes', laneId, 'outbox');
    const result = processOutbox(laneId, outboxDir, schema, config.dryRun);
    allResults.push(result);
  }

  return {
    timestamp: nowIso(),
    dry_run: config.dryRun,
    results: allResults
  };
}

// ── CLI / Daemon ─────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = process.argv.slice(2);
  const config = { ...DEFAULT_CONFIG };

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--apply') config.dryRun = false;
    else if (a === '--json') config.jsonOutput = true;
    else if (a.startsWith('--poll-seconds=')) config.pollSeconds = Math.max(1, parseInt(a.split('=')[1]) || 60);
    else if (a === '--daemon') config.daemon = true;
    else if (a.startsWith('--lane=')) config.laneFilter = a.split('=')[1].toLowerCase();
  }

  return config;
}

async function runDaemon(config) {
  console.log(`[convergence-gate] Daemon started: poll=${config.pollSeconds}s dry_run=${config.dryRun} lane=${config.laneFilter || 'all'}`);

  while (true) {
    try {
      const result = runOnce(config);
      if (config.jsonOutput) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        for (const laneResult of result.results) {
          console.log(`[convergence-gate] lane=${laneResult.lane} scanned=${laneResult.scanned} delivered=${laneResult.delivered} rejected=${laneResult.rejected}`);
          if (laneResult.errors.length > 0) {
            for (const e of laneResult.errors) {
              console.log(`    ERROR: ${e.file}: ${e.error}`);
            }
          }
        }
      }
    } catch (err) {
      console.error('[convergence-gate] RUN ERROR:', err.message);
    }

    // Wait before next poll
    await new Promise(resolve => setTimeout(resolve, config.pollSeconds * 1000));
  }
}

function runCli() {
  const config = parseArgs(process.argv.slice(2));

  if (config.daemon) {
    runDaemon(config).catch(err => {
      console.error('[convergence-gate] FATAL:', err.message);
      process.exit(1);
    });
  } else {
    const result = runOnce(config);
    if (config.jsonOutput) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`[convergence-gate] completed: dry_run=${config.dryRun}`);
      for (const laneResult of result.results) {
        console.log(`  lane=${laneResult.lane} scanned=${laneResult.scanned} delivered=${laneResult.delivered} rejected=${laneResult.rejected}`);
        if (laneResult.errors.length > 0) {
          for (const e of laneResult.errors) console.log(`    ERROR: ${e.file}: ${e.error}`);
        }
      }
    }
  }
}

if (require.main === module) {
  runCli();
}

module.exports = {
  runOnce,
  processOutbox,
  checkConvergenceGate,
  validateSchema,
  loadSchema
};
