#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const BROADCAST_DIR = 'S:/Archivist-Agent/lanes/broadcast';
const INTENT_FILE = path.join(BROADCAST_DIR, 'edit-intents.jsonl');

const LEASE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const HEARTBEAT_INTERVAL_MS = 60 * 1000; // 1 minute

function now() { return new Date().toISOString(); }

function loadIntents() {
  if (!fs.existsSync(INTENT_FILE)) return [];
  return fs.readFileSync(INTENT_FILE, 'utf8')
    .split('\n')
    .filter(l => l.trim())
    .map(l => { try { return JSON.parse(l); } catch(e) { return null; } })
    .filter(Boolean);
}

function saveIntents(intents) {
  fs.writeFileSync(INTENT_FILE, intents.map(i => JSON.stringify(i)).join('\n') + '\n');
}

function claim(lane, file, scope, action, mode, reasonClass) {
  const nowTs = now();
  const intent = {
    lane,
    file,
    scope: scope || { type: 'file', value: file.split('/').pop() },
    action: action || 'modify',
    mode: mode || 'exclusive',
    status: 'planning',
    claimed_at: nowTs,
    expires_at: new Date(Date.now() + LEASE_TTL_MS).toISOString(),
    reason_class: reasonClass || 'general',
    content_hidden: true,
    heartbeat_at: nowTs
  };

  const intents = loadIntents();
  
  // Check for conflicts
  const conflicts = checkConflicts(intent, intents);
  if (conflicts.length > 0 && mode === 'exclusive') {
    return { success: false, conflicts, intent: null };
  }

  intents.push(intent);
  saveIntents(intents);
  return { success: true, intent };
}

function checkConflicts(newIntent, intents) {
  const now = Date.now();
  return intents.filter(i => {
    if (i.status === 'done' || i.status === 'abandoned') return false;
    if (new Date(i.expires_at).getTime() < now) return false;
    if (i.file !== newIntent.file) return false;
    if (i.mode === 'exclusive' && newIntent.mode === 'exclusive') return true;
    
    // Check scope overlap
    if (i.scope.type === 'symbol' && newIntent.scope.type === 'symbol') {
      return i.scope.value === newIntent.scope.value;
    }
    return false;
  });
}

function heartbeat(lane, file) {
  const intents = loadIntents();
  let updated = false;
  const nowTs = now();
  
  for (const i of intents) {
    if (i.lane === lane && i.file === file && i.status !== 'done' && i.status !== 'abandoned') {
      i.heartbeat_at = nowTs;
      i.expires_at = new Date(Date.now() + LEASE_TTL_MS).toISOString();
      i.status = 'editing';
      updated = true;
    }
  }
  
  if (updated) saveIntents(intents);
  return updated;
}

function release(lane, file, status = 'done') {
  const intents = loadIntents();
  let updated = false;
  
  for (const i of intents) {
    if (i.lane === lane && i.file === file) {
      i.status = status;
      i.expires_at = now();
      updated = true;
    }
  }
  
  if (updated) saveIntents(intents);
  return updated;
}

function getActiveClaims(file = null) {
  const intents = loadIntents();
  const now = Date.now();
  return intents.filter(i => {
    if (i.status === 'done' || i.status === 'abandoned') return false;
    if (new Date(i.expires_at).getTime() < now) return false;
    if (file && i.file !== file) return false;
    return true;
  });
}

function checkCollision(lane, file, scope = null) {
  const active = getActiveClaims(file);
  const conflicts = active.filter(i => {
    if (i.lane === lane) return false;
    if (i.mode === 'exclusive') return true;
    if (scope && i.scope && scope.value !== i.scope.value) return false;
    return true;
  });
  
  return {
    has_conflict: conflicts.length > 0,
    conflicts: conflicts.map(c => ({
      lane: c.lane,
      mode: c.mode,
      scope: c.scope,
      expires_at: c.expires_at
    }))
  };
}

// CLI
const args = process.argv.slice(2);
const cmd = args[0];

if (cmd === 'claim') {
  const lane = args[1];
  const file = args[2];
  const reason = args[3] || 'general';
  const result = claim(lane, file, null, 'modify', 'exclusive', reason);
  console.log(JSON.stringify(result, null, 2));
} else if (cmd === 'heartbeat') {
  const lane = args[1];
  const file = args[2];
  const result = heartbeat(lane, file);
  console.log(JSON.stringify({ success: result }));
} else if (cmd === 'release') {
  const lane = args[1];
  const file = args[2];
  const result = release(lane, file);
  console.log(JSON.stringify({ success: result }));
} else if (cmd === 'check') {
  const lane = args[1];
  const file = args[2];
  const result = checkCollision(lane, file);
  console.log(JSON.stringify(result, null, 2));
} else if (cmd === 'active') {
  const file = args[1] || null;
  const result = getActiveClaims(file);
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log('Usage:');
  console.log('  node edit-lease-manager.js claim <lane> <file> [reason]');
  console.log('  node edit-lease-manager.js heartbeat <lane> <file>');
  console.log('  node edit-lease-manager.js release <lane> <file>');
  console.log('  node edit-lease-manager.js check <lane> <file>');
  console.log('  node edit-lease-manager.js active [file]');
}

module.exports = { claim, heartbeat, release, checkCollision, getActiveClaims };
