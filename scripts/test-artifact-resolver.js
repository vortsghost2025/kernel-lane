#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { ArtifactResolver } = require('./artifact-resolver');
const { LaneWorker } = require('./lane-worker');

function mkDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function rmDir(p) {
  if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
}

let passed = 0;
let failed = 0;
const results = [];

function test(name, fn) {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-'));
  try {
    fn(tmpRoot);
    passed++;
    results.push({ name, status: 'PASS' });
    console.log(`[PASS] ${name}`);
  } catch (err) {
    failed++;
    results.push({ name, status: 'FAIL', error: err.message });
    console.error(`[FAIL] ${name}: ${err.message}`);
  } finally {
    rmDir(tmpRoot);
  }
}

// ============================================================
// TEST 1: evidence_exchange artifact path exists -> processed allowed
// ============================================================
test('evidence_exchange artifact path exists -> processed allowed', (tmpRoot) => {
  const resolver = new ArtifactResolver({ allowedRoots: [tmpRoot], dryRun: false });

  const artifactDir = path.join(tmpRoot, 'lanes', 'archivist', 'outbox');
  mkDir(artifactDir);
  const artifactPath = path.join(artifactDir, 'result.json');
  fs.writeFileSync(artifactPath, JSON.stringify({ done: true }), 'utf8');

  const inbox = path.join(tmpRoot, 'lanes', 'archivist', 'inbox');
  mkDir(inbox);

  const msg = {
    id: 'artifact-exists',
    from: 'library',
    to: 'archivist',
    type: 'task',
    priority: 'P1',
    timestamp: new Date().toISOString(),
    requires_action: true,
    subject: 'Has real artifact',
    body: 'Artifact exists on disk',
    evidence: { required: true },
    evidence_exchange: {
      artifact_path: artifactPath,
      artifact_type: 'benchmark',
      delivered_at: new Date().toISOString(),
    },
  };

  const worker = new LaneWorker({
    repoRoot: tmpRoot,
    lane: 'archivist',
    dryRun: false,
    config: {
      repoRoot: tmpRoot,
      lane: 'archivist',
      queues: {
        inbox,
        actionRequired: path.join(inbox, 'action-required'),
        inProgress: path.join(inbox, 'in-progress'),
        processed: path.join(inbox, 'processed'),
        blocked: path.join(inbox, 'blocked'),
        quarantine: path.join(inbox, 'quarantine'),
      },
    },
    schemaValidator: () => ({ valid: true, errors: [] }),
    signatureValidator: () => ({ valid: true, reason: null, details: null }),
    artifactResolver: resolver,
  });

  const msgPath = path.join(inbox, '2026-01-01_artifact_exists.json');
  fs.writeFileSync(msgPath, JSON.stringify(msg, null, 2), 'utf8');

  const summary = worker.processOnce();
  assert.strictEqual(summary.routed.processed, 1, 'Must route to processed');
  assert.strictEqual(summary.routed.blocked, 0);
});

// ============================================================
// TEST 2: evidence_exchange artifact path missing -> blocked
// ============================================================
test('evidence_exchange artifact path missing -> blocked', (tmpRoot) => {
  const resolver = new ArtifactResolver({ allowedRoots: [tmpRoot], dryRun: false });

  const inbox = path.join(tmpRoot, 'lanes', 'archivist', 'inbox');
  mkDir(inbox);

  const msg = {
    id: 'artifact-missing',
    from: 'library',
    to: 'archivist',
    type: 'task',
    priority: 'P1',
    timestamp: new Date().toISOString(),
    requires_action: true,
    subject: 'Artifact gone',
    body: 'Artifact does not exist on disk',
    evidence: { required: true },
    evidence_exchange: {
      artifact_path: path.join(tmpRoot, 'nonexistent', 'result.json'),
      artifact_type: 'benchmark',
      delivered_at: new Date().toISOString(),
    },
  };

  const worker = new LaneWorker({
    repoRoot: tmpRoot,
    lane: 'archivist',
    dryRun: false,
    config: {
      repoRoot: tmpRoot,
      lane: 'archivist',
      queues: {
        inbox,
        actionRequired: path.join(inbox, 'action-required'),
        inProgress: path.join(inbox, 'in-progress'),
        processed: path.join(inbox, 'processed'),
        blocked: path.join(inbox, 'blocked'),
        quarantine: path.join(inbox, 'quarantine'),
      },
    },
    schemaValidator: () => ({ valid: true, errors: [] }),
    signatureValidator: () => ({ valid: true, reason: null, details: null }),
    artifactResolver: resolver,
  });

  const msgPath = path.join(inbox, '2026-01-01_artifact_missing.json');
  fs.writeFileSync(msgPath, JSON.stringify(msg, null, 2), 'utf8');

  const summary = worker.processOnce();
  assert.strictEqual(summary.routed.processed, 0, 'Must NOT route to processed');
  assert.strictEqual(summary.routed.blocked, 1, 'Must route to blocked');
  assert.strictEqual(summary.routes[0].reason, 'EXECUTION_NOT_VERIFIED');
});

