#!/usr/bin/env node
/**
 * verify-key-ids.js - Validate all lanes use DER-based key derivation
 * 
 * Usage: node verify-key-ids.js [--fix]
 * --fix: Automatically update incorrect key_ids
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Load canonical deriveKeyId function using absolute path
const deriveKeyIdPath = path.join(__dirname, 'deriveKeyId.js');
const { deriveKeyId } = require(deriveKeyIdPath);

const LANES = [
  { name: 'archivist', basePath: 'S:/Archivist-Agent' },
  { name: 'kernel', basePath: 'S:/kernel-lane' },
  { name: 'library', basePath: 'S:/self-organizing-library' },
  { name: 'swarmmind', basePath: 'S:/SwarmMind' }
];

function verifyLane(lane) {
  const publicKeyPath = path.join(lane.basePath, '.identity', 'public.pem');
  const keysJsonPath = path.join(lane.basePath, '.trust', 'keys.json');
  
  console.log(`\n[CHECK] Verifying ${lane.name}...`);
  
  // Check if public.pem exists
  if (!fs.existsSync(publicKeyPath)) {
    return { lane: lane.name, status: 'NO_PUBLIC_KEY', expected: null, actual: null };
  }
  
  // Calculate expected key_id using DER method
  const publicKeyPem = fs.readFileSync(publicKeyPath, 'utf8');
  const expectedKeyId = deriveKeyId(publicKeyPem);
  
  // Read actual key_id from .trust/keys.json
  let actualKeyId = null;
  let keysJson = null;
  if (fs.existsSync(keysJsonPath)) {
    keysJson = JSON.parse(fs.readFileSync(keysJsonPath, 'utf8'));
    actualKeyId = keysJson.key_id;
  }
  
  const matches = expectedKeyId === actualKeyId;
  
  console.log(`  Expected (DER): ${expectedKeyId}`);
  console.log(`  Actual:         ${actualKeyId || 'NOT_FOUND'}`);
  console.log(`  Status: ${matches ? '✅ MATCH' : '❌ MISMATCH'}`);
  
  return {
    lane: lane.name,
    expected: expectedKeyId,
    actual: actualKeyId,
    matches,
    publicKeyPath,
    keysJsonPath
  };
}

function verifyTrustStore() {
  const trustStorePath = 'S:/kernel-lane/lanes/broadcast/trust-store.json';
  if (!fs.existsSync(trustStorePath)) {
    console.log('\n[WARN] Trust store not found:', trustStorePath);
    return [];
  }
  
  const trustStore = JSON.parse(fs.readFileSync(trustStorePath, 'utf8'));
  const results = [];
  
  console.log('\n[CHECK] Verifying trust store entries...');
  
  for (const [laneName, entry] of Object.entries(trustStore)) {
    if (!entry.public_key_pem) {
      console.log(`  ${laneName}: ⚠️ No public_key_pem (HMAC?)`);
      continue;
    }
    
    const expectedKeyId = deriveKeyId(entry.public_key_pem);
    const matches = expectedKeyId === entry.key_id;
    
    console.log(`  ${laneName}: ${matches ? '✅' : '❌'} Expected: ${expectedKeyId}, Actual: ${entry.key_id}`);
    
    results.push({
      lane: laneName,
      expected: expectedKeyId,
      actual: entry.key_id,
      matches
    });
  }
  
  return results;
}

function fixKeyIds(verificationResults) {
  let fixed = 0;
  
  for (const result of verificationResults) {
    if (result.matches) continue;
    if (result.lane === 'swarmmind' && result.actual === '1a7741b8d353abee') {
      console.log(`  [SKIP] ${result.lane}: Keeping canonical key_id 1a7741b8d353abee (enforced)`);
      continue;
    }
    
    const keysJsonPath = path.join(
      LANES.find(l => l.name === result.lane).basePath,
      '.trust', 'keys.json'
    );
    
    if (fs.existsSync(keysJsonPath)) {
      const keysJson = JSON.parse(fs.readFileSync(keysJsonPath, 'utf8'));
      keysJson.key_id = result.expected;
      fs.writeFileSync(keysJsonPath, JSON.stringify(keysJson, null, 2));
      console.log(`  [FIXED] ${result.lane}: ${result.actual} → ${result.expected}`);
      fixed++;
    }
  }
  
  return fixed;
}

// Main execution
const args = process.argv.slice(2);
const shouldFix = args.includes('--fix');

console.log('=== Key ID Verification (DER Method) ===');
console.log('Canonical method: SHA256(DER of SPKI) → first 16 hex chars\n');

const results = [];

// Verify each lane
for (const lane of LANES) {
  const result = verifyLane(lane);
  results.push(result);
}

// Verify trust store
const trustResults = verifyTrustStore();

// Summary
const allMismatches = results.filter(r => !r.matches).concat(trustResults.filter(r => !r.matches));

if (allMismatches.length > 0) {
  console.log('\n❌ MISMATCHES FOUND:');
  allMismatches.forEach(r => {
    console.log(`  ${r.lane}: ${r.actual} → should be ${r.expected}`);
  });
  
  if (shouldFix) {
    console.log('\n[FIXING...]');
    const fixed = fixKeyIds(results);
    console.log(`Fixed ${fixed} key_id entries`);
  }
} else {
  console.log('\n✅ ALL LANES VERIFIED - DER derivation consistent across system');
}

// Exit with error if mismatches found
process.exit(allMismatches.length > 0 ? 1 : 0);
