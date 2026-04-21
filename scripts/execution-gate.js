#!/usr/bin/env node

/**
 * execution-gate.js — Hard execution gate enforcement
 *
 * Reads active-blocker.json and validates proposed actions against
 * the execution-gate-v1.json schema. Returns exit code 0 if allowed,
 * exit code 1 if forbidden.
 *
 * Usage:
 *   node execution-gate.js --action <action> --target <filepath> [--lane <lane>]
 *   node execution-gate.js --status   (prints current blocker state)
 *   node execution-gate.js --verify   (runs blocker resolution verification)
 *
 * This is the ONE place where parallel work becomes impossible.
 * Not discipline. Not review. Structure.
 */

const fs = require('fs');
const path = require('path');

const BROADCAST_DIR = path.resolve(__dirname, '..', 'lanes', 'broadcast');
const BLOCKER_PATH = path.join(BROADCAST_DIR, 'active-blocker.json');
const VIOLATIONS_PATH = path.join(BROADCAST_DIR, 'gate-violations.jsonl');
const GATE_SCHEMA_PATH = path.resolve(__dirname, '..', 'schemas', 'execution-gate-v1.json');

function readBlocker() {
  if (!fs.existsSync(BLOCKER_PATH)) return null;
  try {
    return JSON.parse(fs.readFileSync(BLOCKER_PATH, 'utf8'));
  } catch (e) {
    return { _error: `Cannot parse blocker: ${e.message}` };
  }
}

function logViolation(lane, action, target, reason) {
  const entry = {
    timestamp: new Date().toISOString(),
    lane: lane || 'unknown',
    action,
    target: target || '',
    reason,
    blocker_id: readBlocker()?.id || 'none'
  };
  const line = JSON.stringify(entry) + '\n';
  try {
    fs.appendFileSync(VIOLATIONS_PATH, line, 'utf8');
  } catch (e) {
    // Can't log violation — that's itself a problem, but don't crash
    console.error('[GATE] Cannot write violation log:', e.message);
  }
}

function matchForbidden(target, forbiddenList) {
  if (!forbiddenList || !Array.isArray(forbiddenList)) return null;
  for (const rule of forbiddenList) {
    const pattern = rule.pattern;
    try {
      // Support glob-style patterns with **
      const regexStr = pattern
        .replace(/\*\*/g, '§§')   // preserve **
        .replace(/\*/g, '[^/]*')   // * matches within segment
        .replace(/§§/g, '.*')      // ** matches across segments
        .replace(/\?/g, '[^/]');
      const regex = new RegExp('^' + regexStr + '$', 'i');
      if (regex.test(target)) return rule;
    } catch (e) {
      // Invalid pattern — skip
    }
  }
  return null;
}

function isAllowed(action, target, lane) {
  const blocker = readBlocker();

  // No blocker = all actions allowed
  if (!blocker || blocker.status !== 'active') {
    return { allowed: true, reason: 'no_active_blocker' };
  }

  // Wrong owner lane trying to work on blocker
  if (lane && blocker.owner && lane !== blocker.owner) {
    // Non-owner can still read, but cannot write/commit
    const readOnlyActions = ['read_file', 'search_codebase', 'run_tests', 'grep', 'glob', 'git_log', 'git_diff', 'git_status'];
    if (readOnlyActions.includes(action)) {
      return { allowed: true, reason: 'read_action_permitted_for_non_owner' };
    }
    // Non-owner write — still subject to forbidden patterns
    if (target && blocker.forbidden) {
      const match = matchForbidden(target, blocker.forbidden);
      if (match) {
        return {
          allowed: false,
          reason: `target matches forbidden pattern: ${match.pattern} — ${match.reason}`,
          blocker_id: blocker.id
        };
      }
    }
    // Non-owner write = forbidden unless explicitly allowed
    if (blocker.allowed_actions && blocker.allowed_actions.includes(action)) {
      return { allowed: true, reason: 'explicitly_allowed' };
    }
    return {
      allowed: false,
      reason: `lane '${lane}' is not the blocker owner '${blocker.owner}' — only read actions permitted`,
      blocker_id: blocker.id
    };
  }

  // Read actions are ALWAYS allowed — forbidden patterns only block writes
  const readActions = ['read_file', 'search_codebase', 'run_tests', 'grep', 'glob', 'git_log', 'git_diff', 'git_status'];
  if (readActions.includes(action)) {
    return { allowed: true, reason: 'read_action_always_permitted', blocker_id: blocker.id };
  }

  // Check explicit forbidden patterns (only for write actions)
  if (target && blocker.forbidden) {
    const match = matchForbidden(target, blocker.forbidden);
    if (match) {
      return {
        allowed: false,
        reason: `target matches forbidden pattern: ${match.pattern} — ${match.reason}`,
        blocker_id: blocker.id
      };
    }
  }

  // Check allowed_actions whitelist
  if (blocker.allowed_actions && blocker.allowed_actions.length > 0) {
    if (blocker.allowed_actions.includes(action)) {
      return { allowed: true, reason: 'action_in_whitelist', blocker_id: blocker.id };
    }
    // Action not in whitelist = forbidden
    return {
      allowed: false,
      reason: `action '${action}' not in allowed_actions whitelist: [${blocker.allowed_actions.join(', ')}]`,
      blocker_id: blocker.id
    };
  }

  // No whitelist defined = allow (backwards compatible with old blocker format)
  return { allowed: true, reason: 'no_whitelist_defined', blocker_id: blocker.id };
}

