#!/usr/bin/env node
/**
 * smoke-core.js - Phase 2 Smoke Test Script
 * 
 * Runs minimal functional tests to verify core path works.
 * Does NOT start any long-running processes.
 * 
 * Usage: node scripts/smoke-core.js
 * 
 * Exit codes:
 *   0 = all tests passed
 *   1 = tests failed
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ARCHIVIST_ROOT = 'S:/Archivist-Agent';
const LIBRARY_ROOT = 'S:/self-organizing-library';
const SWARMIND_ROOT = 'S:/SwarmMind';

function syntaxCheck(filePath) {
  try {
    execSync(`node --check "${filePath}"`, { stdio: 'pipe' });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.stderr?.toString() || e.message };
  }
}

function runSmokeTests() {
  console.log('\n========================================');
  console.log('SMOKE TEST: PRODUCTION PHENOTYPE');
  console.log('========================================\n');
  
  const tests = [
    // Syntax checks
    { 
      category: 'Syntax',
      name: 'Library VerifierWrapper.js',
      run: () => syntaxCheck(`${LIBRARY_ROOT}/src/attestation/VerifierWrapper.js`)
    },
    { 
      category: 'Syntax',
      name: 'Library Verifier.js',
      run: () => syntaxCheck(`${LIBRARY_ROOT}/src/attestation/Verifier.js`)
    },
    { 
      category: 'Syntax',
      name: 'Library Queue.js',
      run: () => syntaxCheck(`${LIBRARY_ROOT}/src/queue/Queue.js`)
    },
    { 
      category: 'Syntax',
      name: 'Library Signer.js',
      run: () => syntaxCheck(`${LIBRARY_ROOT}/src/attestation/Signer.js`)
    },
    { 
      category: 'Syntax',
      name: 'Library KeyManager.js',
      run: () => syntaxCheck(`${LIBRARY_ROOT}/src/attestation/KeyManager.js`)
    },
    { 
      category: 'Syntax',
      name: 'SwarmMind VerifierWrapper.js',
      run: () => syntaxCheck(`${SWARMIND_ROOT}/src/attestation/VerifierWrapper.js`)
    },
    { 
      category: 'Syntax',
      name: 'SwarmMind Verifier.js',
      run: () => syntaxCheck(`${SWARMIND_ROOT}/src/attestation/Verifier.js`)
    },
    { 
      category: 'Syntax',
      name: 'SwarmMind Queue.js',
      run: () => syntaxCheck(`${SWARMIND_ROOT}/src/queue/Queue.js`)
    },
    { 
      category: 'Syntax',
      name: 'Archivist validate-system-anchor.js',
      run: () => syntaxCheck(`${ARCHIVIST_ROOT}/scripts/validate-system-anchor.js`)
    },
    
    // Trust store format
    { 
      category: 'Trust Store',
      name: 'Valid JSON',
      run: () => {
        try {
          const content = fs.readFileSync(`${ARCHIVIST_ROOT}/.trust/keys.json`, 'utf8');
          const data = JSON.parse(content);
          if (!data.keys) return { ok: false, error: 'Missing keys object' };
          if (!data.keys.archivist) return { ok: false, error: 'Missing archivist key' };
          if (!data.keys.library) return { ok: false, error: 'Missing library key' };
          if (!data.keys.swarmmind) return { ok: false, error: 'Missing swarmmind key' };
          return { ok: true };
        } catch (e) {
          return { ok: false, error: e.message };
        }
      }
    },
    
    // Anchor format
    { 
      category: 'Anchor',
      name: 'Strict mode enabled',
      run: () => {
        try {
          const content = fs.readFileSync(`${ARCHIVIST_ROOT}/FREEAGENT_SYSTEM_ANCHOR.json`, 'utf8');
          const data = JSON.parse(content);
          if (data.strict_mode !== true) return { ok: false, error: 'strict_mode not true' };
          if (data.architecture_mode !== 'lane_single_process') return { ok: false, error: 'Wrong architecture mode' };
          return { ok: true };
        } catch (e) {
          return { ok: false, error: e.message };
        }
      }
    },
    
    // Identity files exist
    { 
      category: 'Identity',
      name: 'Library snapshot.jws exists',
      run: () => {
        const exists = fs.existsSync(`${LIBRARY_ROOT}/.identity/snapshot.jws`);
        return exists ? { ok: true } : { ok: false, error: 'Not found' };
      }
    },
    { 
      category: 'Identity',
      name: 'SwarmMind snapshot.jws exists',
      run: () => {
        const exists = fs.existsSync(`${SWARMIND_ROOT}/.identity/snapshot.jws`);
        return exists ? { ok: true } : { ok: false, error: 'Not found' };
      }
    },
  ];
  
  let passed = 0;
  let failed = 0;
  let currentCategory = '';
  
  for (const test of tests) {
    if (test.category !== currentCategory) {
      currentCategory = test.category;
      console.log(`\n[${currentCategory}]`);
    }
    
    const result = test.run();
    
    if (result.ok) {
      console.log(`  ✅ ${test.name}`);
      passed++;
    } else {
      console.log(`  ❌ ${test.name}: ${result.error}`);
      failed++;
    }
  }
  
  console.log('\n========================================');
  console.log(`RESULTS: ${passed} passed, ${failed} failed`);
  console.log('========================================\n');
  
  return failed === 0;
}

function main() {
  const ok = runSmokeTests();
  
  if (!ok) {
    console.error('❌ Smoke tests FAILED');
    process.exit(1);
  }
  
  console.log('✅ All smoke tests passed');
  process.exit(0);
}

main();
