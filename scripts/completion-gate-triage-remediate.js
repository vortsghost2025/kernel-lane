#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const REPLY_TYPES = new Set([
  'collaboration_response',
  'response',
  'resolution',
  'correction',
  'status-report',
  'report',
  'review',
  'task-completion',
]);

const LANES = {
  archivist: {
    ar: 'S:/Archivist-Agent/lanes/archivist/inbox/action-required',
    pr: 'S:/Archivist-Agent/lanes/archivist/inbox/processed',
    qDup: 'S:/Archivist-Agent/lanes/archivist/inbox/quarantine/duplicates',
    qInv: 'S:/Archivist-Agent/lanes/archivist/inbox/quarantine/invalid-schema',
  },
  kernel: {
    ar: 'S:/kernel-lane/lanes/kernel/inbox/action-required',
    pr: 'S:/kernel-lane/lanes/kernel/inbox/processed',
    qDup: 'S:/kernel-lane/lanes/kernel/inbox/quarantine/duplicates',
    qInv: 'S:/kernel-lane/lanes/kernel/inbox/quarantine/invalid-schema',
  },
  library: {
    ar: 'S:/self-organizing-library/lanes/library/inbox/action-required',
    pr: 'S:/self-organizing-library/lanes/library/inbox/processed',
    qDup: 'S:/self-organizing-library/lanes/library/inbox/quarantine/duplicates',
    qInv: 'S:/self-organizing-library/lanes/library/inbox/quarantine/invalid-schema',
  },
  swarmmind: {
    ar: 'S:/SwarmMind/lanes/swarmmind/inbox/action-required',
    pr: 'S:/SwarmMind/lanes/swarmmind/inbox/processed',
    qDup: 'S:/SwarmMind/lanes/swarmmind/inbox/quarantine/duplicates',
    qInv: 'S:/SwarmMind/lanes/swarmmind/inbox/quarantine/invalid-schema',
  },
};

const COMPLETION_PROOF_FIELDS = [
  'completion_artifact_path',
  'completion_message_id',
  'resolved_by_task_id',
  'terminal_decision',
];

function hasCompletionProof(msg) {
  return COMPLETION_PROOF_FIELDS.some(function (field) {
    var val = msg[field];
    return val !== undefined && val !== null && val !== '' && val !== false;
  });
}

function hasValidSchema(msg) {
  if (typeof msg !== 'object' || msg === null) return false;
  var hasAnyContent = !!(msg.id || msg.task_id || msg.type || msg.subject || msg.from || msg.to || msg.priority);
  return hasAnyContent;
}

function isDuplicateFile(filename) {
  return filename.includes('.recovered-');
}

function chooseNewType(originalType) {
  if (!originalType) return 'notification';
  if (REPLY_TYPES.has(originalType)) return 'response';
  return 'notification';
}

function parseArgs() {
  var args = process.argv.slice(2);
  return { apply: args.includes('--apply') };
}

