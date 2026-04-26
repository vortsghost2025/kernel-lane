#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const BROADCAST_DIR = 'S:/Archivist-Agent/lanes/broadcast';
const INTENT_FILE = path.join(BROADCAST_DIR, 'edit-intents.jsonl');

function getActiveIntents() {
  if (!fs.existsSync(INTENT_FILE)) return [];
  return fs.readFileSync(INTENT_FILE, 'utf8')
    .split('\n')
    .filter(l => l.trim())
    .map(l => { try { return JSON.parse(l); } catch(e) { return null; } })
    .filter(Boolean)
    .filter(i => {
      if (i.status === 'done' || i.status === 'abandoned') return false;
      if (new Date(i.expires_at).getTime() < Date.now()) return false;
      return true;
    });
}

function detectOverlap(intentA, intentB) {
  if (intentA.file !== intentB.file) return false;
  
  // Same file - check scope
  const aScope = intentA.scope?.value || 'file';
  const bScope = intentB.scope?.value || 'file';
  
  // Same scope = overlap
  if (aScope === bScope) return true;
  
  // Exclusive mode always conflicts
  if (intentA.mode === 'exclusive' || intentB.mode === 'exclusive') return true;
  
  return false;
}

function classifySeverity(lane, intent, conflicts) {
  if (conflicts.length === 0) return 'none';
  
  const exclusiveConflicts = conflicts.filter(c => c.mode === 'exclusive');
  
  if (exclusiveConflicts.length > 0) {
    // Check if another lane has exclusive
    const otherExclusive = exclusiveConflicts.find(c => c.lane !== lane);
    if (otherExclusive) return 'hard-conflict';
    return 'soft-conflict';
  }
  
  return 'safe-parallel';
}

function preEditCheck(lane, file, scope = null) {
  const intents = getActiveIntents();
  
  // Find intents for this file
  const fileIntents = intents.filter(i => i.file === file);
  
  // Find conflicts
  const conflicts = fileIntents.filter(i => {
    if (i.lane === lane) return false;
    return detectOverlap({ lane, file, scope, mode: 'exclusive' }, i);
  });
  
  const severity = classifySeverity(lane, { scope }, conflicts);
  
  const result = {
    lane,
    file,
    scope: scope?.value || 'file',
    has_conflict: conflicts.length > 0,
    severity,
    conflicts: conflicts.map(c => ({
      lane: c.lane,
      mode: c.mode,
      scope: c.scope,
      reason_class: c.reason_class,
      expires_at: c.expires_at
    })),
    recommended_action: severity === 'none' ? 'proceed' 
      : severity === 'hard-conflict' ? 'block'
      : 'wait-or-reroute',
    timestamp: new Date().toISOString()
  };
  
  return result;
}

function requirePreEditCheck(lane, file, scope = null) {
  const result = preEditCheck(lane, file, scope);
  
  if (result.severity === 'hard-conflict') {
    console.error('[COLLISION_BLOCKED]');
    console.error(JSON.stringify(result, null, 2));
    process.exit(1);
  }
  
  if (result.severity === 'soft-conflict') {
    console.warn('[COLLISION_WARNING]');
    console.warn(JSON.stringify(result, null, 2));
  }
  
  console.log('[COLLISION_CHECK_PASSED]');
  console.log(JSON.stringify(result, null, 2));
  return result;
}

// CLI
const args = process.argv.slice(2);
const lane = args[0];
const file = args[1];

if (lane && file) {
  requirePreEditCheck(lane, file);
} else {
  console.log('Usage: node collision-check.js <lane> <file>');
  console.log('Example: node collision-check.js archivist S:/kernel-lane/lanes/broadcast/trust-store.json');
  
  // Show active
  console.log('\nActive claims:');
  const intents = getActiveIntents();
  if (intents.length === 0) {
    console.log('  (none)');
  } else {
    intents.forEach(i => {
      console.log(`  ${i.lane}: ${i.file} [${i.mode}] ${i.status}`);
    });
  }
}

module.exports = { preEditCheck, requirePreEditCheck, getActiveIntents };
