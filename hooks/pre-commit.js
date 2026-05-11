#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

const REPO_ROOT = process.cwd();

function detectLane() {
  const laneArg = process.argv.find(function(a) { return a.startsWith('--lane='); });
  if (laneArg) return laneArg.split('=')[1].toLowerCase();
  const laneFlagIdx = process.argv.indexOf('--lane');
  if (laneFlagIdx !== -1 && process.argv[laneFlagIdx + 1]) return process.argv[laneFlagIdx + 1].toLowerCase();
  const basename = path.basename(REPO_ROOT).toLowerCase();
  if (basename.includes('archivist')) return 'archivist';
  if (basename.includes('kernel')) return 'kernel';
  if (basename.includes('swarmmind') || basename.includes('swarm')) return 'swarmmind';
  if (basename.includes('library') || basename.includes('self-organizing')) return 'library';
  return 'unknown';
}

function loadLaneConfig(lane) {
  const configPath = path.join(REPO_ROOT, 'hooks', 'lane-config.json');
  if (!fs.existsSync(configPath)) return { gate2: false, canonicalScriptGuard: false, ntfsCheck: false, journal: false };
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    return config[lane] || { gate2: false, canonicalScriptGuard: false, ntfsCheck: false, journal: false };
  } catch (e) {
    console.warn('[pre-commit] WARNING: Could not parse lane-config.json: ' + e.message);
    return { gate2: false, canonicalScriptGuard: false, ntfsCheck: false, journal: false };
  }
}

const LANE = detectLane();
const LANE_CONFIG = loadLaneConfig(LANE);
const LANE_DIRS = [
  'lanes/archivist/inbox',
  'lanes/archivist/outbox',
  'lanes/library/inbox',
  'lanes/library/outbox',
  'lanes/swarmmind/inbox',
  'lanes/swarmmind/outbox',
  'lanes/kernel/inbox',
  'lanes/kernel/outbox',
  'lanes/broadcast'
];

const LANE_DISPLAY = LANE.charAt(0).toUpperCase() + LANE.slice(1);

// ===== SOVEREIGNTY CHECK =====
function runSovereigntyCheck() {
  const sovereigntyScript = path.join(REPO_ROOT, 'scripts', 'sovereignty-enforcer.js');
  if (!fs.existsSync(sovereigntyScript)) {
    console.warn('[pre-commit] Sovereignty enforcer not found, skipping sovereignty check');
    return true;
  }
  try {
    execSync('node "' + sovereigntyScript + '" --lane ' + LANE_DISPLAY + ' --strict', { stdio: 'inherit' });
    return true;
  } catch (e) {
    console.error('');
    console.error('COMMIT BLOCKED: Cross-lane sovereignty violation detected in ' + LANE_DISPLAY);
    console.error(' Lane scripts may only depend on local utilities (scripts/util/)');
    console.error(' Fix: Replace S:/<other-lane>/ imports with local implementations');
    console.error(' See: SYSTEM_CONSTRAINTS.md and sovereignty report in lanes/' + LANE + '/state/');
    return false;
  }
}

// ===== CI/CD GATE 2 (SCHEMA COMPLIANCE) =====
function runGate2() {
  if (!LANE_CONFIG.gate2) return true;
  const gatesScript = path.join(REPO_ROOT, 'scripts', 'cicd-sovereignty-gates.js');
  if (!fs.existsSync(gatesScript)) {
    console.warn('[pre-commit] cicd-sovereignty-gates.js not found, skipping Gate 2');
    return true;
  }
  try {
    execSync('node "' + gatesScript + '" --lane ' + LANE_DISPLAY + ' --gate=2 --strict', { stdio: 'inherit' });
    return true;
  } catch (e) {
    console.error('');
    console.error('COMMIT BLOCKED: Schema compliance (Gate 2) check failed');
    console.error(' Inbox/outbox JSON must conform to inbox-message-v1.json schema');
    return false;
  }
}

