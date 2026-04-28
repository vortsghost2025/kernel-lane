#!/usr/bin/env node
'use strict';

/**
 * Trust Store Consistency Validation Test Suite
 * Tests cross-lane trust store synchronization and key validation
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const LANES = [
  { name: 'archivist', path: 'S:/Archivist-Agent' },
  { name: 'library', path: 'S:/self-organizing-library' },
  { name: 'swarmmind', path: 'S:/SwarmMind' },
  { name: 'kernel', path: 'S:/kernel-lane' }
];

let passCount = 0;
let failCount = 0;
const results = [];

function log(message, type = 'info') {
  const prefix = type === 'pass' ? '✅' : type === 'fail' ? '❌' : 'ℹ️';
  console.log(`${prefix} ${message}`);
}

function assert(condition, message, details = null) {
  if (condition) {
    passCount++;
    results.push({ test: message, status: 'PASS', details });
    log(message, 'pass');
  } else {
    failCount++;
    results.push({ test: message, status: 'FAIL', details });
    log(message, 'fail');
    if (details) log(`  Details: ${details}`, 'fail');
  }
}

// Test 1: Trust store exists in all lanes
log('\n=== Test 1: Trust Store Existence ===');
LANES.forEach(lane => {
  const trustPath = path.join(lane.path, 'lanes/broadcast/trust-store.json');
  const exists = fs.existsSync(trustPath);
  assert(exists, `Trust store exists for ${lane.name}`, trustPath);
});

// Test 2: Trust store is valid JSON
log('\n=== Test 2: Trust Store JSON Validity ===');
LANES.forEach(lane => {
  const trustPath = path.join(lane.path, 'lanes/broadcast/trust-store.json');
  try {
    const content = fs.readFileSync(trustPath, 'utf8');
    const parsed = JSON.parse(content);
    assert(true, `Trust store is valid JSON for ${lane.name}`);
  } catch (e) {
    assert(false, `Trust store is valid JSON for ${lane.name}`, e.message);
  }
});

// Test 3: All lanes have entries for all lanes
log('\n=== Test 3: Complete Trust Store Entries ===');
LANES.forEach(sourceLane => {
  const trustPath = path.join(sourceLane.path, 'lanes/broadcast/trust-store.json');
  const trustStore = JSON.parse(fs.readFileSync(trustPath, 'utf8'));
  
  LANES.forEach(targetLane => {
    const hasEntry = trustStore.hasOwnProperty(targetLane.name);
    assert(hasEntry, `${sourceLane.name} trust store has entry for ${targetLane.name}`);
  });
});

// Test 4: Key ID derivation consistency
log('\n=== Test 4: Key ID Derivation Consistency ===');
const keyIds = {};
LANES.forEach(lane => {
  const trustPath = path.join(lane.path, 'lanes/broadcast/trust-store.json');
  const trustStore = JSON.parse(fs.readFileSync(trustPath, 'utf8'));
  
  LANES.forEach(targetLane => {
    const entry = trustStore[targetLane.name];
    if (entry && entry.key_id) {
      if (!keyIds[targetLane.name]) {
        keyIds[targetLane.name] = [];
      }
      keyIds[targetLane.name].push({ lane: lane.name, keyId: entry.key_id });
    }
  });
});

Object.keys(keyIds).forEach(laneName => {
  const ids = keyIds[laneName];
  const allSame = ids.every(id => id.keyId === ids[0].keyId);
  assert(allSame, `Key ID consistent for ${laneName} across all trust stores`,
    ids.map(id => `${id.lane}:${id.keyId}`).join(', '));
});

// Test 5: Public key PEM format
log('\n=== Test 5: Public Key PEM Format ===');
LANES.forEach(sourceLane => {
  const trustPath = path.join(sourceLane.path, 'lanes/broadcast/trust-store.json');
  const trustStore = JSON.parse(fs.readFileSync(trustPath, 'utf8'));
  
  LANES.forEach(targetLane => {
    const entry = trustStore[targetLane.name];
    if (entry && entry.public_key_pem) {
      const hasBegin = entry.public_key_pem.includes('-----BEGIN PUBLIC KEY-----');
      const hasEnd = entry.public_key_pem.includes('-----END PUBLIC KEY-----');
      assert(hasBegin && hasEnd, `${sourceLane.name}: ${targetLane.name} PEM format valid`);
    } else {
      assert(false, `${sourceLane.name}: ${targetLane.name} has public key PEM`);
    }
  });
});

// Test 6: Trust store files are identical across lanes
log('\n=== Test 6: Trust Store Content Consistency ===');
const trustContents = LANES.map(lane => {
  const trustPath = path.join(lane.path, 'lanes/broadcast/trust-store.json');
  return fs.readFileSync(trustPath, 'utf8');
});

const allSameContent = trustContents.every(content => content === trustContents[0]);
assert(allSameContent, 'All trust store files have identical content');

// Test 7: Key ID format (16 hex characters)
log('\n=== Test 7: Key ID Format ===');
LANES.forEach(sourceLane => {
  const trustPath = path.join(sourceLane.path, 'lanes/broadcast/trust-store.json');
  const trustStore = JSON.parse(fs.readFileSync(trustPath, 'utf8'));
  
  LANES.forEach(targetLane => {
    const entry = trustStore[targetLane.name];
    if (entry && entry.key_id) {
      const validFormat = /^[0-9a-f]{16}$/.test(entry.key_id);
      assert(validFormat, `${targetLane.name} key_id format valid (${entry.key_id})`);
    }
  });
});

// Test 8: Local .identity/public.pem matches trust store
log('\n=== Test 8: Local Public Key Matches Trust Store ===');
LANES.forEach(lane => {
  const localPemPath = path.join(lane.path, '.identity/public.pem');
  const trustPath = path.join(lane.path, 'lanes/broadcast/trust-store.json');
  
  if (fs.existsSync(localPemPath)) {
    const localPem = fs.readFileSync(localPemPath, 'utf8');
    const trustStore = JSON.parse(fs.readFileSync(trustPath, 'utf8'));
    const trustPem = trustStore[lane.name]?.public_key_pem;
    
    const matches = localPem === trustPem;
    assert(matches, `${lane.name}: Local PEM matches trust store`);
  } else {
    assert(false, `${lane.name}: Local public PEM exists`);
  }
});

// Test 9: Required fields in trust store entries
log('\n=== Test 9: Trust Store Entry Fields ===');
const requiredFields = ['lane_id', 'public_key_pem', 'algorithm', 'key_id', 'registered_at'];
LANES.forEach(sourceLane => {
  const trustPath = path.join(sourceLane.path, 'lanes/broadcast/trust-store.json');
  const trustStore = JSON.parse(fs.readFileSync(trustPath, 'utf8'));
  
  LANES.forEach(targetLane => {
    const entry = trustStore[targetLane.name];
    requiredFields.forEach(field => {
      const hasField = entry && entry.hasOwnProperty(field);
      assert(hasField, `${sourceLane.name}: ${targetLane.name} has ${field}`);
    });
  });
});

// Test 10: Algorithm is RS256
log('\n=== Test 10: Algorithm Specification ===');
LANES.forEach(sourceLane => {
  const trustPath = path.join(sourceLane.path, 'lanes/broadcast/trust-store.json');
  const trustStore = JSON.parse(fs.readFileSync(trustPath, 'utf8'));
  
  LANES.forEach(targetLane => {
    const entry = trustStore[targetLane.name];
    const correctAlg = entry && entry.algorithm === 'RS256';
    assert(correctAlg, `${targetLane.name}: Algorithm is RS256`);
  });
});

// Summary
console.log('\n' + '='.repeat(60));
console.log(`TRUST CONSISTENCY TEST RESULTS`);
console.log('='.repeat(60));
console.log(`Total Tests: ${passCount + failCount}`);
console.log(`✅ Passed: ${passCount}`);
console.log(`❌ Failed: ${failCount}`);
console.log(`Success Rate: ${((passCount / (passCount + failCount)) * 100).toFixed(1)}%`);
console.log('='.repeat(60));

// Save results
const report = {
  timestamp: new Date().toISOString(),
  total_tests: passCount + failCount,
  passed: passCount,
  failed: failCount,
  success_rate: ((passCount / (passCount + failCount)) * 100).toFixed(1) + '%',
  results: results
};

fs.writeFileSync(
  'S:/kernel-lane/reports/trust-consistency-report.json',
  JSON.stringify(report, null, 2)
);

console.log('\nReport saved: S:/kernel-lane/reports/trust-consistency-report.json');

process.exit(failCount > 0 ? 1 : 0);
