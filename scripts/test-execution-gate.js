#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { ExecutionGate } = require('./execution-gate');
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
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'exec-gate-'));
  try {
    fn(tmpRoot);
    passed++;
    results.push({ name, status: 'PASS' });
    console.log('[PASS] ' + name);
  } catch (err) {
    failed++;
    results.push({ name, status: 'FAIL', error: err.message });
    console.error('[FAIL] ' + name + ': ' + err.message);
  } finally {
    rmDir(tmpRoot);
  }
}

// TEST 1: fake artifact path blocked even with structural proof
test('fake artifact path blocked even with structural proof', function(tmpRoot) {
  var resolver = new ArtifactResolver({ allowedRoots: [tmpRoot], dryRun: false });
  var gate = new ExecutionGate({ lane: 'archivist', dryRun: false, resolver: resolver });

  var msg = {
    id: 'fake-proof',
    from: 'library',
    to: 'archivist',
    type: 'task',
    priority: 'P1',
    timestamp: new Date().toISOString(),
    requires_action: true,
    subject: 'Fake artifact',
    body: 'Structural proof present but artifact does not exist',
    evidence: { required: true },
    evidence_exchange: {
      artifact_path: path.join(tmpRoot, 'fake', 'nonexistent.json'),
      artifact_type: 'benchmark',
      delivered_at: new Date().toISOString(),
    },
  };

  var result = gate.verify(msg);
  assert.strictEqual(result.execution_verified, false, 'Fake artifact must NOT verify');
  assert.ok(
    result.reason.indexOf('FILE_NOT_FOUND') >= 0 || result.reason.indexOf('Artifact unresolvable') >= 0,
    'Reason must indicate artifact not found, got: ' + result.reason
  );
});

// TEST 2: execution_verified=true only when artifact resolves
test('execution_verified=true only when artifact resolves', function(tmpRoot) {
  var resolver = new ArtifactResolver({ allowedRoots: [tmpRoot], dryRun: false });
  var gate = new ExecutionGate({ lane: 'archivist', dryRun: false, resolver: resolver });

  var artifactDir = path.join(tmpRoot, 'output');
  mkDir(artifactDir);
  var artifactPath = path.join(artifactDir, 'real-result.json');
  fs.writeFileSync(artifactPath, JSON.stringify({ verified: true }), 'utf8');

  var msg = {
    id: 'real-proof',
    from: 'library',
    to: 'archivist',
    type: 'task',
    priority: 'P1',
    timestamp: new Date().toISOString(),
    requires_action: true,
    subject: 'Real artifact',
    body: 'Artifact exists on disk',
    evidence: { required: true },
    evidence_exchange: {
      artifact_path: artifactPath,
      artifact_type: 'benchmark',
      delivered_at: new Date().toISOString(),
    },
  };

  var result = gate.verify(msg);
  assert.strictEqual(result.execution_verified, true, 'Real artifact must verify');
  assert.strictEqual(result.verification_type, 'EVIDENCE_EXCHANGE');
  assert.ok(result.verified_at, 'Must have verified_at timestamp');
});

// TEST 3: lane-worker blocks fake artifact with EXECUTION_NOT_VERIFIED
test('lane-worker blocks fake artifact with EXECUTION_NOT_VERIFIED', function(tmpRoot) {
  var resolver = new ArtifactResolver({ allowedRoots: [tmpRoot], dryRun: false });

  var inbox = path.join(tmpRoot, 'lanes', 'archivist', 'inbox');
  mkDir(inbox);
  var subs = ['action-required', 'in-progress', 'processed', 'blocked', 'quarantine'];
  for (var i = 0; i < subs.length; i++) mkDir(path.join(inbox, subs[i]));

  var msg = {
    id: 'fake-proof-lw',
    from: 'library',
    to: 'archivist',
    type: 'task',
    priority: 'P1',
    timestamp: new Date().toISOString(),
    requires_action: true,
    subject: 'Fake artifact via worker',
    body: 'Worker should block this',
    evidence: { required: true },
    evidence_exchange: {
      artifact_path: path.join(tmpRoot, 'nope', 'gone.json'),
      artifact_type: 'benchmark',
      delivered_at: new Date().toISOString(),
    },
  };

  var worker = new LaneWorker({
    repoRoot: tmpRoot,
    lane: 'archivist',
    dryRun: false,
    config: {
      repoRoot: tmpRoot,
      lane: 'archivist',
      queues: {
        inbox: inbox,
        actionRequired: path.join(inbox, 'action-required'),
        inProgress: path.join(inbox, 'in-progress'),
        processed: path.join(inbox, 'processed'),
        blocked: path.join(inbox, 'blocked'),
        quarantine: path.join(inbox, 'quarantine'),
      },
    },
    schemaValidator: function() { return { valid: true, errors: [] }; },
    signatureValidator: function() { return { valid: true, reason: null, details: null }; },
    artifactResolver: resolver,
  });

  var msgPath = path.join(inbox, '2026-01-01_fake_proof.json');
  fs.writeFileSync(msgPath, JSON.stringify(msg, null, 2), 'utf8');

  var summary = worker.processOnce();
  assert.strictEqual(summary.routed.blocked, 1, 'Must route to blocked');
  assert.strictEqual(summary.routed.processed, 0, 'Must NOT route to processed');
  assert.strictEqual(summary.routes[0].reason, 'EXECUTION_NOT_VERIFIED');
  assert.strictEqual(summary.routes[0].execution_verified, false);
});

