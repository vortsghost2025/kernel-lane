#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const LANE_ROOTS = {
  archivist: 'S:/Archivist-Agent',
  kernel: 'S:/kernel-lane',
  library: 'S:/self-organizing-library',
  swarmmind: 'S:/SwarmMind'
};

function runCheck(name, cmd, cwd) {
  try {
    const output = execSync(cmd, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    return { name, ok: true, output: output.trim() };
  } catch (e) {
    return { name, ok: false, output: e.stdout || '', error: e.stderr || e.message };
  }
}

function checkLane(laneId) {
  const root = LANE_ROOTS[laneId];
  if (!root || !fs.existsSync(root)) {
    return { lane: laneId, ok: false, error: 'LANE_ROOT_NOT_FOUND' };
  }

  const results = { lane: laneId, ok: true, checks: [] };

  // Check 1: cross-lane-sync-gate
  const gateResult = runCheck('cross-lane-sync-gate', 'node scripts/cross-lane-sync-gate.js check', root);
  results.checks.push(gateResult);
  if (!gateResult.ok) results.ok = false;

  // Check 2: evidence-exchange-check
  const evidenceResult = runCheck('evidence-exchange-check', 'node scripts/evidence-exchange-check.js ' + root, root);
  results.checks.push(evidenceResult);
  if (!evidenceResult.ok) results.ok = false;

  // Check 3: identity-enforcer
  const idResult = runCheck('identity-enforcer', 'node scripts/identity-enforcer.js enforce', root);
  results.checks.push(idResult);
  if (!idResult.ok) results.ok = false;

  return results;
}

function main() {
  const args = process.argv.slice(2);
  const lanes = args.length > 0 ? args : Object.keys(LANE_ROOTS);
  
  const results = { timestamp: new Date().toISOString(), lanes: {}, overall_ok: true };
  
  for (const laneId of lanes) {
    const result = checkLane(laneId);
    results.lanes[laneId] = result;
    if (!result.ok) results.overall_ok = false;
  }

  const reportPath = path.join('S:/Archivist-Agent', 'docs', 'autonomous-cycle-test', 'ci-check-report.json');
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));

  process.exit(results.overall_ok ? 0 : 1);
}

if (require.main === module) {
  main();
}
