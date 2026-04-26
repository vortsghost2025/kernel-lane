#!/usr/bin/env node
/**
 * start-core.js - Phase 2 Canonical Boot Script
 * 
 * Single entry point for starting the three-lane system.
 * Enforces: validate-system-anchor → health checks → smoke tests
 * 
 * Usage: node scripts/start-core.js [--lane=<lane>]
 * 
 * Exit codes:
 *   0 = success
 *   1 = anchor validation failed
 *   2 = health check failed
 *   3 = smoke test failed
 */

const { spawn } = require('child_process');
const path = require('path');

const ARCHIVIST_ROOT = 'S:/Archivist-Agent';
const LIBRARY_ROOT = 'S:/self-organizing-library';
const SWARMIND_ROOT = 'S:/SwarmMind';

function runCommand(cmd, args, cwd) {
  return new Promise((resolve, reject) => {
    console.log(`[RUN] ${cmd} ${args.join(' ')}`);
    const proc = spawn(cmd, args, { 
      cwd, 
      stdio: 'inherit',
      shell: true 
    });
    
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Command failed with code ${code}`));
    });
    
    proc.on('error', reject);
  });
}

async function validateAnchor() {
  console.log('\n========================================');
  console.log('PHASE 0.5: SYSTEM ANCHOR VALIDATION');
  console.log('========================================\n');
  
  try {
    await runCommand('node', ['scripts/validate-system-anchor.js'], ARCHIVIST_ROOT);
    console.log('\n✅ Anchor validation passed\n');
    return true;
  } catch (e) {
    console.error('\n❌ Anchor validation FAILED');
    console.error('   DO NOT START PRODUCTION RUNTIME');
    console.error('   Fix anchor or runtime before proceeding\n');
    return false;
  }
}

async function startLane(lane, root) {
  console.log(`\n========================================`);
  console.log(`STARTING LANE: ${lane.toUpperCase()}`);
  console.log('========================================\n');
  
  const startScript = lane === 'archivist' 
    ? 'node load-context.js' 
    : 'node scripts/governed-start.js';
  
  try {
    // For now, we'll just validate syntax and existence
    // Full startup would require env vars set
    console.log(`[INFO] Lane ${lane} boot script: ${startScript}`);
    console.log(`[INFO] Root: ${root}`);
    console.log(`✅ ${lane} ready for startup (requires LANE_KEY_PASSPHRASE)`);
    return true;
  } catch (e) {
    console.error(`❌ ${lane} startup failed:`, e.message);
    return false;
  }
}

async function runHealthChecks() {
  console.log('\n========================================');
  console.log('HEALTH CHECKS');
  console.log('========================================\n');
  
  // In lane_single_process mode, health checks are file-based
  const checks = [
    { name: 'Trust Store', path: `${ARCHIVIST_ROOT}/.trust/keys.json` },
    { name: 'System Anchor', path: `${ARCHIVIST_ROOT}/FREEAGENT_SYSTEM_ANCHOR.json` },
    { name: 'Library Identity', path: `${LIBRARY_ROOT}/.identity/snapshot.jws` },
    { name: 'Library Key', path: `${LIBRARY_ROOT}/.identity/private.pem` },
    { name: 'SwarmMind Identity', path: `${SWARMIND_ROOT}/.identity/snapshot.jws` },
    { name: 'SwarmMind Key', path: `${SWARMIND_ROOT}/.identity/private.pem` },
  ];
  
  let allPassed = true;
  
  for (const check of checks) {
    const fs = require('fs');
    if (fs.existsSync(check.path)) {
      console.log(`✅ ${check.name}: ${check.path}`);
    } else {
      console.error(`❌ ${check.name}: NOT FOUND`);
      console.error(`   Expected: ${check.path}`);
      allPassed = false;
    }
  }
  
  return allPassed;
}

async function runSmokeTests() {
  console.log('\n========================================');
  console.log('SMOKE TESTS');
  console.log('========================================\n');
  
  const tests = [
    { name: 'Library Queue.js', path: `${LIBRARY_ROOT}/src/queue/Queue.js` },
    { name: 'Library Verifier.js', path: `${LIBRARY_ROOT}/src/attestation/Verifier.js` },
    { name: 'SwarmMind Queue.js', path: `${SWARMIND_ROOT}/src/queue/Queue.js` },
    { name: 'SwarmMind Verifier.js', path: `${SWARMIND_ROOT}/src/attestation/Verifier.js` },
  ];
  
  let allPassed = true;
  
  for (const test of tests) {
    try {
      await runCommand('node', ['--check', test.path], '.');
      console.log(`✅ ${test.name}: syntax OK`);
    } catch (e) {
      console.error(`❌ ${test.name}: SYNTAX ERROR`);
      allPassed = false;
    }
  }
  
  return allPassed;
}

async function main() {
  console.log('\n' + '='.repeat(60));
  console.log('FREEAGENT PRODUCTION PHENOTYPE BOOT');
  console.log('Architecture: lane_single_process');
  console.log('='.repeat(60));
  
  // Phase 0.5: Anchor validation (HARD FAIL if fails)
  const anchorOk = await validateAnchor();
  if (!anchorOk) {
    process.exit(1);
  }
  
  // Phase 2: Health checks (HARD FAIL if fails)
  const healthOk = await runHealthChecks();
  if (!healthOk) {
    console.error('\n❌ Health checks failed');
    console.error('   Missing required files');
    process.exit(2);
  }
  
  // Phase 2: Smoke tests (HARD FAIL if fails)
  const smokeOk = await runSmokeTests();
  if (!smokeOk) {
    console.error('\n❌ Smoke tests failed');
    console.error('   Syntax errors detected');
    process.exit(3);
  }
  
  console.log('\n' + '='.repeat(60));
  console.log('✅ ALL CHECKS PASSED');
  console.log('='.repeat(60));
  console.log('\nTo start lanes individually:');
  console.log('  Library:  cd S:/self-organizing-library && LANE_KEY_PASSPHRASE=<secret> npm run governed-start');
  console.log('  SwarmMind: cd "S:/SwarmMind" && LANE_KEY_PASSPHRASE=<secret> npm start');
  console.log('\nNote: Archivist does not require governed-start (hosts trust store)');
  
  process.exit(0);
}

main().catch(err => {
  console.error('\n❌ Boot failed:', err.message);
  process.exit(1);
});
