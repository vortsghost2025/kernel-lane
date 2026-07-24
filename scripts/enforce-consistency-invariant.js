#!/usr/bin/env node
/**
 * enforce-consistency-invariant.js
 * Hard invariant: System may NOT claim "consistent" when contradictions.length > 0
 * Run by each lane during health check
 * Usage: node enforce-consistency-invariant.js [lane-name]
 */

const fs = require('fs');
const path = require('path');

const LANE_ROOTS = {
  archivist: 'S:/Archivist-Agent',
  kernel: 'S:/kernel-lane',
  library: 'S:/self-organizing-library',
  swarmmind: 'S:/SwarmMind'
};

const BROADCAT_PATH = 'S:/Archivist-Agent/lanes/broadcast';

function loadJSON(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (_) { return null; }
}

function enforceInvariant(laneId, root) {
  console.log(`\n[${laneId}] Enforcing consistency invariant...`);
  
  // 1. Load system state
  const statePath = path.join(BROADCAT_PATH, 'system_state.json');
  const state = loadJSON(statePath);
  
  if (!state) {
    console.error(`[${laneId}] Cannot load system_state.json`);
    process.exit(1);
  }
  
  // 2. Load contradictions
  const contraPath = path.join(BROADCAT_PATH, 'contradictions.json');
  const contradictions = loadJSON(contraPath);
  const activeContra = contradictions ? contradictions.filter(c => c.status === 'active') : [];
  const contraCount = activeContra.length;
  
  console.log(`[${laneId}] System status: ${state.system_status}`);
  console.log(`[${laneId}] Active contraditions: ${contraCount}`);
  if (contraCount > 0) {
    console.log(`[${laneId}] Active contraditions: ${activeContra.map(c => c.id).join(', ')}`);
  }
  
  // 3. HARD INVARIANT: System may NOT claim "aligned" or "consistent" when contradictions exist
  const allowedStatus = ['degraded', 'inconsistent', 'alignment_pending'];
  if (contraCount > 0 && allowedStatus.includes(state.system_status)) {
    console.log(`[${laneId}] ✅ System status '${state.system_status}' correctly reflects contraditions`);
  } else if (contraCount > 0 && !allowedStatus.includes(state.system_status)) {
    console.error(`[${laneId}] ❌ INVARIANT VIOLATION - ${contraCount} active contraditions but system_status='${state.system_status}'`);
    
  // Fix: report violation — only heartbeat.js may write system_state.json
  console.error(`[${laneId}] INVARIANT: Only heartbeat.js may write system_state.json. No auto-fix applied. Heartbeat will correct on next cycle.`);
  process.exit(1);
  }
  
  // 4. Check for P0 contradictions - system must not be "aligned"
  const p0Contra = activeContra.filter(c => c.priority === 'P0');
  if (p0Contra.length > 0) {
    console.error(`[${laneId}] ❌ P0 CONTRADICTION(S): ${p0Contra.map(c => c.id).join(', ')}`);
    console.error(`[${laneId}] System must remain 'degraded' until P0 contraditions resolved`);
    process.exit(1);
  }
  
  // 5. Check compaction status
  if (state.compaction_enabled === true) {
    console.error(`[${laneId}] ❌ INVARIANT VIOLATION - compaction enabled while contraditions exist`);
    console.error(`[${laneId}] INVARIANT: Only heartbeat.js may write system_state.json. No auto-fix applied. Heartbeat will correct on next cycle.`);
    process.exit(1);
  }
  
  console.log(`[${laneId}] ✅ Invariant check passed - system status reflects truth`);
  process.exit(0);
}

const laneArg = process.argv[2];

if (laneArg && LANE_ROOTS[laneArg]) {
  enforceInvariant(laneArg, LANE_ROOTS[laneArg]);
} else {
  // Run on all lanes
  let hasViolation = false;
  for (const [laneId, root] of Object.entries(LANE_ROOTS)) {
    try {
      enforceInvariant(laneId, root);
    } catch (e) {
      console.error(`[${laneId}] Error: ${e.message}`);
      hasViolation = true;
    }
  }
  
  if (hasViolation) {
    console.error('\n❌ Hard invariant violations detected across lanes');
    process.exit(1);
  } else {
    console.log('\n✅ All lanes pass consistency invariant');
    process.exit(0);
  }
}
