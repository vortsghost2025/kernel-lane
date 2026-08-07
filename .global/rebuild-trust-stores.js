#!/usr/bin/env node
/**
 * rebuild-trust-stores.js - One-shot trust store rebuild
 * 
 * Rebuilds all trust stores using DER-derived key_ids.
 * Usage: node rebuild-trust-stores.js [--commit] [--push]
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Load canonical deriveKeyId function
const { deriveKeyId } = require('./deriveKeyId.js');

const LANES = [
  { name: 'archivist', basePath: 'S:/Archivist-Agent' },
  { name: 'kernel', basePath: 'S:/kernel-lane' },
  { name: 'library', basePath: 'S:/self-organizing-library' },
  { name: 'swarmmind', basePath: 'S:/SwarmMind' }
];

function getPublicKeyPem(lane) {
  const publicKeyPath = path.join(lane.basePath, '.identity', 'public.pem');
  if (!fs.existsSync(publicKeyPath)) {
    console.log(`[WARN] ${lane.name}: No public.pem found at ${publicKeyPath}`);
    return null;
  }
  return fs.readFileSync(publicKeyPath, 'utf8');
}

function updateLaneTrustStore(lane, publicKeyPem) {
  const keyId = deriveKeyId(publicKeyPem);
  const trustPath = path.join(lane.basePath, '.trust', 'keys.json');
  
  let trustStore = {};
  if (fs.existsSync(trustPath)) {
    trustStore = JSON.parse(fs.readFileSync(trustPath, 'utf8'));
  }
  
  trustStore.lane_id = lane.name;
  trustStore.public_key_pem = publicKeyPem;
  trustStore.algorithm = 'RS256';
  trustStore.key_id = keyId;
  trustStore.registered_at = new Date().toISOString();
  trustStore.expires_at = null;
  trustStore.revoked_at = null;
  
  fs.writeFileSync(trustPath, JSON.stringify(trustStore, null, 2));
  console.log(`[UPDATED] ${lane.name}: .trust/keys.json -> key_id: ${keyId}`);
  
  return keyId;
}

function updateBroadcastTrustStore(laneKeyIds) {
  const broadcastPath = path.join('S:/kernel-lane', 'lanes', 'broadcast', 'trust-store.json');
  
  if (!fs.existsSync(broadcastPath)) {
    console.log('[ERROR] Broadcast trust store not found:', broadcastPath);
    return;
  }
  
  const broadcast = JSON.parse(fs.readFileSync(broadcastPath, 'utf8'));
  
  for (const lane of LANES) {
    const keyId = laneKeyIds[lane.name];
    if (!keyId) continue;
    
    if (!broadcast[lane.name]) {
      broadcast[lane.name] = {};
    }
    
    const publicKeyPath = path.join(lane.basePath, '.identity', 'public.pem');
    if (fs.existsSync(publicKeyPath)) {
      broadcast[lane.name].public_key_pem = fs.readFileSync(publicKeyPath, 'utf8');
    }
    
    broadcast[lane.name].lane_id = lane.name;
    broadcast[lane.name].key_id = keyId;
    broadcast[lane.name].algorithm = 'RS256';
    broadcast[lane.name].registered_at = new Date().toISOString();
    broadcast[lane.name].expires_at = null;
    broadcast[lane.name].revoked_at = null;
  }
  
  fs.writeFileSync(broadcastPath, JSON.stringify(broadcast, null, 2));
  console.log('[UPDATED] Broadcast trust store:', broadcastPath);
}

function updateSnapshotJson(lane, keyId) {
  const snapshotPath = path.join(lane.basePath, '.identity', 'snapshot.json');
  
  if (!fs.existsSync(snapshotPath)) {
    console.log(`[WARN] ${lane.name}: No snapshot.json found`);
    return;
  }
  
  const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
  if (snapshot.key_id !== keyId) {
    snapshot.key_id = keyId;
    snapshot.updated_at = new Date().toISOString();
    fs.writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2));
    console.log(`[UPDATED] ${lane.name}: snapshot.json -> key_id: ${keyId}`);
  }
}

// Main execution
console.log('=== Rebuilding Trust Stores (DER Method) ===\n');

const args = process.argv.slice(2);
const shouldCommit = args.includes('--commit');
const shouldPush = args.includes('--push');

const laneKeyIds = {};

// Step 1: Update each lane's trust store
console.log('\n[STEP 1] Updating lane trust stores...');
for (const lane of LANES) {
  const publicKeyPem = getPublicKeyPem(lane);
  if (!publicKeyPem) continue;
  
  const keyId = updateLaneTrustStore(lane, publicKeyPem);
  laneKeyIds[lane.name] = keyId;
  
  // Update snapshot.json
  updateSnapshotJson(lane, keyId);
}

// Step 2: Update broadcast trust store
console.log('\n[STEP 2] Updating broadcast trust store...');
updateBroadcastTrustStore(laneKeyIds);

// Step 3: Commit and push (if requested)
if (shouldCommit || shouldPush) {
  console.log('\n[STEP 3] Committing changes...');
  
  for (const lane of LANES) {
    if (!laneKeyIds[lane.name]) continue;
    
    try {
      const { execSync } = require('child_process');
      
      // Commit lane changes
      execSync('git -C "' + lane.basePath + '" add .trust/ .identity/', { stdio: 'inherit' });
      execSync('git -C "' + lane.basePath + '" commit -m "FIX: Rebuild trust store with DER-derived key_id for ' + lane.name + '"', { stdio: 'inherit' });
      
      if (shouldPush) {
        execSync('git -C "' + lane.basePath + '" push origin ' + (lane.name === 'archivist' || lane.name === 'library' ? 'master' : 'master') + '', { stdio: 'inherit' });
      }
    } catch (e) {
      console.log(`[ERROR] Failed to commit/push ${lane.name}:`, e.message);
    }
  }
  
  // Commit broadcast trust store (in kernel-lane)
  try {
    const { execSync } = require('child_process');
    execSync('git -C "S:/kernel-lane" add lanes/broadcast/trust-store.json', { stdio: 'inherit' });
    execSync('git -C "S:/kernel-lane" commit -m "FIX: Rebuild broadcast trust store with all DER-derived key_ids"', { stdio: 'inherit' });
    
    if (shouldPush) {
      execSync('git -C "S:/kernel-lane" push origin master', { stdio: 'inherit' });
    }
  } catch (e) {
    console.log('[ERROR] Failed to commit/push broadcast trust store:', e.message);
  }
}

console.log('\n✅ Trust store rebuild complete!');
console.log('\nSummary of key_ids:');
for (const [lane, keyId] of Object.entries(laneKeyIds)) {
  console.log(`  ${lane}: ${keyId}`);
}
