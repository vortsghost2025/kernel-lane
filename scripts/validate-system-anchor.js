/**
 * validate-system-anchor.js
 * Phase 0.5 - System Anchor Validation
 * 
 * MUST pass before any boot/start script executes.
 * HARD FAIL on any mismatch.
 * 
 * Usage: node scripts/validate-system-anchor.js
 * Exit codes:
 *   0 = valid, can proceed
 *   1 = invalid, must not start
 */

const fs = require('fs');
const path = require('path');

const ANCHOR_PATH = path.join(__dirname, '..', 'FREEAGENT_SYSTEM_ANCHOR.json');

function loadAnchor() {
  if (!fs.existsSync(ANCHOR_PATH)) {
    return { valid: false, reason: 'ANCHOR_FILE_MISSING', path: ANCHOR_PATH };
  }
  try {
    return JSON.parse(fs.readFileSync(ANCHOR_PATH, 'utf8'));
  } catch (e) {
    return { valid: false, reason: 'ANCHOR_PARSE_ERROR', error: e.message };
  }
}

function validateAnchorStructure(anchor) {
  const required = ['version', 'primary_root', 'architecture_mode', 'production_phenotype', 'forbidden_surfaces', 'strict_mode'];
  for (const field of required) {
    if (anchor[field] === undefined) {
      return { valid: false, reason: 'MISSING_REQUIRED_FIELD', field };
    }
  }
  return { valid: true };
}

function validateStrictMode(anchor) {
  if (anchor.strict_mode !== true) {
    return { valid: false, reason: 'STRICT_MODE_REQUIRED', value: anchor.strict_mode };
  }
  return { valid: true };
}

function validateFallbackPolicy(anchor) {
  if (!anchor.fallback_policy) {
    return { valid: false, reason: 'MISSING_FALLBACK_POLICY' };
  }
  
  const fp = anchor.fallback_policy;
  
  if (fp.hmac_accepted !== false) {
    return { valid: false, reason: 'HMAC_FALLBACK_NOT_ALLOWED', value: fp.hmac_accepted };
  }
  
  if (fp.recovery_override_allowed !== false) {
    return { valid: false, reason: 'RECOVERY_OVERRIDE_NOT_ALLOWED', value: fp.recovery_override_allowed };
  }
  
  if (fp.missing_signature_mode !== 'REJECT') {
    return { valid: false, reason: 'MISSING_SIGNATURE_MUST_REJECT', value: fp.missing_signature_mode };
  }
  
  if (fp.malformed_jws_mode !== 'QUARANTINE') {
    return { valid: false, reason: 'MALFORMED_JWS_MUST_QUARANTINE', value: fp.malformed_jws_mode };
  }
  
  return { valid: true };
}

function validateLanes(anchor) {
  if (!anchor.production_phenotype || !anchor.production_phenotype.lanes) {
    return { valid: false, reason: 'MISSING_LANES_DEFINITION' };
  }
  
  const lanes = anchor.production_phenotype.lanes;
  const requiredLanes = ['archivist', 'library', 'swarmmind'];
  
  for (const laneId of requiredLanes) {
    if (!lanes[laneId]) {
      return { valid: false, reason: 'MISSING_LANE', lane: laneId };
    }
    
    const lane = lanes[laneId];
    if (!lane.root) {
      return { valid: false, reason: 'LANE_MISSING_ROOT', lane: laneId };
    }
    
    // Verify lane root exists
    if (!fs.existsSync(lane.root)) {
      return { valid: false, reason: 'LANE_ROOT_NOT_FOUND', lane: laneId, path: lane.root };
    }
  }
  
  return { valid: true };
}

function validateTrustStore(anchor) {
  const trustStorePath = anchor.production_phenotype?.trust_store_path;
  if (!trustStorePath) {
    return { valid: false, reason: 'MISSING_TRUST_STORE_PATH' };
  }
  
  if (!fs.existsSync(trustStorePath)) {
    return { valid: false, reason: 'TRUST_STORE_NOT_FOUND', path: trustStorePath };
  }
  
  try {
    const trustStore = JSON.parse(fs.readFileSync(trustStorePath, 'utf8'));
    if (!trustStore.keys) {
      return { valid: false, reason: 'TRUST_STORE_MISSING_KEYS' };
    }
    
    const requiredKeys = ['archivist', 'library', 'swarmmind'];
    for (const keyId of requiredKeys) {
      if (!trustStore.keys[keyId]) {
        return { valid: false, reason: 'TRUST_STORE_MISSING_KEY', key: keyId };
      }
    }
  } catch (e) {
    return { valid: false, reason: 'TRUST_STORE_PARSE_ERROR', error: e.message };
  }
  
  return { valid: true };
}