function verify(blocker) {
  if (!blocker || !blocker.verification) {
    return { verified: false, reason: 'no_verification_method_defined' };
  }

  const { method, command, expected } = blocker.verification;

  switch (method) {
    case 'test_pass':
    case 'command_exit_0': {
      if (!command) return { verified: false, reason: 'no_command_defined' };
      try {
        const { execSync } = require('child_process');
        const result = execSync(command, { encoding: 'utf8', timeout: 30000 });
        if (expected && !result.includes(expected)) {
          return { verified: false, reason: `output does not contain '${expected}'`, output: result.slice(0, 200) };
        }
        return { verified: true, output: result.slice(0, 200) };
      } catch (e) {
        return { verified: false, reason: `command failed: ${e.message}` };
      }
    }
    case 'file_absent': {
      if (!command) return { verified: false, reason: 'no_file_path_defined' };
      const exists = fs.existsSync(command);
      return { verified: !exists, reason: exists ? 'file still exists' : 'file absent as expected' };
    }
    case 'manual_review':
      return { verified: false, reason: 'requires_manual_review — cannot auto-verify' };
    default:
      return { verified: false, reason: `unknown verification method: ${method}` };
  }
}

// CLI entry point
const args = process.argv.slice(2);

if (args.includes('--status')) {
  const blocker = readBlocker();
  if (!blocker) {
    console.log(JSON.stringify({ status: 'no_blocker', allowed: 'all' }, null, 2));
    process.exit(0);
  }
  console.log(JSON.stringify({
    status: blocker.status,
    id: blocker.id,
    owner: blocker.owner,
    locked_at: blocker.locked_at,
    allowed_actions: blocker.allowed_actions || '(none defined — backwards compatible)',
    forbidden_count: blocker.forbidden?.length || 0,
    verification: blocker.verification?.method || 'none'
  }, null, 2));
  process.exit(0);
}

if (args.includes('--verify')) {
  const blocker = readBlocker();
  if (!blocker || blocker.status !== 'active') {
    console.log(JSON.stringify({ status: 'no_active_blocker', verified: true }));
    process.exit(0);
  }
  const result = verify(blocker);
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.verified ? 0 : 1);
}

// Main gate check
const actionIdx = args.indexOf('--action');
const targetIdx = args.indexOf('--target');
const laneIdx = args.indexOf('--lane');

if (actionIdx === -1) {
  console.error('Usage: node execution-gate.js --action <action> --target <path> [--lane <lane>]');
  console.error('       node execution-gate.js --status');
  console.error('       node execution-gate.js --verify');
  process.exit(2);
}

const action = args[actionIdx + 1];
const target = targetIdx !== -1 ? args[targetIdx + 1] : '';
const lane = laneIdx !== -1 ? args[laneIdx + 1] : '';

const result = isAllowed(action, target, lane);

if (result.allowed) {
  console.log(JSON.stringify({ gate: 'OPEN', ...result }));
  process.exit(0);
} else {
  console.log(JSON.stringify({ gate: 'CLOSED', ...result }));
  logViolation(lane, action, target, result.reason);
  process.exit(1);
}
