#!/usr/bin/env node
/**
 * health-core.js - Phase 2 Health Check Script
 * 
 * Validates all required components exist and are accessible.
 * Does NOT start any processes.
 * 
 * Usage: node scripts/health-core.js
 * 
 * Exit codes:
 *   0 = all healthy
 *   1 = missing components
 */

const fs = require('fs');
const path = require('path');

const ARCHIVIST_ROOT = 'S:/Archivist-Agent';
const LIBRARY_ROOT = 'S:/self-organizing-library';
const SWARMIND_ROOT = 'S:/SwarmMind';

const checks = [
  // Trust Store
  { 
    category: 'Trust Store',
    name: 'keys.json',
    path: `${ARCHIVIST_ROOT}/.trust/keys.json`,
    required: true,
    validate: (content) => {
      const data = JSON.parse(content);
      return data.keys && data.keys.archivist && data.keys.library && data.keys.swarmmind;
    }
  },
  
  // System Anchor
  { 
    category: 'System Anchor',
    name: 'FREEAGENT_SYSTEM_ANCHOR.json',
    path: `${ARCHIVIST_ROOT}/FREEAGENT_SYSTEM_ANCHOR.json`,
    required: true,
    validate: (content) => {
      const data = JSON.parse(content);
      return data.strict_mode === true && data.architecture_mode === 'lane_single_process';
    }
  },
  
  // Library Identity
  { 
    category: 'Library Identity',
    name: 'snapshot.jws',
    path: `${LIBRARY_ROOT}/.identity/snapshot.jws`,
    required: true
  },
  { 
    category: 'Library Identity',
    name: 'private.pem',
    path: `${LIBRARY_ROOT}/.identity/private.pem`,
    required: true
  },
  
  // SwarmMind Identity
  { 
    category: 'SwarmMind Identity',
    name: 'snapshot.jws',
    path: `${SWARMIND_ROOT}/.identity/snapshot.jws`,
    required: true
  },
  { 
    category: 'SwarmMind Identity',
    name: 'private.pem',
    path: `${SWARMIND_ROOT}/.identity/private.pem`,
    required: true
  },
  
  // Library Verification Path
  { 
    category: 'Library Verification',
    name: 'VerifierWrapper.js',
    path: `${LIBRARY_ROOT}/src/attestation/VerifierWrapper.js`,
    required: true
  },
  { 
    category: 'Library Verification',
    name: 'Verifier.js',
    path: `${LIBRARY_ROOT}/src/attestation/Verifier.js`,
    required: true
  },
  { 
    category: 'Library Verification',
    name: 'Queue.js',
    path: `${LIBRARY_ROOT}/src/queue/Queue.js`,
    required: true
  },
  
  // SwarmMind Verification Path
  { 
    category: 'SwarmMind Verification',
    name: 'VerifierWrapper.js',
    path: `${SWARMIND_ROOT}/src/attestation/VerifierWrapper.js`,
    required: true
  },
  { 
    category: 'SwarmMind Verification',
    name: 'Verifier.js',
    path: `${SWARMIND_ROOT}/src/attestation/Verifier.js`,
    required: true
  },
  { 
    category: 'SwarmMind Verification',
    name: 'Queue.js',
    path: `${SWARMIND_ROOT}/src/queue/Queue.js`,
    required: true
  },
];

function runHealthChecks() {
  console.log('\n========================================');
  console.log('HEALTH CHECK: PRODUCTION PHENOTYPE');
  console.log('========================================\n');
  
  let passed = 0;
  let failed = 0;
  let currentCategory = '';
  
  for (const check of checks) {
    if (check.category !== currentCategory) {
      currentCategory = check.category;
      console.log(`\n[${currentCategory}]`);
    }
    
    if (!fs.existsSync(check.path)) {
      console.log(`  ❌ ${check.name}: NOT FOUND`);
      console.log(`     Expected: ${check.path}`);
      if (check.required) failed++;
      passed++;
      continue;
    }
    
    if (check.validate) {
      try {
        const content = fs.readFileSync(check.path, 'utf8');
        if (!check.validate(content)) {
          console.log(`  ❌ ${check.name}: VALIDATION FAILED`);
          if (check.required) failed++;
          continue;
        }
      } catch (e) {
        console.log(`  ❌ ${check.name}: ${e.message}`);
        if (check.required) failed++;
        continue;
      }
    }
    
    console.log(`  ✅ ${check.name}: OK`);
    passed++;
  }
  
  console.log('\n========================================');
  console.log(`RESULTS: ${passed} passed, ${failed} failed`);
  console.log('========================================\n');
  
  return failed === 0;
}

function main() {
  const healthy = runHealthChecks();
  
  if (!healthy) {
    console.error('❌ Health check FAILED');
    console.error('   Missing or invalid required components');
    process.exit(1);
  }
  
  console.log('✅ All health checks passed');
  process.exit(0);
}

main();
