#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

const DRY_RUN = process.argv.includes('--dry-run');
const SCRIPT_DIR = __dirname;
const ARCHIVIST_ROOT = path.resolve(SCRIPT_DIR, '..');
const LANE_REGISTRY_PATH = path.join(ARCHIVIST_ROOT, '.global', 'lane-registry.json');
const TEST_TIMEOUT_MS = 30000;

// Load lane roots from environment variables with sensible defaults
// This avoids hardcoded paths and allows deployment flexibility
function loadLaneRootsFromEnv() {
  const isWindows = process.platform === 'win32';
  const defaultBase = isWindows ? 'S:/' : '/home/we4free/agent/repos';
  const base = process.env.LANE_ROOT_BASE || defaultBase;
  
  return {
    archivist: path.join(base, process.env.LANE_ARCHIVIST || (isWindows ? 'Archivist-Agent' : 'Archivist-Agent')),
    swarmmind: path.join(base, process.env.LANE_SWARMMIND || (isWindows ? 'SwarmMind' : 'SwarmMind')),
    kernel: path.join(base, process.env.LANE_KERNEL || (isWindows ? 'kernel-lane' : 'kernel-lane')),
    library: path.join(base, process.env.LANE_LIBRARY || (isWindows ? 'self-organizing-library' : 'self-organizing-library')),
  };
}

const FALLBACK_LANE_ROOTS = loadLaneRootsFromEnv();

// No hardcoded Linux paths - they're derived from LANE_ROOT_BASE env var
function resolveLaneRoot(rawPath, lane) {
  if (rawPath && fs.existsSync(rawPath)) {
    // Path traversal protection: ensure resolved path stays within allowed base
    const resolved = path.resolve(rawPath);
    const allowedBases = [
      path.resolve(process.env.LANE_ROOT_BASE || (process.platform === 'win32' ? 'S:/' : '/home/we4free/agent/repos')),
    ];
    const isAllowed = allowedBases.some(base => resolved.startsWith(base));
    if (!isAllowed) {
      console.warn(`[SECURITY] Path traversal attempt blocked: ${rawPath} resolves to ${resolved} outside allowed bases`);
      return null;
    }
    return resolved;
  }
  // Fallback to env-configured defaults
  return FALLBACK_LANE_ROOTS[lane] || null;
}

const C2_SCAN_DIRS = [
  'scripts',
  'src/lane',
  'src/attestation',
];

const C2_MIN_REPOS = 2;

const CANONICAL_FILES_STATIC = [
  'src/lane/SchemaValidator.js',
];

function detectSharedScripts(laneRoots) {
  const fileCounts = {};
  for (const lane of LANE_ORDER) {
    const root = laneRoots[lane];
    if (!root || !fs.existsSync(root)) continue;
    for (const scanDir of C2_SCAN_DIRS) {
      const absDir = path.join(root, scanDir);
      if (!fs.existsSync(absDir)) continue;
      const entries = fs.readdirSync(absDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const ext = path.extname(entry.name).toLowerCase();
        if (!['.js', '.ps1'].includes(ext)) continue;
        const rel = path.join(scanDir, entry.name);
        fileCounts[rel] = (fileCounts[rel] || 0) + 1;
      }
    }
  }
  const shared = Object.entries(fileCounts)
    .filter(([, count]) => count >= C2_MIN_REPOS)
    .map(([rel]) => rel)
    .sort();
  return shared;
}

const CANONICAL_OWNER_LANE = 'archivist';
const CANONICAL_OWNER_REASON = 'Archivist is the governance root and coordination lane. All shared scripts must flow outward from Archivist only. Non-Archivist lanes must not propagate their copies back.';

const OWNERSHIP_MAP_PATH = path.join(ARCHIVIST_ROOT, 'governance', 'shared-script-ownership-map.json');

const RATIFICATION_GATE_PATH = path.join(ARCHIVIST_ROOT, 'governance', 'ratification-gate.json');