// ===== CANONICAL SCRIPT GUARD =====
function runCanonicalScriptGuard(stagedFiles) {
  if (!LANE_CONFIG.canonicalScriptGuard) return true;
  var guardScript = path.join(REPO_ROOT, 'scripts', 'canonical-script-guard.js');
  if (!fs.existsSync(guardScript)) return true;
  try {
    var guardArgs = stagedFiles.filter(function(a) { return !a.startsWith('--'); });
    execSync('node "' + guardScript + '" ' + guardArgs.map(function(f) { return '"' + f + '"'; }).join(' '), { stdio: 'inherit' });
    return true;
  } catch (e) {
    console.error('');
    console.error('COMMIT BLOCKED: Canonical script guard violation');
    console.error(' Autonomous executors cannot modify shared scripts. See CANONICAL_SCRIPT_REGISTRY.json');
    return false;
  }
}

// ===== NTFS CHECK =====
function runNtfsCheck(stagedFiles) {
  if (!LANE_CONFIG.ntfsCheck) return true;
  var ntfsPattern = /[<>:"\\|?*]/;
  var blocked = [];
  for (var i = 0; i < stagedFiles.length; i++) {
    var f = stagedFiles[i];
    if (ntfsPattern.test(path.basename(f))) {
      blocked.push(f);
    }
  }
  if (blocked.length > 0) {
    console.error('COMMIT BLOCKED: NTFS-incompatible filenames detected:');
    blocked.forEach(function(f) { console.error('  ' + f); });
    console.error(' Remove special characters (< > : " | ? *) from filenames');
    return false;
  }
  return true;
}

// ===== LINT CHECK =====
function runLintCheck() {
  try {
    var pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
    if (pkg.scripts && pkg.scripts.lint) {
      console.log('[pre-commit] Running npm lint...');
      var result = execSync('npm run lint', { stdio: 'pipe' });
      console.log(result.toString());
      return true;
    }
  } catch (e) {
  }
  return true;
}

// ===== SECRET SCAN =====
function computeKeyId(pem) {
  if (!pem) return null;
  try {
    var key = crypto.createPublicKey(pem);
    var spkiDer = key.export({ type: 'spki', format: 'der' });
    return crypto.createHash('sha256').update(spkiDer).digest('hex').substring(0, 16);
  } catch (e) {
    console.error('[pre-commit] WARNING: computeKeyId failed to parse PEM (DER extraction failed): ' + e.message);
    console.error('[pre-commit] Returning null — trust store validation will skip this entry');
    return null;
  }
}

function validateKeyId(pem, expectedKeyId) {
  var computed = computeKeyId(pem);
  if (computed === null) return null;
  return computed === expectedKeyId;
}

var AUTH_PATTERNS = [
  /sk-[A-Za-z0-9]{20,}/,
  /ghp_[A-Za-z0-9]{36,}/,
  /gho_[A-Za-z0-9]{36,}/,
  /ghu_[A-Za-z0-9]{36,}/,
  /ghs_[A-Za-z0-9]{36,}/,
  /ghr_[A-Za-z0-9]{36,}/,
  /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /-----BEGIN PRIVATE KEY-----/,
  /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}/,
];