// ============================================================
// TEST 3: legacy completion_artifact_path exists -> processed allowed
// ============================================================
test('legacy completion_artifact_path exists -> processed allowed', (tmpRoot) => {
  const resolver = new ArtifactResolver({ allowedRoots: [tmpRoot], dryRun: false });

  const artifactDir = path.join(tmpRoot, 'output');
  mkDir(artifactDir);
  const artifactPath = path.join(artifactDir, 'legacy-result.json');
  fs.writeFileSync(artifactPath, JSON.stringify({ legacy: true }), 'utf8');

  const inbox = path.join(tmpRoot, 'lanes', 'archivist', 'inbox');
  mkDir(inbox);

  const msg = {
    id: 'legacy-artifact-exists',
    from: 'library',
    to: 'archivist',
    type: 'task',
    priority: 'P2',
    timestamp: new Date().toISOString(),
    requires_action: true,
    subject: 'Legacy artifact',
    body: 'Has completion_artifact_path that exists',
    completion_artifact_path: artifactPath,
    terminal_decision: 'completed',
  };

  const worker = new LaneWorker({
    repoRoot: tmpRoot,
    lane: 'archivist',
    dryRun: false,
    config: {
      repoRoot: tmpRoot,
      lane: 'archivist',
      queues: {
        inbox,
        actionRequired: path.join(inbox, 'action-required'),
        inProgress: path.join(inbox, 'in-progress'),
        processed: path.join(inbox, 'processed'),
        blocked: path.join(inbox, 'blocked'),
        quarantine: path.join(inbox, 'quarantine'),
      },
    },
    schemaValidator: () => ({ valid: true, errors: [] }),
    signatureValidator: () => ({ valid: true, reason: null, details: null }),
    artifactResolver: resolver,
  });

  const msgPath = path.join(inbox, '2026-01-01_legacy_exists.json');
  fs.writeFileSync(msgPath, JSON.stringify(msg, null, 2), 'utf8');

  const summary = worker.processOnce();
  assert.strictEqual(summary.routed.processed, 1, 'Must route to processed');
});