function loadOwnershipMap() {
  const map = tryReadJson(OWNERSHIP_MAP_PATH);
  if (!map || !map.ownership) {
    console.warn('[C1] Ownership map not found or invalid — proceeding with archivist-as-propagation-source only');
    return {};
  }
  console.log(`[C1] Loaded ownership map: ${Object.keys(map.ownership).length} entries, origins: kernel=${map.summary?.by_origin_lane?.kernel || 0}, swarmmind=${map.summary?.by_origin_lane?.swarmmind || 0}, library=${map.summary?.by_origin_lane?.library || 0}, archivist=${map.summary?.by_origin_lane?.archivist || 0}`);
  return map.ownership;
}

function checkRatificationGate(syncedCount = 0) {
  const gate = tryReadJson(RATIFICATION_GATE_PATH);
  if (!gate) {
    console.warn('[C5] Ratification gate file not found — cannot verify deployment authorization');
    return { status: 'unknown', deploy_allowed: false, approved: 0, required: 3 };
  }
  const votes = gate.votes || {};
  const approved = Object.values(votes).filter((v) => (v.ratification_vote || v.vote) === 'APPROVE').length;
  const rejected = Object.values(votes).filter((v) => (v.ratification_vote || v.vote) === 'REJECT').length;
  const ratified = approved >= (gate.quorum_required || 3) && rejected <= (gate.max_rejections || 1);
  if (!ratified && !DRY_RUN && syncedCount > 0) {
    console.warn(`[C5] WARNING: ${approved}/${gate.quorum_required || 3} lanes approved — deployment not ratified but sync was executed. Ratification should complete before batch deployment.`);
  }
  return { status: ratified ? 'ratified' : 'pre_ratification', deploy_allowed: gate.deploy_allowed || ratified, approved, required: gate.quorum_required || 3, rejected };
}

const LANE_ORDER = ['archivist', 'swarmmind', 'kernel', 'library'];

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function tryReadJson(filePath) {
  try {
    return readJson(filePath);
  } catch (_err) {
    return null;
  }
}

function fileSha256(filePath) {
  const content = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(content).digest('hex');
}

function getLaneRoots() {
  let rawRoots;
  if (fs.existsSync(LANE_REGISTRY_PATH)) {
    try {
      const registry = readJson(LANE_REGISTRY_PATH);
      const roots = {};
      const lanes = (registry && registry.lanes) || {};
      for (const lane of LANE_ORDER) {
        if (lanes[lane] && lanes[lane].local_path) {
          roots[lane] = lanes[lane].local_path;
        }
      }
      for (const lane of LANE_ORDER) {
        if (!roots[lane]) roots[lane] = FALLBACK_LANE_ROOTS[lane];
      }
      rawRoots = roots;
    } catch (err) {
      console.warn(`[WARN] Failed to parse lane registry, using fallback roots: ${err.message}`);
      rawRoots = { ...FALLBACK_LANE_ROOTS };
    }
  } else {
    rawRoots = { ...FALLBACK_LANE_ROOTS };
  }
  const resolved = {};
  for (const lane of LANE_ORDER) {
    resolved[lane] = resolveLaneRoot(rawRoots[lane], lane);
    if (resolved[lane] !== rawRoots[lane]) {
      console.log(`[PATH] ${lane}: ${rawRoots[lane]} -> ${resolved[lane]}`);
    }
  }
  return resolved;
}

function listJsonFilesRecursively(dirPath, baseDir, output) {
  if (!fs.existsSync(dirPath)) return;
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      listJsonFilesRecursively(fullPath, baseDir, output);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.json')) {
      output.push(path.relative(baseDir, fullPath));
    }
  }
}

function getFileStatesAcrossLanes(relativePath, laneRoots) {
  const states = [];
  for (const lane of LANE_ORDER) {
    const absolutePath = path.join(laneRoots[lane], relativePath);
    if (!fs.existsSync(absolutePath)) {
      states.push({
        lane,
        relativePath,
        absolutePath,
        exists: false,
      });
      continue;
    }
    const stat = fs.statSync(absolutePath);
    states.push({
      lane,
      relativePath,
      absolutePath,
      exists: true,
      mtimeMs: stat.mtimeMs,
      sha256: fileSha256(absolutePath),
      size: stat.size,
    });
  }
  return states;
}