function remediateLane(laneName, cfg, apply) {
  var result = {
    lane: laneName,
    scanned: 0,
    duplicates_moved: 0,
    invalid_moved: 0,
    retyped: 0,
    already_valid: 0,
    failures: [],
  };

  if (!fs.existsSync(cfg.ar)) return result;

  if (apply) {
    fs.mkdirSync(cfg.qDup, { recursive: true });
    fs.mkdirSync(cfg.qInv, { recursive: true });
  }

  var files = fs.readdirSync(cfg.ar).filter(function (f) { return f.endsWith('.json'); });
  result.scanned = files.length;

  // Two-pass: first pass identifies same-id duplicates, second pass processes
  // Pass 1: build id map, identify which files to treat as duplicates
  var idMap = {};
  var duplicateFiles = new Set();
  for (var j = 0; j < files.length; j++) {
    if (isDuplicateFile(files[j])) continue;
    var tempMsg;
    try { tempMsg = JSON.parse(fs.readFileSync(path.join(cfg.ar, files[j]), 'utf8')); } catch { continue; }
    var mid = tempMsg.id || tempMsg.task_id || null;
    if (!mid) continue;
    if (!idMap[mid]) idMap[mid] = [];
    idMap[mid].push(files[j]);
  }
  for (var mid2 in idMap) {
    if (idMap[mid2].length > 1) {
      // Keep the first (most original), mark rest as duplicates
      for (var k = 1; k < idMap[mid2].length; k++) {
        duplicateFiles.add(idMap[mid2][k]);
      }
    }
  }

  for (var i = 0; i < files.length; i++) {
    var filename = files[i];
    var src = path.join(cfg.ar, filename);

    var msg;
    try {
      msg = JSON.parse(fs.readFileSync(src, 'utf8'));
    } catch (e) {
      result.failures.push({ file: filename, error: 'PARSE_ERROR: ' + e.message });
      continue;
    }

    // Step 1: Move duplicates to quarantine/duplicates/
    if (isDuplicateFile(filename) || duplicateFiles.has(filename)) {
      if (apply) {
        var dest = path.join(cfg.qDup, filename);
        if (fs.existsSync(dest)) {
          var stamp = new Date().toISOString().replace(/[:.]/g, '-');
          dest = path.join(cfg.qDup, filename.replace('.json', '.' + stamp + '.json'));
        }
        fs.renameSync(src, dest);
      }
      result.duplicates_moved++;
      continue;
    }

    // Step 2: Move invalid schema to quarantine/invalid-schema/
    if (!hasValidSchema(msg)) {
      if (apply) {
        var dest2 = path.join(cfg.qInv, filename);
        if (fs.existsSync(dest2)) {
          var stamp2 = new Date().toISOString().replace(/[:.]/g, '-');
          dest2 = path.join(cfg.qInv, filename.replace('.json', '.' + stamp2 + '.json'));
        }
        fs.renameSync(src, dest2);
      }
      result.invalid_moved++;
      continue;
    }

    // Step 3: Retype stale completed messages
    // These have completion proof but non-terminal type
    if (hasCompletionProof(msg) && msg.type !== 'ack' && msg.type !== 'acknowledgment' &&
        msg.type !== 'heartbeat' && msg.type !== 'notification' && msg.type !== 'response') {
      var originalType = msg.type;
      var newType = chooseNewType(originalType);

      msg.retyped_from = originalType || 'null';
      msg.retyped_reason = 'historical_completed_nonterminal_type';
      msg.requires_action = false;
      msg.type = newType;

      // Remove gate block metadata (no longer relevant after retype)
      delete msg._completion_gate_blocked;
      delete msg._completion_gate_blocked_at;
      delete msg._completion_gate_blocked_reason;

      if (apply) {
        // Write retyped message back to action-required/ first
        fs.writeFileSync(src, JSON.stringify(msg, null, 2) + '\n', 'utf8');

        // Now move to processed/ (gate will permit it)
        var dest3 = path.join(cfg.pr, filename);
        if (fs.existsSync(dest3)) {
          var stamp3 = new Date().toISOString().replace(/[:.]/g, '-');
          dest3 = path.join(cfg.pr, filename.replace('.json', '.retyped-' + stamp3 + '.json'));
        }
        fs.renameSync(src, dest3);
      }
      result.retyped++;
      continue;
    }

    // If we get here, message has valid schema and is not stale
    result.already_valid++;
  }

  return result;
}

(function main() {
  var args = parseArgs();
  var summary = {
    mode: args.apply ? 'APPLY' : 'DRY_RUN',
    timestamp: new Date().toISOString(),
    lanes: [],
    totals: {
      scanned: 0,
      duplicates_moved: 0,
      invalid_moved: 0,
      retyped: 0,
      already_valid: 0,
      failures: 0,
    },
  };

  for (var ln of Object.keys(LANES)) {
    var r = remediateLane(ln, LANES[ln], args.apply);
    summary.lanes.push(r);
    summary.totals.scanned += r.scanned;
    summary.totals.duplicates_moved += r.duplicates_moved;
    summary.totals.invalid_moved += r.invalid_moved;
    summary.totals.retyped += r.retyped;
    summary.totals.already_valid += r.already_valid;
    summary.totals.failures += r.failures.length;
  }

  console.log(JSON.stringify(summary, null, 2));

  if (summary.totals.failures > 0) {
    process.exit(20);
  }
})();