// ============================================================
// TEST 4: legacy completion_artifact_path missing -> blocked
// ============================================================
test('legacy completion_artifact_path missing -> blocked', (tmpRoot) => {
  const resolver = new ArtifactResolver({ allowedRoots: [tmpRoot], dryRun: false });

  const inbox = path.join(tmpRoot, 'lanes', 'archivist', 'inbox');
  mkDir(inbox);

  const msg = {
    id: 'legacy-artifact-missing',
    from: 'library',
    to: 'archivist',
    type: 'task',
    priority: 'P2',
    timestamp: new Date().toISOString(),
    requires_action: true,
    subject: 'Legacy artifact gone',
    body: 'Has completion_artifact_path that does not exist',
    completion_artifact_path: path.join(tmpRoot, 'nope', 'missing.json'),
    terminal_decision: 'completed',
  };

  const worker = new LaneWorker({
    repoRoot: tmpRoot,
    lane: 'archivist',
    dryRun: false,
    config: {
      repoRoot: tmpRoot,
      lane: 'archivist',
      queues: {
        inbox,
        actionRequired: path.join(inbox, 'action-required'),
        inProgress: path.join(inbox, 'in-progress'),
        processed: path.join(inbox, 'processed'),
        blocked: path.join(inbox, 'blocked'),
        quarantine: path.join(inbox, 'quarantine'),
      },
    },
    schemaValidator: () => ({ valid: true, errors: [] }),
    signatureValidator: () => ({ valid: true, reason: null, details: null }),
    artifactResolver: resolver,
  });

  const msgPath = path.join(inbox, '2026-01-01_legacy_missing.json');
  fs.writeFileSync(msgPath, JSON.stringify(msg, null, 2), 'utf8');

  const summary = worker.processOnce();
  assert.strictEqual(summary.routed.processed, 0);
  assert.strictEqual(summary.routed.blocked, 1);
  assert.strictEqual(summary.routes[0].reason, 'EXECUTION_NOT_VERIFIED');
});

// ============================================================
// TEST 5: path traversal attempt is rejected
// ============================================================
test('path traversal attempt is rejected', (tmpRoot) => {
  const resolver = new ArtifactResolver({ allowedRoots: [tmpRoot], dryRun: false });

  // Pass raw string with .. — path.join would resolve it, so we test raw input
  const traversalPath = tmpRoot + '/../../etc/passwd';
  const result = resolver.resolveExists(traversalPath);
  assert.strictEqual(result.exists, false);
  assert.strictEqual(result.reason, 'PATH_TRAVERSAL_REJECTED');
});

// ============================================================
// TEST 6: cross-lane artifact path requires explicit allowed root
// ============================================================
test('cross-lane artifact path outside allowed roots is rejected', (tmpRoot) => {
  const resolver = new ArtifactResolver({ allowedRoots: [tmpRoot], dryRun: false });

  const outsidePath = 'C:/Windows/System32/config/something.json';
  const result = resolver.resolveExists(outsidePath);
  assert.strictEqual(result.exists, false);
  assert.strictEqual(result.reason, 'OUTSIDE_ALLOWED_ROOTS');
});

// ============================================================
// TEST 7: completion_message_id (non-path proof) accepted without filesystem check
// ============================================================
test('completion_message_id accepted without filesystem check', (tmpRoot) => {
  const resolver = new ArtifactResolver({ allowedRoots: [tmpRoot], dryRun: false });

  const msg = {
    id: 'msg-ref',
    requires_action: true,
    completion_message_id: '2026-01-01_some_ack.json',
    terminal_decision: 'resolved',
  };

  const result = resolver.resolveMessage(msg);
  assert.strictEqual(result.resolved, true, 'Non-path proof should be accepted without FS check');
  assert.strictEqual(result.reason, 'NON_PATH_PROOF_ACCEPTED');
});

// ============================================================
// TEST 8: dry-run resolver skips filesystem check
// ============================================================
test('dry-run resolver skips filesystem check', (tmpRoot) => {
  const resolver = new ArtifactResolver({ allowedRoots: [tmpRoot], dryRun: true });

  const result = resolver.resolveExists(path.join(tmpRoot, 'lanes', 'archivist', 'outbox', 'result.json'));
  assert.strictEqual(result.exists, true, 'Dry-run must skip FS check and return exists=true');
  assert.strictEqual(result.reason, 'DRY_RUN_SKIP_FS_CHECK');
});

// ============================================================
// SUMMARY
// ============================================================
console.log('\n========================================');
console.log('Artifact Resolver Tests');
console.log('========================================');
console.log(`PASS: ${passed}`);
console.log(`FAIL: ${failed}`);
console.log(`TOTAL: ${passed + failed}`);
console.log('========================================');

for (const r of results) {
  const mark = r.status === 'PASS' ? 'OK' : 'FAIL';
  console.log(`  [${mark}] ${r.name}${r.error ? ' -- ' + r.error : ''}`);
}

if (failed > 0) process.exit(1);