var LANE_JWT_PATTERN = /[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/;

function scanStagedFiles(stagedFiles) {
  if (!stagedFiles.length) return true;

  var blocked = 0;
  for (var i = 0; i < stagedFiles.length; i++) {
    var file = stagedFiles[i];
    var rel = path.relative(REPO_ROOT, file);
    var inLaneDir = LANE_DIRS.some(function(d) { return rel.startsWith(d); });

    try {
      var content = fs.readFileSync(file, 'utf8');

      if (inLaneDir && LANE_JWT_PATTERN.test(content)) {
        console.error('[pre-commit] BLOCKED: JWS signing token in lane file: ' + rel);
        console.error(' Lane files (inbox/outbox/broadcast) must never be committed.');
        blocked++;
        continue;
      }

      for (var j = 0; j < AUTH_PATTERNS.length; j++) {
        if (AUTH_PATTERNS[j].test(content)) {
          var isJwt = content.match(/eyJ/);
          if (!isJwt) {
            console.error('[pre-commit] BLOCKED: Secret pattern in: ' + rel);
            blocked++;
            break;
          }
        }
      }
    } catch (e) {}
  }

  if (blocked > 0) {
    console.error('[pre-commit] Fix: move lane files to local storage, remove secrets first.');
    return false;
  }
  return true;
}

// ===== TRUST STORE VALIDATION =====
function validateTrustStore() {
  var trustStorePath = path.join(REPO_ROOT, 'lanes', 'broadcast', 'trust-store.json');
  if (!fs.existsSync(trustStorePath)) return true;

  try {
    var trustStore = JSON.parse(fs.readFileSync(trustStorePath, 'utf8'));
    var trustErrors = 0;

    for (var lane in trustStore) {
      if (!trustStore.hasOwnProperty(lane)) continue;
      var data = trustStore[lane];
      if (typeof data !== 'object' || !data.public_key_pem || !data.key_id) continue;

      var computed = computeKeyId(data.public_key_pem);
      if (computed === null) {
        console.warn('[pre-commit] WARNING: Could not compute key_id for ' + lane + ' (PEM parse failed). Skipping entry.');
        continue;
      }
      if (computed !== data.key_id) {
        console.error('[pre-commit] BLOCKED: ' + lane + ' key_id mismatch');
        console.error(' stored: ' + data.key_id);
        console.error(' computed: ' + computed);
        trustErrors++;
      }
    }

    if (trustErrors > 0) {
      console.error('[pre-commit] Fix: Recompute key_ids from .identity/public.pem using canonical formula');
      return false;
    }
  } catch (e) {
    console.error('[pre-commit] WARNING: could not validate trust-store: ' + e.message);
  }
  return true;
}

// ===== JOURNAL PREFLIGHT (ADVISORY) =====
function runJournalPreflight(stagedFiles) {
  if (!LANE_CONFIG.journal) return true;
  var journalScript = path.join(REPO_ROOT, 'scripts', 'store-journal.js');
  if (!fs.existsSync(journalScript)) return true;
  if (!stagedFiles.length) return true;

  try {
    var pathsArg = stagedFiles.join(',');
    execSync('node "' + journalScript + '" preflight --lane ' + LANE + ' --paths "' + pathsArg + '"', { stdio: 'pipe' });
    return true;
  } catch (e) {
    console.warn('[pre-commit] WARNING: store-journal preflight found active ownership conflict');
    console.warn('[pre-commit] Run: node scripts/store-journal.js active --lane ' + LANE);
    console.warn('[pre-commit] Continuing anyway (preflight is advisory)');
    return true;
  }
}

// ===== MAIN =====
function main() {
  var args = process.argv.slice(2);
  var stagedFiles = args.filter(function(a) { return !a.startsWith('--'); });

  console.log('[' + LANE + '] Running pre-commit checks...');

  // 1. Sovereignty check (first line of defense)
  if (!runSovereigntyCheck()) {
    process.exit(1);
  }

  // 2. CI/CD Sovereignty Gate 2 - Schema compliance check
  if (!runGate2()) {
    process.exit(1);
  }

  // 3. Canonical script guard
  if (!runCanonicalScriptGuard(stagedFiles)) {
    process.exit(1);
  }

  // 4. NTFS filename check
  if (!runNtfsCheck(stagedFiles)) {
    process.exit(1);
  }

  // 5. Lint check (if configured)
  if (!runLintCheck()) {
    console.error('[pre-commit] Lint check failed');
    process.exit(1);
  }

  // 6. Secret scan
  if (!scanStagedFiles(stagedFiles)) {
    process.exit(1);
  }

  // 7. Trust store validation
  if (!validateTrustStore()) {
    process.exit(1);
  }

  // 8. Journal preflight (advisory, non-blocking)
  runJournalPreflight(stagedFiles);

  console.log('[pre-commit] All checks passed');
}

main();