// TEST 4: lane-worker stamps execution_verified=true on valid artifact
test('lane-worker stamps execution_verified=true on valid artifact', function(tmpRoot) {
  var resolver = new ArtifactResolver({ allowedRoots: [tmpRoot], dryRun: false });

  var artifactDir = path.join(tmpRoot, 'lanes', 'archivist', 'outbox');
  mkDir(artifactDir);
  var artifactPath = path.join(artifactDir, 'result.json');
  fs.writeFileSync(artifactPath, JSON.stringify({ done: true }), 'utf8');

  var inbox = path.join(tmpRoot, 'lanes', 'archivist', 'inbox');
  mkDir(inbox);
  var subs = ['action-required', 'in-progress', 'processed', 'blocked', 'quarantine'];
  for (var i = 0; i < subs.length; i++) mkDir(path.join(inbox, subs[i]));

  var msg = {
    id: 'real-proof-lw',
    from: 'library',
    to: 'archivist',
    type: 'task',
    priority: 'P1',
    timestamp: new Date().toISOString(),
    requires_action: true,
    subject: 'Real artifact via worker',
    body: 'Worker should accept this',
    evidence: { required: true },
    evidence_exchange: {
      artifact_path: artifactPath,
      artifact_type: 'benchmark',
      delivered_at: new Date().toISOString(),
    },
  };

  var worker = new LaneWorker({
    repoRoot: tmpRoot,
    lane: 'archivist',
    dryRun: false,
    config: {
      repoRoot: tmpRoot,
      lane: 'archivist',
      queues: {
        inbox: inbox,
        actionRequired: path.join(inbox, 'action-required'),
        inProgress: path.join(inbox, 'in-progress'),
        processed: path.join(inbox, 'processed'),
        blocked: path.join(inbox, 'blocked'),
        quarantine: path.join(inbox, 'quarantine'),
      },
    },
    schemaValidator: function() { return { valid: true, errors: [] }; },
    signatureValidator: function() { return { valid: true, reason: null, details: null }; },
    artifactResolver: resolver,
  });

  var msgPath = path.join(inbox, '2026-01-01_real_proof.json');
  fs.writeFileSync(msgPath, JSON.stringify(msg, null, 2), 'utf8');

  var summary = worker.processOnce();
  assert.strictEqual(summary.routed.processed, 1, 'Must route to processed');
  assert.strictEqual(summary.routes[0].execution_verified, true);

  var processedFiles = fs.readdirSync(path.join(inbox, 'processed'));
  assert.strictEqual(processedFiles.length, 1);
  var written = JSON.parse(fs.readFileSync(path.join(inbox, 'processed', processedFiles[0]), 'utf8'));
  assert.strictEqual(written.execution_verified, true, 'Written message must have execution_verified=true');
  assert.strictEqual(written._lane_worker.execution_verified, true, '_lane_worker metadata must confirm');
});

// TEST 5: cross-lane validation: archivist verifies library artifact
test('cross-lane validation: archivist verifies library artifact', function(tmpRoot) {
  var libraryOutbox = path.join(tmpRoot, 'lanes', 'library', 'outbox');
  mkDir(libraryOutbox);
  var artifactPath = path.join(libraryOutbox, 'library-result.json');
  fs.writeFileSync(artifactPath, JSON.stringify({ library_done: true }), 'utf8');

  var resolver = new ArtifactResolver({ allowedRoots: [tmpRoot], dryRun: false });
  var gate = new ExecutionGate({ lane: 'archivist', dryRun: false, resolver: resolver });

  var msg = {
    id: 'cross-lane-verify',
    from: 'library',
    to: 'archivist',
    type: 'task',
    priority: 'P1',
    timestamp: new Date().toISOString(),
    requires_action: true,
    subject: 'Cross-lane artifact',
    body: 'Library produced this, Archivist verifies',
    evidence: { required: true },
    evidence_exchange: {
      artifact_path: artifactPath,
      artifact_type: 'benchmark',
      delivered_at: new Date().toISOString(),
    },
  };

  var result = gate.verify(msg);
  assert.strictEqual(result.execution_verified, true, 'Cross-lane artifact must verify');
  assert.strictEqual(result.verifier_lane, 'archivist', 'Verifier must be Archivist (receiving lane)');
});