function validateVerificationPath(anchor) {
  const verificationPath = anchor.production_phenotype?.verification_path;
  if (!verificationPath || typeof verificationPath !== 'object') {
    return { valid: false, reason: 'MISSING_VERIFICATION_PATH' };
  }
  
  // Verification files are per-lane
  const lanes = anchor.production_phenotype.lanes;
  
  for (const [laneId, lane] of Object.entries(lanes)) {
    const laneVPath = verificationPath[laneId];
    if (!laneVPath) {
      // Lane might not have verification files (like archivist)
      continue;
    }
    
    if (!Array.isArray(laneVPath)) {
      return { valid: false, reason: 'VERIFICATION_PATH_NOT_ARRAY', lane: laneId };
    }
    
    for (const relPath of laneVPath) {
      const fullPath = path.join(lane.root, relPath);
      if (!fs.existsSync(fullPath)) {
        return { valid: false, reason: 'VERIFICATION_FILE_MISSING', lane: laneId, path: relPath };
      }
    }
  }
  
  return { valid: true };
}

function validateForbiddenSurfaces(anchor) {
  if (!Array.isArray(anchor.forbidden_surfaces) || anchor.forbidden_surfaces.length === 0) {
    return { valid: false, reason: 'FORBIDDEN_SURFACES_EMPTY' };
  }
  return { valid: true };
}

function validateArchitectureMode(anchor) {
  const validModes = ['lane_single_process', 'distributed_orchestrator_agents'];
  if (!validModes.includes(anchor.architecture_mode)) {
    return { valid: false, reason: 'INVALID_ARCHITECTURE_MODE', value: anchor.architecture_mode };
  }
  return { valid: true };
}

function main() {
  console.log('========================================');
  console.log('SYSTEM ANCHOR VALIDATION');
  console.log('========================================\n');
  
  // Load anchor
  const anchorOrError = loadAnchor();
  if (anchorOrError.valid === false) {
    console.error('[FATAL]', anchorOrError.reason);
    if (anchorOrError.path) console.error('  Path:', anchorOrError.path);
    if (anchorOrError.error) console.error('  Error:', anchorOrError.error);
    process.exit(1);
  }
  const anchor = anchorOrError;
  
  console.log('[INFO] Anchor version:', anchor.version);
  console.log('[INFO] Architecture mode:', anchor.architecture_mode);
  console.log('[INFO] Strict mode:', anchor.strict_mode);
  console.log('');
  
  // Run validations
  const validations = [
    { name: 'Structure', fn: () => validateAnchorStructure(anchor) },
    { name: 'Strict Mode', fn: () => validateStrictMode(anchor) },
    { name: 'Architecture Mode', fn: () => validateArchitectureMode(anchor) },
    { name: 'Fallback Policy', fn: () => validateFallbackPolicy(anchor) },
    { name: 'Lanes', fn: () => validateLanes(anchor) },
    { name: 'Trust Store', fn: () => validateTrustStore(anchor) },
    { name: 'Verification Path', fn: () => validateVerificationPath(anchor) },
    { name: 'Forbidden Surfaces', fn: () => validateForbiddenSurfaces(anchor) },
  ];
  
  let passed = 0;
  let failed = 0;
  
  for (const { name, fn } of validations) {
    const result = fn();
    if (result.valid) {
      console.log(`[PASS] ${name}`);
      passed++;
    } else {
      console.error(`[FAIL] ${name}: ${result.reason}`);
      if (result.lane) console.error('       Lane:', result.lane);
      if (result.path) console.error('       Path:', result.path);
      if (result.key) console.error('       Key:', result.key);
      if (result.value !== undefined) console.error('       Value:', result.value);
      failed++;
    }
  }
  
  console.log('');
  console.log('========================================');
  console.log(`RESULTS: ${passed}/${validations.length} passed`);
  console.log('========================================');
  
  if (failed > 0) {
    console.error('\n[FATAL] System anchor validation FAILED');
    console.error('        DO NOT START PRODUCTION RUNTIME');
    console.error('        Fix anchor or runtime before proceeding');
    process.exit(1);
  }
  
  console.log('\n[PASS] System anchor validation successful');
  console.log('       Production phenotype is anchored and enforced');
  process.exit(0);
}

main();
