#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const TERMINAL_TYPES = new Set([
  'ack',
  'acknowledgment',
  'heartbeat',
  'notification',
  'response',
]);

const COMPLETION_PROOF_FIELDS = [
  'completion_artifact_path',
  'completion_message_id',
  'resolved_by_task_id',
  'terminal_decision',
];

function hasCompletionProof(msg) {
  if (typeof msg !== 'object' || msg === null) return false;
  return COMPLETION_PROOF_FIELDS.some(field => {
    const val = msg[field];
    return val !== undefined && val !== null && val !== '' && val !== false;
  });
}

function hasFollowupObligation(msg) {
  if (typeof msg !== 'object' || msg === null) return false;
  return !!(msg.depends_on || msg.creates_followup || msg.links_to_contradiction);
}

function isActionable(msg) {
  if (typeof msg !== 'object' || msg === null) return false;
  return msg.requires_action === true;
}

function isTerminalInformational(msg) {
  if (typeof msg !== 'object' || msg === null) return false;
  if (msg.requires_action !== false) return false;
  const type = String(msg.type || '').toLowerCase().trim();
  if (!TERMINAL_TYPES.has(type)) return false;
  if (hasFollowupObligation(msg)) return false;
  return true;
}

function evaluate(msg) {
  if (typeof msg !== 'object' || msg === null) {
    return { pass: false, reason: 'INVALID_MESSAGE', detail: 'Message is null or not an object' };
  }

  if (isActionable(msg)) {
    if (hasCompletionProof(msg)) {
      return { pass: true, reason: 'ACTIONABLE_WITH_PROOF', detail: null };
    }
    return {
      pass: false,
      reason: 'ACTIONABLE_MISSING_PROOF',
      detail: 'Actionable message (type=' + msg.type + ', priority=' + msg.priority + ') requires one of: ' + COMPLETION_PROOF_FIELDS.join(', '),
    };
  }

  if (isTerminalInformational(msg)) {
    return { pass: true, reason: 'TERMINAL_INFORMATIONAL', detail: null };
  }

  if (msg.requires_action === false && !TERMINAL_TYPES.has(String(msg.type || '').toLowerCase().trim())) {
    return {
      pass: false,
      reason: 'NON_TERMINAL_TYPE',
      detail: 'type="' + msg.type + '" is not a terminal type. Terminal types: ' + [...TERMINAL_TYPES].join(', '),
    };
  }

  if (msg.requires_action === false && hasFollowupObligation(msg)) {
    return {
      pass: false,
      reason: 'HAS_FOLLOWUP_OBLIGATION',
      detail: 'Message has followup obligation (depends_on=' + !!msg.depends_on + ', creates_followup=' + !!msg.creates_followup + ', links_to_contradiction=' + !!msg.links_to_contradiction + ')',
    };
  }

  if (msg.requires_action === undefined || msg.requires_action === null) {
    return {
      pass: false,
      reason: 'AMBIGUOUS_REQUIRES_ACTION',
      detail: 'requires_action is ' + msg.requires_action + ' -- must be explicitly true or false',
    };
  }

  return {
    pass: false,
    reason: 'UNKNOWN_FAILURE',
    detail: 'Message does not meet any gate criteria (requires_action=' + msg.requires_action + ', type=' + msg.type + ')',
  };
}

const LANES = {
  archivist: {
    processed: 'S:/Archivist-Agent/lanes/archivist/inbox/processed',
    actionRequired: 'S:/Archivist-Agent/lanes/archivist/inbox/action-required',
  },
  kernel: {
    processed: 'S:/kernel-lane/lanes/kernel/inbox/processed',
    actionRequired: 'S:/kernel-lane/lanes/kernel/inbox/action-required',
  },
  library: {
    processed: 'S:/self-organizing-library/lanes/library/inbox/processed',
    actionRequired: 'S:/self-organizing-library/lanes/library/inbox/action-required',
  },
  swarmmind: {
    processed: 'S:/SwarmMind/lanes/swarmmind/inbox/processed',
    actionRequired: 'S:/SwarmMind/lanes/swarmmind/inbox/action-required',
  },
};

function safeReadJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function uniqueTargetPath(basePath) {
  if (!fs.existsSync(basePath)) return basePath;
  const dir = path.dirname(basePath);
  const ext = path.extname(basePath);
  const base = path.basename(basePath, ext);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(dir, base + '.gate-blocked-' + stamp + ext);
}

function parseArgs() {
  const args = process.argv.slice(2);
  return {
    apply: args.includes('--apply'),
    lane: (function () {
      const idx = args.indexOf('--lane');
      if (idx >= 0 && args[idx + 1]) return args[idx + 1].toLowerCase();
      return null;
    })(),
  };
}

function gateLane(laneName, cfg, apply) {
  const result = {
    lane: laneName,
    processedPath: cfg.processed,
    actionRequiredPath: cfg.actionRequired,
    scanned: 0,
    blocked: 0,
    allowed: 0,
    lifecycle_violations: [],
    terminal_messages_verified: 0,
    actionable_with_proof: 0,
  };

  if (!fs.existsSync(cfg.processed)) {
    return result;
  }

  if (apply && !fs.existsSync(cfg.actionRequired)) {
    fs.mkdirSync(cfg.actionRequired, { recursive: true });
  }

  const files = fs.readdirSync(cfg.processed).filter(function (f) { return f.endsWith('.json'); });
  result.scanned = files.length;

  for (const filename of files) {
    const src = path.join(cfg.processed, filename);
    const msg = safeReadJson(src);
    if (!msg) continue;

    const verdict = evaluate(msg);

    if (verdict.pass) {
      result.allowed += 1;
      if (verdict.reason === 'TERMINAL_INFORMATIONAL') {
        result.terminal_messages_verified += 1;
      } else if (verdict.reason === 'ACTIONABLE_WITH_PROOF') {
        result.actionable_with_proof += 1;
      }
    } else {
      result.blocked += 1;
      result.lifecycle_violations.push({
        file: filename,
        id: msg.id || msg.task_id || null,
        type: msg.type || null,
        priority: msg.priority || null,
        requires_action: msg.requires_action,
        reason: verdict.reason,
        detail: verdict.detail,
        subject: (msg.subject || '').substring(0, 80),
      });

      if (apply) {
        msg._completion_gate_blocked = true;
        msg._completion_gate_blocked_at = new Date().toISOString();
        msg._completion_gate_blocked_reason = verdict.reason;
        fs.writeFileSync(src, JSON.stringify(msg, null, 2));
        const dest = uniqueTargetPath(path.join(cfg.actionRequired, filename));
        fs.renameSync(src, dest);
      }
    }
  }

  return result;
}

(function main() {
  const args = parseArgs();
  const laneNames = args.lane ? [args.lane] : Object.keys(LANES);
  for (const ln of laneNames) {
    if (!LANES[ln]) {
      console.error('Unknown lane: ' + ln);
      process.exit(2);
    }
  }

  const summary = {
    mode: args.apply ? 'APPLY' : 'DRY_RUN',
    timestamp: new Date().toISOString(),
    lanes: [],
    totals: {
      scanned: 0,
      allowed: 0,
      blocked: 0,
      lifecycle_violations: 0,
      terminal_messages_verified: 0,
      actionable_with_proof: 0,
    },
  };

  for (const ln of laneNames) {
    const r = gateLane(ln, LANES[ln], args.apply);
    summary.lanes.push(r);
    summary.totals.scanned += r.scanned;
    summary.totals.allowed += r.allowed;
    summary.totals.blocked += r.blocked;
    summary.totals.lifecycle_violations += r.lifecycle_violations.length;
    summary.totals.terminal_messages_verified += r.terminal_messages_verified;
    summary.totals.actionable_with_proof += r.actionable_with_proof;
  }

  summary.processed_ok = summary.totals.blocked === 0;

  console.log(JSON.stringify(summary, null, 2));

  if (!args.apply && summary.totals.blocked > 0) {
    process.exit(10);
  }
  if (args.apply && summary.totals.blocked > 0) {
    process.exit(20);
  }
})();