// TEST 6: liveness alert when zero completions in 5 min
test('liveness alert: zero completions triggers alert', function(tmpRoot) {
  var resolver = new ArtifactResolver({ allowedRoots: [tmpRoot], dryRun: false });
  var gate = new ExecutionGate({ lane: 'archivist', dryRun: false, resolver: resolver });

  var processedDir = path.join(tmpRoot, 'lanes', 'archivist', 'inbox', 'processed');
  mkDir(processedDir);

  var liveness = gate.checkLiveness(processedDir);
  assert.strictEqual(liveness.tasks_completed_last_5min, 0);
  assert.strictEqual(liveness.alert, true);
  assert.strictEqual(liveness.alert_reason, 'ZERO_COMPLETIONS_WHILE_SYSTEM_ACTIVE');
});

// TEST 7: liveness OK when recent completions exist
test('liveness OK: recent completions suppress alert', function(tmpRoot) {
  var resolver = new ArtifactResolver({ allowedRoots: [tmpRoot], dryRun: false });
  var gate = new ExecutionGate({ lane: 'archivist', dryRun: false, resolver: resolver });

  var processedDir = path.join(tmpRoot, 'lanes', 'archivist', 'inbox', 'processed');
  mkDir(processedDir);
  fs.writeFileSync(
    path.join(processedDir, 'recent-task.json'),
    JSON.stringify({ task: 'recent', execution_verified: true }),
    'utf8'
  );

  var liveness = gate.checkLiveness(processedDir);
  assert.strictEqual(liveness.tasks_completed_last_5min, 1);
  assert.strictEqual(liveness.alert, false);
  assert.strictEqual(liveness.alert_reason, null);
});

// TEST 8: execution_verified=false default when no proof at all
test('execution_verified=false default when no proof present', function(tmpRoot) {
  var resolver = new ArtifactResolver({ allowedRoots: [tmpRoot], dryRun: false });
  var gate = new ExecutionGate({ lane: 'archivist', dryRun: false, resolver: resolver });

  var msg = {
    id: 'no-proof-at-all',
    from: 'library',
    to: 'archivist',
    type: 'task',
    priority: 'P2',
    timestamp: new Date().toISOString(),
    requires_action: true,
    subject: 'No proof',
    body: 'Nothing to verify',
  };

  var result = gate.verify(msg);
  assert.strictEqual(result.execution_verified, false);
  assert.strictEqual(result.verification_type, 'NO_PROOF');
});

// TEST 9: dry-run reference check must not set execution_verified=true
test('dry-run reference skip reports would_verify=true but execution_verified=false', function(tmpRoot) {
  var resolver = new ArtifactResolver({ allowedRoots: [tmpRoot], dryRun: true });
  var gate = new ExecutionGate({ lane: 'archivist', dryRun: true, resolver: resolver });

  var msg = {
    id: 'dry-run-ref-check',
    from: 'library',
    to: 'archivist',
    type: 'task',
    priority: 'P1',
    timestamp: new Date().toISOString(),
    requires_action: true,
    completion_message_id: 'missing-reference-id',
  };

  var result = gate.verify(msg);
  assert.strictEqual(result.execution_verified, false, 'dry-run ref skip must not verify execution');
  assert.strictEqual(result.would_verify, true, 'dry-run ref skip should report would_verify=true');
  assert.strictEqual(result.reason, 'DRY_RUN_SKIP_REF_CHECK');
});

// TEST 10: dry-run path check must not set execution_verified=true
test('dry-run fs skip reports would_verify=true but execution_verified=false', function(tmpRoot) {
  var resolver = new ArtifactResolver({ allowedRoots: [tmpRoot], dryRun: true });
  var gate = new ExecutionGate({ lane: 'archivist', dryRun: true, resolver: resolver });

  var msg = {
    id: 'dry-run-fs-check',
    from: 'library',
    to: 'archivist',
    type: 'task',
    priority: 'P1',
    timestamp: new Date().toISOString(),
    requires_action: true,
    evidence: { required: true },
    evidence_exchange: {
      artifact_path: path.join(tmpRoot, 'unknown', 'result.json'),
      artifact_type: 'benchmark',
      delivered_at: new Date().toISOString(),
    },
  };

  var result = gate.verify(msg);
  assert.strictEqual(result.execution_verified, false, 'dry-run fs skip must not verify execution');
  assert.strictEqual(result.would_verify, true, 'dry-run fs skip should report would_verify=true');
  assert.strictEqual(result.reason, 'DRY_RUN_SKIP_FS_CHECK');
});

// SUMMARY
console.log('\n========================================');
console.log('Execution Gate Tests');
console.log('========================================');
console.log('PASS: ' + passed);
console.log('FAIL: ' + failed);
console.log('TOTAL: ' + (passed + failed));
console.log('========================================');

for (var i = 0; i < results.length; i++) {
  var r = results[i];
  var mark = r.status === 'PASS' ? 'OK' : 'FAIL';
  console.log('  [' + mark + '] ' + r.name + (r.error ? ' -- ' + r.error : ''));
}

if (failed > 0) process.exit(1);