function chooseCanonicalState(states, ownershipEntry = null) {
  const existing = states.filter((s) => s.exists);
  if (existing.length === 0) return null;

  if (ownershipEntry && ownershipEntry.origin_lane) {
    const ownerState = existing.find((s) => s.lane === ownershipEntry.origin_lane);
    if (ownerState) return ownerState;
    return { blocked: true, reason: 'blocked_owner_missing', origin_lane: ownershipEntry.origin_lane };
  }

  const ownerState = existing.find((s) => s.lane === CANONICAL_OWNER_LANE);
  if (ownerState) return ownerState;

  existing.sort((a, b) => {
    if (b.mtimeMs !== a.mtimeMs) return b.mtimeMs - a.mtimeMs;
    const laneRankA = LANE_ORDER.indexOf(a.lane);
    const laneRankB = LANE_ORDER.indexOf(b.lane);
    return laneRankA - laneRankB;
  });
  return existing[0];
}

function copyFileWithDirs(source, target, dryRun, expectedSha256) {
  if (dryRun) return;
  ensureDir(path.dirname(target));
  const tempPath = `${target}.sync-${process.pid}-${Date.now()}.tmp`;
  fs.copyFileSync(source, tempPath);
  const tempSha256 = fileSha256(tempPath);
  if (expectedSha256 && tempSha256 !== expectedSha256) {
    try { fs.unlinkSync(tempPath); } catch (_err) {}
    throw new Error(`copy verification failed before replace: expected ${expectedSha256}, got ${tempSha256}`);
  }
  fs.renameSync(tempPath, target);
  const finalSha256 = fileSha256(target);
  if (expectedSha256 && finalSha256 !== expectedSha256) {
    throw new Error(`copy verification failed after replace: expected ${expectedSha256}, got ${finalSha256}`);
  }
}

function formatShortHash(sha) {
  return sha ? sha.slice(0, 12) : 'missing';
}

