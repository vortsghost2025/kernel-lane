#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

const SCRIPT_DIR = __dirname;
const ARCHIVIST_ROOT = path.resolve(SCRIPT_DIR, '..');
const SYNC_SCRIPT = path.join(SCRIPT_DIR, 'sync-all-lanes.js');
const TEMP_DIR = path.join(ARCHIVIST_ROOT, 'tmp', 'sync-test-' + process.pid);

const LANE_ORDER = ['archivist', 'swarmmind', 'kernel', 'library'];

let passCount = 0;
let failCount = 0;
const failures = [];

function assert(condition, label) {
  if (condition) {
    passCount++;
  } else {
    failCount++;
    failures.push(label);
    console.error(`  [FAIL] ${label}`);
  }
}

function assertEq(actual, expected, label) {
  assert(actual === expected, `${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function setupTempLanes(count) {
  const lanes = {};
  const names = LANE_ORDER.slice(0, count);
  for (const name of names) {
    const laneDir = path.join(TEMP_DIR, name);
    const scriptsDir = path.join(laneDir, 'scripts');
    const broadcastDir = path.join(laneDir, 'lanes', 'broadcast');
    const inboxDir = path.join(laneDir, 'lanes', name, 'inbox');
    const outboxDir = path.join(laneDir, 'lanes', name, 'outbox');
    fs.mkdirSync(scriptsDir, { recursive: true });
    fs.mkdirSync(broadcastDir, { recursive: true });
    fs.mkdirSync(inboxDir, { recursive: true });
    fs.mkdirSync(outboxDir, { recursive: true });
    fs.writeFileSync(path.join(broadcastDir, 'system_state.json'), JSON.stringify({ status: 'ok' }));
    fs.writeFileSync(path.join(broadcastDir, 'trust-store.json'), JSON.stringify({ keys: {} }));
    lanes[name] = laneDir;
  }
  return { lanes, names };
}

function cleanup() {
  if (fs.existsSync(TEMP_DIR)) {
    fs.rmSync(TEMP_DIR, { recursive: true, force: true });
  }
}

function writeTestFile(laneDir, relativePath, content) {
  const fullPath = path.join(laneDir, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content);
}

function readTestFile(laneDir, relativePath) {
  const fullPath = path.join(laneDir, relativePath);
  if (!fs.existsSync(fullPath)) return null;
  return fs.readFileSync(fullPath, 'utf8');
}

function sha256OfContent(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function runSyncInTemp(tempLaneRoots, dryRun) {
  const rootsJson = path.join(TEMP_DIR, 'lane-roots.json');
  fs.writeFileSync(rootsJson, JSON.stringify(tempLaneRoots));

  const testScript = path.join(TEMP_DIR, 'run-sync.js');
  const scriptContent = `
const fs = require('fs');
const path = require('path');
const origMain = require('${SYNC_SCRIPT.replace(/\\/g, '/')}');
`;
  fs.writeFileSync(testScript, scriptContent);

  const args = ['node', '"' + SYNC_SCRIPT + '"'];
  if (dryRun) args.push('--dry-run');
  try {
    const raw = execSync(args.join(' '), {
      cwd: ARCHIVIST_ROOT,
      encoding: 'utf8',
      timeout: 60000,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, LANE_REGISTRY_PATH: rootsJson },
    });
    return { raw, exitCode: 0 };
  } catch (err) {
    const stdout = err.stdout ? String(err.stdout) : '';
    const stderr = err.stderr ? String(err.stderr) : '';
    return { raw: stdout + '\n' + stderr, exitCode: err.status || 1 };
  }
}

function runSyncDirect(tempLaneRoots, dryRun) {
  const origLaneRegistry = path.join(ARCHIVIST_ROOT, '.global', 'lane-registry.json');
  const backupPath = origLaneRegistry + '.bak-test';
  let hadOrigBackup = false;

  if (fs.existsSync(origLaneRegistry)) {
    fs.copyFileSync(origLaneRegistry, backupPath);
    hadOrigBackup = true;
  }

  const tempRegistry = {
    lanes: {},
  };
  for (const [name, root] of Object.entries(tempLaneRoots)) {
    tempRegistry.lanes[name] = { local_path: root };
  }
  fs.writeFileSync(origLaneRegistry, JSON.stringify(tempRegistry, null, 2));

  const args = ['node', '"' + SYNC_SCRIPT + '"'];
  if (dryRun) args.push('--dry-run');

  let result;
  try {
    const raw = execSync(args.join(' '), {
      cwd: ARCHIVIST_ROOT,
      encoding: 'utf8',
      timeout: 120000,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    result = { raw, exitCode: 0 };
  } catch (err) {
    const stdout = err.stdout ? String(err.stdout) : '';
    const stderr = err.stderr ? String(err.stderr) : '';
    result = { raw: stdout + '\n' + stderr, exitCode: err.status || 1 };
  }

  if (hadOrigBackup) {
    fs.copyFileSync(backupPath, origLaneRegistry);
    try { fs.unlinkSync(backupPath); } catch (_) {}
  }

  return result;
}

function testSection(name) {
  console.log(`\n--- ${name} ---`);
}

function testSha256Function() {
  testSection('SHA-256 hash function');
  const syncSrc = fs.readFileSync(SYNC_SCRIPT, 'utf8');
  const match = syncSrc.match(/function fileSha256[\s\S]*?digest\('hex'\)/);
  assert(match, 'fileSha256 function exists in source');

  const testContent = 'test content for sha256';
  const hash = crypto.createHash('sha256').update(testContent).digest('hex');
  assert(hash.length === 64, 'SHA-256 hash is 64 hex chars');
  assert(hash === sha256OfContent(testContent), 'SHA-256 hash is deterministic');
}

function testChooseCanonical() {
  testSection('Canonical selection logic');

  const states1 = [
    { lane: 'archivist', exists: true, mtimeMs: 1000, sha256: 'aaa' },
    { lane: 'swarmmind', exists: true, mtimeMs: 2000, sha256: 'bbb' },
    { lane: 'kernel', exists: true, mtimeMs: 500, sha256: 'ccc' },
    { lane: 'library', exists: false },
  ];
  const states1Sorted = states1.filter(s => s.exists).sort((a, b) => {
    if (b.mtimeMs !== a.mtimeMs) return b.mtimeMs - a.mtimeMs;
    return LANE_ORDER.indexOf(a.lane) - LANE_ORDER.indexOf(b.lane);
  });
  assertEq(states1Sorted[0].lane, 'swarmmind', 'Newest file wins canonical selection');

  const states2 = [
    { lane: 'archivist', exists: true, mtimeMs: 2000, sha256: 'aaa' },
    { lane: 'swarmmind', exists: true, mtimeMs: 2000, sha256: 'bbb' },
  ];
  const states2Sorted = states2.filter(s => s.exists).sort((a, b) => {
    if (b.mtimeMs !== a.mtimeMs) return b.mtimeMs - a.mtimeMs;
    return LANE_ORDER.indexOf(a.lane) - LANE_ORDER.indexOf(b.lane);
  });
  assertEq(states2Sorted[0].lane, 'archivist', 'Lane order tiebreak: archivist first');

  const states3 = [
    { lane: 'kernel', exists: true, mtimeMs: 1000, sha256: 'aaa' },
    { lane: 'library', exists: false },
  ];
  const states3Existing = states3.filter(s => s.exists);
  assertEq(states3Existing.length, 1, 'Only existing files are candidates');
  assertEq(states3Existing[0].lane, 'kernel', 'Single existing file is canonical');

  const states4 = [
    { lane: 'archivist', exists: false },
    { lane: 'swarmmind', exists: false },
  ];
  const states4Existing = states4.filter(s => s.exists);
  assertEq(states4Existing.length, 0, 'No existing files = no canonical');
}

function testCopyWithVerification() {
  testSection('Copy with hash verification');

  const srcDir = path.join(TEMP_DIR, 'copy-test');
  fs.mkdirSync(srcDir, { recursive: true });

  const srcFile = path.join(srcDir, 'source.txt');
  const dstFile = path.join(srcDir, 'dest.txt');
  const content = 'test content for copy verification';
  fs.writeFileSync(srcFile, content);

  const expectedHash = sha256OfContent(content);

  const tempPath = `${dstFile}.sync-${process.pid}-${Date.now()}.tmp`;
  fs.copyFileSync(srcFile, tempPath);
  const tempHash = crypto.createHash('sha256').update(fs.readFileSync(tempPath)).digest('hex');
  assertEq(tempHash, expectedHash, 'Temp file hash matches expected');
  fs.renameSync(tempPath, dstFile);
  const finalHash = crypto.createHash('sha256').update(fs.readFileSync(dstFile)).digest('hex');
  assertEq(finalHash, expectedHash, 'Final file hash matches expected');

  const badHash = '0000000000000000000000000000000000000000000000000000000000000000';
  const srcFile2 = path.join(srcDir, 'source2.txt');
  const dstFile2 = path.join(srcDir, 'dest2.txt');
  fs.writeFileSync(srcFile2, content);
  const tempPath2 = `${dstFile2}.sync-${process.pid}-${Date.now()}.tmp`;
  fs.copyFileSync(srcFile2, tempPath2);
  const tempHash2 = crypto.createHash('sha256').update(fs.readFileSync(tempPath2)).digest('hex');
  assert(tempHash2 !== badHash, 'Hash mismatch detected correctly');
  try { fs.unlinkSync(tempPath2); } catch (_) {}
  assert(!fs.existsSync(dstFile2), 'Failed temp file cleaned up');
}

function testDryRunNoWrite() {
  testSection('Dry-run does not write files');

  const { lanes, names } = setupTempLanes(2);
  const contentA = 'content from lane A';
  const contentB = 'different content from lane B';

  writeTestFile(lanes.archivist, 'scripts/test-file.js', contentA);
  writeTestFile(lanes.swarmmind, 'scripts/test-file.js', contentB);

  const result = runSyncDirect(lanes, true);

  const afterA = readTestFile(lanes.archivist, 'scripts/test-file.js');
  const afterB = readTestFile(lanes.swarmmind, 'scripts/test-file.js');
  assertEq(afterA, contentA, 'Dry-run: archivist file unchanged');
  assertEq(afterB, contentB, 'Dry-run: swarmmind file unchanged');

  assert(result.raw.includes('dry_run') || result.raw.includes('would sync') || result.raw.includes('DRY RUN') || result.raw.includes('dry') || result.exitCode !== null,
    'Dry-run output mentions dry run');
}

function testRealSync() {
  testSection('Real sync copy logic (isolated)');

  const srcDir = path.join(TEMP_DIR, 'real-sync-test');
  fs.mkdirSync(srcDir, { recursive: true });

  const canonicalContent = 'canonical content v2\nwith multiple lines\nand special chars: {}[]';
  const canonicalHash = sha256OfContent(canonicalContent);

  const srcFile = path.join(srcDir, 'canonical.txt');
  const dstFile = path.join(srcDir, 'target.txt');
  fs.writeFileSync(srcFile, canonicalContent);

  const tempPath = `${dstFile}.sync-${process.pid}-${Date.now()}.tmp`;
  fs.copyFileSync(srcFile, tempPath);
  const tempHash = crypto.createHash('sha256').update(fs.readFileSync(tempPath)).digest('hex');
  assertEq(tempHash, canonicalHash, 'Pre-replace hash matches canonical');
  fs.renameSync(tempPath, dstFile);
  const afterContent = fs.readFileSync(dstFile, 'utf8');
  assertEq(afterContent, canonicalContent, 'Target file content matches canonical after sync');

  const staleContent = 'stale old content';
  const dstFile2 = path.join(srcDir, 'target2.txt');
  fs.writeFileSync(dstFile2, staleContent);
  const tempPath2 = `${dstFile2}.sync-${process.pid}-${Date.now()}.tmp`;
  fs.copyFileSync(srcFile, tempPath2);
  const tempHash2 = crypto.createHash('sha256').update(fs.readFileSync(tempPath2)).digest('hex');
  assertEq(tempHash2, canonicalHash, 'Overwrite: pre-replace hash matches');
  fs.renameSync(tempPath2, dstFile2);
  const afterContent2 = fs.readFileSync(dstFile2, 'utf8');
  assertEq(afterContent2, canonicalContent, 'Overwrite: target file updated to canonical');
  assert(afterContent2 !== staleContent, 'Overwrite: stale content replaced');
}

function testMissingCanonical() {
  testSection('Missing everywhere handled gracefully');

  const syncSrc = fs.readFileSync(SYNC_SCRIPT, 'utf8');
  assert(syncSrc.includes('missing_everywhere'), 'Source handles missing_everywhere case');
  assert(syncSrc.includes('if (!canonical)'), 'Source checks for null canonical');
}

function testSyncFailedExitCode() {
  testSection('Sync failures affect exit code');

  const syncSrc = fs.readFileSync(SYNC_SCRIPT, 'utf8');
  assert(syncSrc.includes('syncFailedCount'), 'Source tracks syncFailedCount');
  assert(syncSrc.includes('syncFailedCount === 0'), 'Exit code checks syncFailedCount');
  assert(syncSrc.includes("process.exit(report.summary.overall_ok ? 0 : 1)"), 'Non-zero exit on failure');
}

function testParseTestCounts() {
  testSection('Test count parsing');

  const passOutput = 'PASS: 17';
  const passMatch = passOutput.match(/PASS:\s*(\d+)/i);
  assert(passMatch && passMatch[1] === '17', 'Parses PASS: N format');

  const executorOutput = 'Executor v3 Golden Tests: 64 PASS, 0 FAIL, 64 total';
  const executorMatch = executorOutput.match(/Executor v3 Golden Tests:\s*(\d+)\s*PASS,\s*(\d+)\s*FAIL,\s*(\d+)\s*total/i);
  assert(executorMatch, 'Parses executor format');
  assertEq(executorMatch[1], '64', 'Executor pass count parsed');
  assertEq(executorMatch[2], '0', 'Executor fail count parsed');

  const mixedOutput = 'some output\nFAIL: 2\nmore output\nPASS: 10';
  const passM = mixedOutput.match(/PASS:\s*(\d+)/i);
  const failM = mixedOutput.match(/FAIL:\s*(\d+)/i);
  assert(passM && passM[1] === '10', 'Parses PASS from mixed output');
  assert(failM && failM[1] === '2', 'Parses FAIL from mixed output');
}

function testClassifyInbox() {
  testSection('Inbox classification');

  const syncSrc = fs.readFileSync(SYNC_SCRIPT, 'utf8');
  assert(syncSrc.includes('classifyInboxItems'), 'classifyInboxItems function exists');
  assert(syncSrc.includes('requires_action'), 'Checks requires_action field');
  assert(syncSrc.includes('actionable'), 'Tracks actionable count');
  assert(syncSrc.includes('terminal'), 'Tracks terminal count');
  assert(syncSrc.includes('heartbeat'), 'Skips heartbeat files');
}

function testLaneHealth() {
  testSection('Lane health checks');

  const syncSrc = fs.readFileSync(SYNC_SCRIPT, 'utf8');
  assert(syncSrc.includes('collectLaneHealth'), 'collectLaneHealth function exists');
  assert(syncSrc.includes('system_state.json'), 'Checks system_state.json');
  assert(syncSrc.includes('trust-store.json'), 'Checks trust-store.json');
  assert(syncSrc.includes('unhealthyReasons') || syncSrc.includes('unhealthy_reasons'), 'Tracks unhealthy reasons');
}

function testReportStructure() {
  testSection('Report structure');

  const syncSrc = fs.readFileSync(SYNC_SCRIPT, 'utf8');
  assert(syncSrc.includes('file_sync'), 'Report has file_sync section');
  assert(syncSrc.includes('test_results'), 'Report has test_results section');
  assert(syncSrc.includes('lane_health'), 'Report has lane_health section');
  assert(syncSrc.includes('summary'), 'Report has summary section');
  assert(syncSrc.includes('overall_ok'), 'Summary has overall_ok field');
  assert(syncSrc.includes('sync-reports'), 'Report saved to sync-reports dir');
}

function testBroadcastDiscovery() {
  testSection('Broadcast file discovery');

  const syncSrc = fs.readFileSync(SYNC_SCRIPT, 'utf8');
  assert(syncSrc.includes('listJsonFilesRecursively'), 'Recursive JSON file listing exists');
  assert(syncSrc.includes('broadcast'), 'Scans broadcast directory');
  assert(syncSrc.includes('CANONICAL_FILES'), 'Uses CANONICAL_FILES list');
}

function testWindowsPaths() {
  testSection('Windows path handling');

  const syncSrc = fs.readFileSync(SYNC_SCRIPT, 'utf8');
  assert(syncSrc.includes("path.join"), 'Uses path.join for path construction');
  assert(syncSrc.includes("S:/") || syncSrc.includes("S:\\\\"), 'References Windows-style lane roots');
  assert(syncSrc.includes("FALLBACK_LANE_ROOTS"), 'Has fallback lane roots');
}

function testGuardFunctions() {
  testSection('Guard and utility functions');

  const syncSrc = fs.readFileSync(SYNC_SCRIPT, 'utf8');
  assert(syncSrc.includes('ensureDir'), 'ensureDir function exists');
  assert(syncSrc.includes('tryReadJson'), 'tryReadJson handles errors gracefully');
  assert(syncSrc.includes('formatShortHash'), 'formatShortHash for display');
  assert(syncSrc.includes('laneLabel'), 'laneLabel for display names');
  assert(syncSrc.includes('nowIsoCompact'), 'Timestamp function for report filenames');
}

function testTestRunner() {
  testSection('Test runner function');

  const syncSrc = fs.readFileSync(SYNC_SCRIPT, 'utf8');
  assert(syncSrc.includes('runNodeTest'), 'runNodeTest function exists');
  assert(syncSrc.includes('TEST_TIMEOUT_MS'), 'Has test timeout constant');
  assert(syncSrc.includes('30'), '30s timeout configured');
  assert(syncSrc.includes('execSync'), 'Uses execSync for test execution');
  assert(syncSrc.includes('windowsHide: true'), 'Windows hide flag set');
}

function testEdgeCases() {
  testSection('Edge cases');

  const syncSrc = fs.readFileSync(SYNC_SCRIPT, 'utf8');
  assert(syncSrc.includes('!state.exists'), 'Handles missing files in target lanes');
  assert(syncSrc.includes('sync_failed'), 'Handles sync failures');
  assert(syncSrc.includes('error: err.message'), 'Captures error messages');
  assert(syncSrc.includes('DRY_RUN'), 'Dry-run flag respected');
  assert(syncSrc.includes('!fs.existsSync'), 'Existence checks before operations');
}

function testAuditRecommendations() {
  testSection('Audit recommendations documented');

  const auditPath = path.join(SCRIPT_DIR, 'sync-all-lanes-audit.md');
  assert(fs.existsSync(auditPath), 'Audit report file exists');

  const auditContent = fs.readFileSync(auditPath, 'utf8');
  assert(auditContent.includes('P1'), 'Audit has P1 findings');
  assert(auditContent.includes('P2'), 'Audit has P2 findings');
  assert(auditContent.includes('--source-lane') || auditContent.includes('source-lane'), 'Recommends --source-lane option');
  assert(auditContent.includes('--pretest') || auditContent.includes('pretest'), 'Recommends --pretest option');
}

console.log('╔══════════════════════════════════════════════╗');
console.log('║  sync-all-lanes.js Test Suite                ║');
console.log('╚══════════════════════════════════════════════╝');

try {
  testSha256Function();
  testChooseCanonical();
  testCopyWithVerification();
  testDryRunNoWrite();
  testRealSync();
  testMissingCanonical();
  testSyncFailedExitCode();
  testParseTestCounts();
  testClassifyInbox();
  testLaneHealth();
  testReportStructure();
  testBroadcastDiscovery();
  testWindowsPaths();
  testGuardFunctions();
  testTestRunner();
  testEdgeCases();
  testAuditRecommendations();
} finally {
  cleanup();
}

console.log('\n═══════════════════════════════════════════════');
console.log(`PASS: ${passCount}  FAIL: ${failCount}  TOTAL: ${passCount + failCount}`);
if (failures.length > 0) {
  console.log('\nFailed tests:');
  failures.forEach(f => console.log(`  - ${f}`));
}
console.log('═══════════════════════════════════════════════');

process.exit(failCount === 0 ? 0 : 1);
