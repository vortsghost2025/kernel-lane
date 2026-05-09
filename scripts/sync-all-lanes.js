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

const FALLBACK_LANE_ROOTS = {
  archivist: 'S:/Archivist-Agent',
  swarmmind: 'S:/SwarmMind',
  kernel: 'S:/kernel-lane',
  library: 'S:/self-organizing-library',
};

const CANONICAL_FILES = [
  'scripts/lane-worker.js',
  'scripts/test-lane-worker-we4free.js',
  'scripts/generic-task-executor.js',
  'scripts/test-executor-v3.js',
  'scripts/completion-proof.js',
  'scripts/artifact-resolver.js',
  'scripts/execution-gate.js',
  'scripts/verification-domain-gate.js',
  'scripts/code-version-hash.js',
  'scripts/inbox-watcher.ps1',
  'scripts/heartbeat.js',
  'scripts/cross-lane-consistency-check.js',
  'scripts/autonomous-executor.js',
  'scripts/edit-lease-manager.js',
  'scripts/sync-all-lanes.js',
  'scripts/cross-lane-sync-gate.js',
  'scripts/output-provenance.js',
  'scripts/path-normalization-guard.js',
  'src/lane/SchemaValidator.js',
];

const CANONICAL_OWNER_LANE = 'archivist';
const CANONICAL_OWNER_REASON = 'Archivist is the governance root and coordination lane. All shared scripts must flow outward from Archivist only. Non-Archivist lanes must not propagate their copies back.';

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
      return roots;
    } catch (err) {
      console.warn(`[WARN] Failed to parse lane registry, using fallback roots: ${err.message}`);
    }
  }
  return { ...FALLBACK_LANE_ROOTS };
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

function chooseCanonicalState(states, enforceCanonicalOwner = true) {
  const existing = states.filter((s) => s.exists);
  if (existing.length === 0) return null;
  if (enforceCanonicalOwner) {
    const ownerState = existing.find((s) => s.lane === CANONICAL_OWNER_LANE);
    if (ownerState) return ownerState;
  }
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

  const allRelativePaths = [...CANONICAL_FILES, ...Array.from(broadcastPaths).sort()];

  for (const relativePath of allRelativePaths) {
    const states = getFileStatesAcrossLanes(relativePath, laneRoots);
    const canonical = chooseCanonicalState(states);
    if (!canonical) {
      syncRecords.push({
        file: relativePath,
        status: 'missing_everywhere',
        canonical_lane: null,
        canonical_sha256: null,
        targets: [],
      });
      continue;
    }

    const targets = [];
    for (const state of states) {
      if (state.lane === canonical.lane) continue;
      const needsCopy = !state.exists || state.sha256 !== canonical.sha256;
      if (!needsCopy) continue;
      totalFileTargets++;
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

    syncRecords.push({
      file: relativePath,
      status: allMatch ? 'already_aligned' : (DRY_RUN ? 'dry_run_drift_detected' : 'synced_or_drifted'),
      canonical_lane: canonical.lane,
      canonical_sha256: canonical.sha256,
      canonical_mtime: canonical.mtimeMs,
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

  for (const relativePath of CANONICAL_FILES) {
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
    file_sync: {
      records: syncRecords,
      copy_operations: syncDetails,
      attempted_targets: totalFileTargets,
      successful_or_planned_targets: syncedCount,
      failed_targets: syncFailedCount,
    },
    regression_checks: regressionChecks,
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

  const summary = report.summary;
  console.log(
    `\nSUMMARY: ${summary.synced_targets}/${summary.attempted_sync_targets} file targets ${report.dry_run ? 'would sync' : 'synced'}, ` +
    `${summary.lanes_all_tests_pass}/${summary.total_lanes} lanes pass all tests, ` +
    `${summary.healthy_lanes}/${summary.total_lanes} lanes healthy`
  );
}

main();