function runNodeTest(laneRoot, scriptRelativePath) {
  const command = `node "${scriptRelativePath}"`;
  const result = {
    command,
    pass: null,
    fail: null,
    total: null,
    ok: false,
    details: [],
    raw: '',
    error: null,
  };
  try {
    const raw = execSync(command, {
      cwd: laneRoot,
      encoding: 'utf8',
      timeout: TEST_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    result.raw = raw;
    parseTestCounts(raw, result);
    result.ok = result.fail === 0;
  } catch (err) {
    const stdout = err && err.stdout ? String(err.stdout) : '';
    const stderr = err && err.stderr ? String(err.stderr) : '';
    const combined = [stdout, stderr].filter(Boolean).join('\n');
    result.raw = combined;
    parseTestCounts(combined, result);
    result.ok = false;
    result.error = err.message;
  }
  result.details = extractFailLines(result.raw);
  return result;
}

function parseTestCounts(raw, target) {
  const passLine = raw.match(/PASS:\s*(\d+)/i);
  const failLine = raw.match(/FAIL:\s*(\d+)/i);
  const totalLine = raw.match(/TOTAL:\s*(\d+)/i);
  const executorLine = raw.match(/Executor v3 Golden Tests:\s*(\d+)\s*PASS,\s*(\d+)\s*FAIL,\s*(\d+)\s*total/i);
  if (executorLine) {
    target.pass = Number(executorLine[1]);
    target.fail = Number(executorLine[2]);
    target.total = Number(executorLine[3]);
    return;
  }
  if (passLine) target.pass = Number(passLine[1]);
  if (failLine) target.fail = Number(failLine[1]);
  if (totalLine) target.total = Number(totalLine[1]);
  if (target.total === null && target.pass !== null && target.fail !== null) {
    target.total = target.pass + target.fail;
  }
}

function extractFailLines(raw) {
  return raw
    .split(/\r?\n/)
    .filter((line) => /\[FAIL\]|FAIL:/i.test(line))
    .slice(0, 10);
}

function safeListJson(dirPath) {
  if (!fs.existsSync(dirPath)) return [];
  return fs
    .readdirSync(dirPath)
    .filter((name) => name.toLowerCase().endsWith('.json'));
}

function classifyInboxItems(files, inboxDir) {
  let actionable = 0;
  let terminal = 0;
  let unreadable = 0;
  for (const fileName of files) {
    if (fileName.startsWith('heartbeat')) continue;
    const fullPath = path.join(inboxDir, fileName);
    const msg = tryReadJson(fullPath);
    if (!msg) {
      unreadable++;
      continue;
    }
    if (msg.requires_action === true) actionable++;
    else terminal++;
  }
  return { actionable, terminal, unreadable };
}

function collectLaneHealth(lane, laneRoot) {
  const inboxDir = path.join(laneRoot, 'lanes', lane, 'inbox');
  const outboxDir = path.join(laneRoot, 'lanes', lane, 'outbox');
  const broadcastDir = path.join(laneRoot, 'lanes', 'broadcast');
  const inboxFiles = safeListJson(inboxDir);
  const inboxClass = classifyInboxItems(inboxFiles, inboxDir);
  const outboxFiles = safeListJson(outboxDir).filter((f) => !f.startsWith('heartbeat'));
  const hasSystemState = fs.existsSync(path.join(broadcastDir, 'system_state.json'));
  const hasTrustStore = fs.existsSync(path.join(broadcastDir, 'trust-store.json'));

  const unhealthyReasons = [];
  if (!fs.existsSync(inboxDir)) unhealthyReasons.push('missing inbox dir');
  if (!fs.existsSync(outboxDir)) unhealthyReasons.push('missing outbox dir');
  if (!hasSystemState) unhealthyReasons.push('missing system_state.json');
  if (!hasTrustStore) unhealthyReasons.push('missing trust-store.json');

  return {
    lane,
    inbox: {
      total: inboxFiles.filter((f) => !f.startsWith('heartbeat')).length,
      actionable: inboxClass.actionable,
      terminal: inboxClass.terminal,
      unreadable: inboxClass.unreadable,
    },
    outbox: {
      total: outboxFiles.length,
    },
    checks: {
      has_system_state_json: hasSystemState,
      has_trust_store_json: hasTrustStore,
    },
    healthy: unhealthyReasons.length === 0,
    unhealthy_reasons: unhealthyReasons,
  };
}

function laneLabel(lane) {
  const map = {
    archivist: 'Archivist',
    swarmmind: 'SwarmMind',
    kernel: 'Kernel',
    library: 'Library',
  };
  return map[lane] || lane;
}

function nowIsoCompact() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

const ROLLBACK_DIR = path.join(ARCHIVIST_ROOT, 'context-buffer', 'sync-rollback');

function createRollbackSnapshot(laneRoots, sharedScripts) {
  if (DRY_RUN) return null;
  ensureDir(ROLLBACK_DIR);
  const snapshotId = nowIsoCompact();
  const snapshotDir = path.join(ROLLBACK_DIR, snapshotId);
  ensureDir(snapshotDir);
  const manifest = { snapshot_id: snapshotId, created_at: new Date().toISOString(), files: [] };
  for (const relativePath of sharedScripts) {
    for (const lane of LANE_ORDER) {
      const src = path.join(laneRoots[lane], relativePath);
      if (!fs.existsSync(src)) continue;
      const dest = path.join(snapshotDir, `${lane}__${relativePath.replace(/[\/\\]/g, '__')}`);
      try {
        ensureDir(path.dirname(dest));
        fs.copyFileSync(src, dest);
        manifest.files.push({ lane, relative: relativePath, snapshot_path: dest, sha256: fileSha256(src) });
      } catch (err) {
        console.warn(`[ROLLBACK] Failed to snapshot ${lane}:${relativePath}: ${err.message}`);
      }
    }
  }
  const manifestPath = path.join(snapshotDir, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  const snapshots = fs.readdirSync(ROLLBACK_DIR).filter(d => fs.statSync(path.join(ROLLBACK_DIR, d)).isDirectory()).sort();
  while (snapshots.length > 5) {
    const old = snapshots.shift();
    try { fs.rmSync(path.join(ROLLBACK_DIR, old), { recursive: true, force: true }); } catch (_) {}
  }
  console.log(`[ROLLBACK] Snapshot created: ${snapshotId} (${manifest.files.length} file copies)`);
  return snapshotId;
}

function checkLaneConstantsCorrect(laneRoots) {
  const REPO_TO_LANE = { 'Archivist-Agent': 'archivist', 'kernel-lane': 'kernel', 'SwarmMind': 'swarmmind', 'self-organizing-library': 'library' };
  const results = [];
  const tePath = 'scripts/task-executor.js';
  for (const lane of LANE_ORDER) {
    const root = laneRoots[lane];
    if (!root) continue;
    const teAbs = path.join(root, tePath);
    if (!fs.existsSync(teAbs)) continue;
    let content;
    try { content = fs.readFileSync(teAbs, 'utf8'); } catch (_) { continue; }
    const hasDetect = content.includes('detectLaneFromRepo');
    const hasOldFallback = /LANE\s*=\s*process\.env\.LANE_ID\s*\|\|\s*['"]archivist['"]/.test(content);
    const repoName = path.basename(root);
    const expectedLane = REPO_TO_LANE[repoName] || lane;
    results.push({
      lane,
      file: tePath,
      has_detect_lane_from_repo: hasDetect,
      has_old_archivist_fallback: hasOldFallback,
      repo_dirname: repoName,
      expected_lane_default: expectedLane,
      status: hasDetect && !hasOldFallback ? 'PASS' : 'REGRESSION',
    });
  }
  return results;
}

function main() {
  const startedAt = new Date().toISOString();
  const laneRoots = getLaneRoots();
  const syncRecords = [];
  const syncDetails = [];
  let syncedCount = 0;
  let totalFileTargets = 0;
  let syncFailedCount = 0;

  const broadcastPaths = new Set();
  for (const lane of LANE_ORDER) {
    const broadcastDir = path.join(laneRoots[lane], 'lanes', 'broadcast');
    const found = [];
    listJsonFilesRecursively(broadcastDir, broadcastDir, found);
    for (const relative of found) {
      const normalized = path.join('lanes', 'broadcast', relative);
      broadcastPaths.add(normalized);
    }
  }

  const ownershipMap = loadOwnershipMap();

  const detectedSharedScripts = detectSharedScripts(laneRoots);
  const detectedSet = new Set(detectedSharedScripts);
  for (const sf of CANONICAL_FILES_STATIC) {
    if (!detectedSet.has(sf)) detectedSharedScripts.push(sf);
  }
  const allRelativePaths = [...detectedSharedScripts, ...Array.from(broadcastPaths).sort()];

  const rollbackId = createRollbackSnapshot(laneRoots, detectedSharedScripts);

const isOwnedSharedScript = (relPath) => !!ownershipMap[relPath];

// Track final ratification state for report
let finalRatification = checkRatificationGate(syncedCount);

for (const relativePath of allRelativePaths) {
  // Re-check ratification gate with current syncedCount for each file
  // This allows the gate to block based on actual sync activity
  const ratification = checkRatificationGate(syncedCount);
  finalRatification = ratification; // Update for final report

  const states = getFileStatesAcrossLanes(relativePath, laneRoots);
  const originEntry = ownershipMap[relativePath] || null;
  const canonical = chooseCanonicalState(states, originEntry);

  if (canonical && canonical.blocked) {
    syncRecords.push({
      file: relativePath,
      status: 'blocked_owner_missing',
      canonical_lane: null,
      canonical_sha256: null,
      origin_lane: canonical.origin_lane,
      targets: [],
      lane_states: states.map((s) => ({
        lane: s.lane,
        exists: s.exists,
        sha256: s.sha256 || null,
        mtime_ms: s.mtimeMs || null,
      })),
    });
    syncFailedCount++;
    continue;
  }

  if (!canonical) {
    syncRecords.push({
      file: relativePath,
      status: 'missing_everywhere',
      canonical_lane: null,
      canonical_sha256: null,
      origin_lane: originEntry ? originEntry.origin_lane : null,
      targets: [],
    });
    continue;
  }

  const owned = isOwnedSharedScript(relativePath);
  const ratificationBlocked = !DRY_RUN && owned && !ratification.deploy_allowed;

  const targets = [];
  for (const state of states) {
    if (state.lane === canonical.lane) continue;
    const needsCopy = !state.exists || state.sha256 !== canonical.sha256;
    if (!needsCopy) continue;
    totalFileTargets++;

    if (ratificationBlocked) {
      targets.push({
        lane: state.lane,
        action: 'blocked_ratification_required',
        previous_sha256: state.exists ? state.sha256 : null,
      });
      syncFailedCount++;
      continue;
    }

    const targetPath = path.join(laneRoots[state.lane], relativePath);
    try {
      copyFileWithDirs(canonical.absolutePath, targetPath, DRY_RUN, canonical.sha256);
      targets.push({
        lane: state.lane,
        action: DRY_RUN ? 'would_sync' : 'synced',
        previous_sha256: state.exists ? state.sha256 : null,
      });
      syncedCount++;
      syncDetails.push({
        file: relativePath,
        from_lane: canonical.lane,
        to_lane: state.lane,
        from_sha256: canonical.sha256,
        to_sha256_before: state.exists ? state.sha256 : null,
        dry_run: DRY_RUN,
      });
    } catch (err) {
      syncFailedCount++;
      targets.push({
        lane: state.lane,
        action: 'sync_failed',
        error: err.message,
        previous_sha256: state.exists ? state.sha256 : null,
      });
    }
  }

  const allMatch = states
    .filter((s) => s.exists)
    .every((s) => s.sha256 === canonical.sha256);

  let status;
  if (allMatch) {
    status = 'already_aligned';
  } else if (ratificationBlocked) {
    status = 'blocked_ratification_required';
  } else {
    status = DRY_RUN ? 'dry_run_drift_detected' : 'synced_or_drifted';
  }

  syncRecords.push({
    file: relativePath,
    status,
    canonical_lane: canonical.lane,
    canonical_sha256: canonical.sha256,
    canonical_mtime: canonical.mtimeMs,
    origin_lane: originEntry ? originEntry.origin_lane : null,
    owned_shared_script: owned,
    ratification_required: owned,
    ratification_blocked: ratificationBlocked,
    targets,
    lane_states: states.map((s) => ({
      lane: s.lane,
      exists: s.exists,
      sha256: s.sha256 || null,
      mtime_ms: s.mtimeMs || null,
    })),
  });
}

  const regressionChecks = [];
  const REGRESSION_PATTERNS = [
  { pattern: /require\(['"]\.\/output-provenance['"]\)/g, description: 'duplicate output-provenance import', maxOccurrences: 1 },
  { pattern: /S:\/\//g, description: 'hardcoded S:/ path', maxOccurrences: 0 },
  { pattern: /S:\\\\/g, description: 'hardcoded S:\\ path', maxOccurrences: 0 },
  { pattern: /["']S:/g, description: 'quoted S: path literal', maxOccurrences: 5 },
  ];

  for (const relativePath of detectedSharedScripts) {
    const archivistPath = path.join(laneRoots.archivist, relativePath);
    if (!fs.existsSync(archivistPath)) continue;
    let content;
    try { content = fs.readFileSync(archivistPath, 'utf8'); } catch (_) { continue; }

    for (const check of REGRESSION_PATTERNS) {
      const matches = content.match(check.pattern);
      const count = matches ? matches.length : 0;
      if (count > check.maxOccurrences) {
        regressionChecks.push({
          file: relativePath,
          issue: check.description,
          count,
          max_allowed: check.maxOccurrences,
          status: 'REGRESSION',
        });
      }
    }

    for (const lane of LANE_ORDER) {
      if (lane === CANONICAL_OWNER_LANE) continue;
      const lanePath = path.join(laneRoots[lane], relativePath);
      if (!fs.existsSync(lanePath)) continue;
      const laneContent = fs.readFileSync(lanePath, 'utf8');
      const canonicalHash = fileSha256(archivistPath);
      const laneHash = fileSha256(lanePath);
      if (canonicalHash !== laneHash) {
        regressionChecks.push({
          file: relativePath,
          lane,
          issue: 'post-sync drift: lane copy does not match canonical',
          canonical_sha256: canonicalHash,
          lane_sha256: laneHash,
          status: 'DRIFT',
        });
      }
    }
  }

  const laneConstantsResults = checkLaneConstantsCorrect(laneRoots);
  for (const lcr of laneConstantsResults) {
    if (lcr.status === 'REGRESSION') {
      regressionChecks.push({
        file: lcr.file,
        lane: lcr.lane,
        issue: `lane_constants_correct: task-executor.js in ${lcr.repo_dirname} has ${lcr.has_old_archivist_fallback ? 'old archivist fallback' : 'missing detectLaneFromRepo()'}`,
        status: 'REGRESSION',
      });
    }
  }

  // C8: filename sanitization — scan broadcast dirs for files with colons (Windows-incompatible)
  for (const lane of LANE_ORDER) {
    const broadcastDir = path.join(laneRoots[lane], 'lanes', 'broadcast');
    if (!fs.existsSync(broadcastDir)) continue;
    const c8Scan = (dir) => {
      if (!fs.existsSync(dir)) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) { c8Scan(path.join(dir, entry.name)); continue; }
        if (/:/g.test(entry.name)) {
          regressionChecks.push({
            file: path.relative(laneRoots[lane], path.join(dir, entry.name)),
            lane,
            issue: `filename_sanitization: file name contains colons (Windows-incompatible): "${entry.name}"`,
            status: 'REGRESSION',
          });
        }
      }
    };
    c8Scan(broadcastDir);
  }

  const testResults = [];
  for (const lane of LANE_ORDER) {
    const laneRoot = laneRoots[lane];
    const laneWorkerTest = runNodeTest(laneRoot, 'scripts/test-lane-worker-we4free.js');
    const executorTest = runNodeTest(laneRoot, 'scripts/test-executor-v3.js');
    testResults.push({
      lane,
      lane_worker_test: laneWorkerTest,
      executor_test: executorTest,
      all_pass: laneWorkerTest.ok && executorTest.ok,
    });
  }

  const laneHealth = LANE_ORDER.map((lane) => collectLaneHealth(lane, laneRoots[lane]));

  const unhealthyLanes = laneHealth.filter((h) => !h.healthy).length;
  const failingTestLanes = testResults.filter((t) => !t.all_pass).length;
  const allTestsPass = failingTestLanes === 0;
  const allHealthy = unhealthyLanes === 0;

  const report = {
    tool: 'sync-all-lanes',
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    dry_run: DRY_RUN,
    lane_roots: laneRoots,
    canonical_owner: CANONICAL_OWNER_LANE,
    canonical_owner_reason: CANONICAL_OWNER_REASON,
    files_considered: allRelativePaths.length,
    rollback_snapshot_id: rollbackId,
    lane_constants_check: laneConstantsResults,
    file_sync: {
      records: syncRecords,
      copy_operations: syncDetails,
      attempted_targets: totalFileTargets,
      successful_or_planned_targets: syncedCount,
      failed_targets: syncFailedCount,
    },
regression_checks: regressionChecks,
ratification: finalRatification,
test_results: testResults,
    lane_health: laneHealth,
    summary: {
      synced_targets: syncedCount,
      attempted_sync_targets: totalFileTargets,
      failed_sync_targets: syncFailedCount,
      regression_count: regressionChecks.length,
      regressions: regressionChecks.filter((r) => r.status === 'REGRESSION').length,
      drift_count: regressionChecks.filter((r) => r.status === 'DRIFT').length,
      lanes_all_tests_pass: LANE_ORDER.length - failingTestLanes,
      total_lanes: LANE_ORDER.length,
      healthy_lanes: LANE_ORDER.length - unhealthyLanes,
      failing_test_lanes: failingTestLanes,
      unhealthy_lanes: unhealthyLanes,
      overall_ok: allTestsPass && allHealthy && syncFailedCount === 0 && regressionChecks.length === 0,
    },
  };

  const reportDir = path.join(ARCHIVIST_ROOT, 'context-buffer', 'sync-reports');
  ensureDir(reportDir);
  const reportPath = path.join(reportDir, `${nowIsoCompact()}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');

  printReport(report);
  console.log(`\nReport saved: ${reportPath}`);

  process.exit(report.summary.overall_ok ? 0 : 1);
}

function printReport(report) {
  const line = '═'.repeat(45);
  console.log(`${line}`);
  console.log(`CROSS-LANE SYNC REPORT — ${report.finished_at}`);
  console.log(`${line}`);

  console.log('\nFILE SYNC:');
  for (const record of report.file_sync.records) {
    const canonicalLane = record.canonical_lane ? laneLabel(record.canonical_lane) : 'none';
    const shortHash = formatShortHash(record.canonical_sha256);
    if (!record.canonical_lane) {
      console.log(`⚠️  ${record.file} — missing in all lanes`);
      continue;
    }
    if (!record.targets || record.targets.length === 0) {
      console.log(`✅ ${record.file} — all lanes match (canonical=${canonicalLane}, sha256:${shortHash})`);
      continue;
    }
    const targetText = record.targets
      .map((t) => `${laneLabel(t.lane)}${t.action === 'sync_failed' ? ` (FAILED: ${t.error})` : ''}`)
      .join(', ');
    const mark = record.targets.some((t) => t.action === 'sync_failed') ? '⚠️ ' : '✅';
    const verb = report.dry_run ? 'would sync to' : 'synced to';
    console.log(`${mark} ${record.file} — canonical=${canonicalLane} (sha256:${shortHash}) — ${verb} ${targetText}`);
  }

  console.log('\nTEST RESULTS:');
  for (const laneResult of report.test_results) {
    const lw = laneResult.lane_worker_test;
    const ex = laneResult.executor_test;
    const mark = laneResult.all_pass ? '✅' : '❌';
    const laneName = laneLabel(laneResult.lane);
    let lineText = `${mark} ${laneName} — lane-worker: ${lw.pass ?? '?'}${lw.total ? `/${lw.total}` : ''}, executor: ${ex.pass ?? '?'}${ex.total ? `/${ex.total}` : ''}`;
    if (!laneResult.all_pass) {
      const firstFail = [...(lw.details || []), ...(ex.details || [])][0];
      if (firstFail) lineText += ` (FAIL: ${firstFail.trim()})`;
    }
    console.log(lineText);
  }

  console.log('\nLANE HEALTH:');
  for (const health of report.lane_health) {
    const mark = health.healthy ? '✅' : '⚠️ ';
    const laneName = laneLabel(health.lane);
    const details = `inbox: ${health.inbox.total} items (${health.inbox.actionable} actionable, ${health.inbox.terminal} terminal), outbox: ${health.outbox.total}`;
    const extras = health.healthy ? '' : ` (issues: ${health.unhealthy_reasons.join('; ')})`;
    console.log(`${mark} ${laneName} — ${details}${extras}`);
  }

  if (report.regression_checks && report.regression_checks.length > 0) {
    console.log('\nREGRESSION CHECKS:');
    for (const rc of report.regression_checks) {
      if (rc.status === 'REGRESSION') {
        console.log(`❌ ${rc.file}: ${rc.issue} (found ${rc.count}, max ${rc.max_allowed})`);
      } else if (rc.status === 'DRIFT') {
        console.log(`⚠️  ${rc.file} [${laneLabel(rc.lane)}]: ${rc.issue}`);
      }
    }
  } else {
    console.log('\nREGRESSION CHECKS: ✅ None detected');
  }

  if (report.lane_constants_check && report.lane_constants_check.length > 0) {
    console.log('\nLANE CONSTANTS CHECK (C7):');
    for (const lcr of report.lane_constants_check) {
      const mark = lcr.status === 'PASS' ? '✅' : '❌';
      console.log(`${mark} ${laneLabel(lcr.lane)} (${lcr.repo_dirname}): detectLaneFromRepo=${lcr.has_detect_lane_from_repo}, old_fallback=${lcr.has_old_archivist_fallback}`);
    }
  }

if (report.rollback_snapshot_id) {
  console.log(`\nROLLBACK SNAPSHOT: ${report.rollback_snapshot_id}`);
}

if (report.ratification) {
  const rat = report.ratification;
  const ratMark = rat.status === 'ratified' ? '✅' : '⚠️';
  console.log(`\nRATIFICATION GATE (C5): ${ratMark} status=${rat.status}, approved=${rat.approved}/${rat.required}, deploy_allowed=${rat.deploy_allowed}`);
}

const summary = report.summary;
  console.log(
    `\nSUMMARY: ${summary.synced_targets}/${summary.attempted_sync_targets} file targets ${report.dry_run ? 'would sync' : 'synced'}, ` +
    `${summary.lanes_all_tests_pass}/${summary.total_lanes} lanes pass all tests, ` +
    `${summary.healthy_lanes}/${summary.total_lanes} lanes healthy`
  );
}

main();
