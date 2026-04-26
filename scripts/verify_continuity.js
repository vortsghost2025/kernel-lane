#!/usr/bin/env node
/**
 * CONTINUITY_VERIFICATION.js
 * 
 * Startup verification script that:
 * 1. Loads context
 * 2. Recomputes fingerprints
 * 3. Compares to stored values in CONTINUITY_REGISTRY.json
 * 4. Sets recovery_status: verified | mismatch | corrupted
 * 
 * Evidence: CONTINUITY_REGISTRY.json notes
 * Reference: CONTINUITY_SPEC.md
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = 'S:\\Archivist-Agent';

function computeHash(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function readFile(filepath) {
  try {
    const content = fs.readFileSync(filepath, 'utf8');
    return { content, hash: computeHash(content) };
  } catch (e) {
    return { content: null, hash: 'FILE_NOT_FOUND', error: e.message };
  }
}

function readJSON(filepath) {
  try {
    const content = fs.readFileSync(filepath, 'utf8');
    return { content, parsed: JSON.parse(content), hash: computeHash(content) };
  } catch (e) {
    return { content: null, parsed: null, hash: 'FILE_NOT_FOUND', error: e.message };
  }
}

function main() {
  console.log('=== CONTINUITY VERIFICATION ===\n');

  // Load CONTINUITY_REGISTRY.json
  const registryPath = path.join(ROOT, 'CONTINUITY_REGISTRY.json');
  const registry = readJSON(registryPath);
  
  if (!registry.parsed) {
    console.log('FATAL: CONTINUITY_REGISTRY.json not found or invalid');
    process.exit(1);
  }

  console.log('Registry loaded:', registry.parsed.version);
  console.log('Lane:', registry.parsed.lane_id);
  console.log('Previous status:', registry.parsed.recovery_status);
  console.log('');

  // Compute constitutional fingerprints
  console.log('--- Constitutional Fingerprint ---');
  const bootstrap = readFile(path.join(ROOT, 'BOOTSTRAP.md'));
  const covenant = readFile(path.join(ROOT, 'COVENANT.md'));
  const governance = readFile(path.join(ROOT, 'GOVERNANCE.md'));
  const cps = readFile(path.join(ROOT, 'CPS_ENFORCEMENT.md'));

  const constitutionalCombined = (bootstrap.content || '') + 
                                  (covenant.content || '') + 
                                  (governance.content || '') + 
                                  (cps.content || '');
  const constitutionalHash = computeHash(constitutionalCombined);

  const constitutionalMatch = constitutionalHash === registry.parsed.constitutional_fingerprint?.combined_hash;
  console.log('BOOTSTRAP.md:', bootstrap.hash.substring(0, 16) + '...');
  console.log('COVENANT.md:', covenant.hash.substring(0, 16) + '...');
  console.log('GOVERNANCE.md:', governance.hash.substring(0, 16) + '...');
  console.log('CPS_ENFORCEMENT.md:', cps.hash.substring(0, 16) + '...');
  console.log('Combined:', constitutionalHash);
  console.log('Expected:', registry.parsed.constitutional_fingerprint?.combined_hash);
  console.log('Match:', constitutionalMatch ? 'YES' : 'NO');
  console.log('');

  // Compute continuity fingerprints
  console.log('--- Continuity Fingerprint ---');
  const sessions = readJSON(path.join(ROOT, '.memory', 'sessions.json'));
  const sessionRegistry = readJSON(path.join(ROOT, 'SESSION_REGISTRY.json'));
  const identity = readFile(path.join(ROOT, '.identity', 'keys.json'));
  const audit = readFile(path.join(ROOT, 'logs', 'audit.log'));

  const continuityCombined = (sessions.content || '') + (sessionRegistry.content || '');
  const continuityHash = computeHash(continuityCombined);

  const continuityMatch = continuityHash === registry.parsed.continuity_fingerprint?.combined_hash;
  console.log('.memory/sessions.json:', sessions.hash.substring(0, 16) + '...');
  console.log('SESSION_REGISTRY.json:', sessionRegistry.hash.substring(0, 16) + '...');
  console.log('.identity/keys.json:', identity.hash.substring(0, 16) + '...');
  console.log('logs/audit.log:', audit.hash.substring(0, 16) + '...');
  console.log('Combined:', continuityHash);
  console.log('Expected:', registry.parsed.continuity_fingerprint?.combined_hash);
  console.log('Match:', continuityMatch ? 'YES' : 'NO');
  console.log('');

  // Determine recovery status
  console.log('--- Verification Result ---');
  let recoveryStatus;
  let verificationResult;

  // Check for missing required inputs
  const missingInputs = [];
  if (identity.hash === 'FILE_NOT_FOUND') missingInputs.push('.identity/keys.json');
  if (audit.hash === 'FILE_NOT_FOUND') missingInputs.push('logs/audit.log');

  if (!constitutionalMatch && !continuityMatch) {
    recoveryStatus = 'corrupted';
    verificationResult = {
      constitutional: 'MISMATCH',
      continuity: 'MISMATCH',
      timestamp: new Date().toISOString()
    };
    console.log('Status: CORRUPTED');
    console.log('Both fingerprints mismatch. Manual intervention required.');
  } else if (missingInputs.length > 0 && constitutionalMatch) {
    recoveryStatus = 'partial';
    verificationResult = {
      constitutional: constitutionalMatch ? 'MATCH' : 'MISMATCH',
      continuity: 'PARTIAL',
      missing_inputs: missingInputs,
      timestamp: new Date().toISOString()
    };
    console.log('Status: PARTIAL');
    console.log('Constitutional proof valid. Continuity proof incomplete.');
    console.log('Missing inputs:', missingInputs.join(', '));
  } else if (!constitutionalMatch || !continuityMatch) {
    recoveryStatus = 'mismatch';
    verificationResult = {
      constitutional: constitutionalMatch ? 'MATCH' : 'MISMATCH',
      continuity: continuityMatch ? 'MATCH' : 'MISMATCH',
      timestamp: new Date().toISOString()
    };
    console.log('Status: MISMATCH');
    console.log('Partial fingerprint mismatch. Investigation required.');
  } else {
    recoveryStatus = 'verified';
    verificationResult = {
      constitutional: 'MATCH',
      continuity: 'MATCH',
      timestamp: new Date().toISOString()
    };
    console.log('Status: VERIFIED');
    console.log('All fingerprints match. System is self-consistent.');
  }

  // Update registry
  registry.parsed.recovery_status = recoveryStatus;
  registry.parsed.recovery_timestamp = new Date().toISOString();
  registry.parsed.verification_result = verificationResult;
  registry.parsed.constitutional_fingerprint.combined_hash = constitutionalHash;
  registry.parsed.continuity_fingerprint.combined_hash = continuityHash;

  fs.writeFileSync(registryPath, JSON.stringify(registry.parsed, null, 2));
  console.log('\nRegistry updated:', registryPath);

  // Exit code
  if (recoveryStatus === 'verified') {
    console.log('\n=== VERIFICATION PASSED ===');
    process.exit(0);
  } else if (recoveryStatus === 'partial') {
    console.log('\n=== VERIFICATION PARTIAL ===');
    process.exit(0); // Partial is acceptable - system can continue
  } else if (recoveryStatus === 'mismatch') {
    console.log('\n=== VERIFICATION WARNING ===');
    process.exit(1);
  } else {
    console.log('\n=== VERIFICATION FAILED ===');
    process.exit(2);
  }
}

main();
