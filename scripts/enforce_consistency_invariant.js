#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');

const STATE_PATH = path.join(__dirname, '..', 'lanes', 'broadcast', 'system_state.json');
const CONTRA_PATH = path.join(__dirname, '..', 'lanes', 'broadcast', 'contradictions.json');

function loadJSON(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (_) { return null; }
}

const state = loadJSON(STATE_PATH);
const contradictions = loadJSON(CONTRA_PATH);

if (!state || !contradictions) {
  console.error('[invariant] Cannot load state or contradictions');
  process.exit(1);
}

// Hard invariant: system may not claim "consistent" or "aligned" if any active contradictions exist
const activeContradictions = contradictions.filter(c => c.status === 'active');
if ((state.status === 'consistent' || state.status === 'aligned') && activeContradictions.length > 0) {
  console.error('[invariant] CONSISTENCY VIOLATION – active contradictions present while system reports', state.status);
  console.error('Active contradictions:', activeContradictions.map(c => c.id));
  state.status = 'inconsistent';
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
  process.exit(1);
}

console.log('[invariant] OK – no consistency violation');
process.exit(0);
