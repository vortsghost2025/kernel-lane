#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  LaneWorker,
  hasCompletionProof,
  hasFakeProof,
  hasUnresolvableEvidence,
  isActionable,
  isEnglishOnly,
  completionGateApprove,
} = require('./lane-worker');

function mkDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function rmDir(p) {
  if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
}

function makeWorker(tmpRoot, lane, opts = {}) {
  const inbox = path.join(tmpRoot, 'lanes', lane, 'inbox');
  const config = {
    repoRoot: tmpRoot,
    lane,
    queues: {
      inbox,
      actionRequired: path.join(inbox, 'action-required'),
      inProgress: path.join(inbox, 'in-progress'),
      processed: path.join(inbox, 'processed'),
      blocked: path.join(inbox, 'blocked'),
      quarantine: path.join(inbox, 'quarantine'),
    },
  };
  mkDir(inbox);

  const workerOpts = {
    repoRoot: tmpRoot,
    lane,
    dryRun: opts.dryRun !== undefined ? opts.dryRun : true,
    config,
    schemaValidator: opts.schemaValidator || (() => ({ valid: true, errors: [] })),
    signatureValidator: opts.signatureValidator || (() => ({ valid: true, reason: null, details: null })),
  };

  return { worker: new LaneWorker(workerOpts), config };
}

function writeMsg(inbox, filename, msg) {
  const p = path.join(inbox, filename);
  fs.writeFileSync(p, JSON.stringify(msg, null, 2), 'utf8');
  return p;
}

let passed = 0;
let failed = 0;
const results = [];

function test(name, fn) {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'we4free-'));
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
// TEST 1: dry-run does not mutate
// ============================================================
test('dry-run does not mutate filesystem', (tmpRoot) => {
  const { worker, config } = makeWorker(tmpRoot, 'archivist', { dryRun: true });
  const msg = {
    id: 'dry-run-test',
    from: 'library',
    to: 'archivist',
    type: 'task',
    priority: 'P2',
    timestamp: new Date().toISOString(),
    requires_action: true,
    subject: 'Dry run test',
    body: 'Should not move',
  };
  writeMsg(config.queues.inbox, '2026-01-01_test.json', msg);
  const beforeFiles = fs.readdirSync(config.queues.inbox).filter(f => f.endsWith('.json'));

  const summary = worker.processOnce();
  assert.strictEqual(summary.dry_run, true, 'Must be dry-run');
  assert.strictEqual(summary.scanned, 1);

  const afterFiles = fs.readdirSync(config.queues.inbox).filter(f => f.endsWith('.json'));
  assert.deepStrictEqual(afterFiles, beforeFiles, 'Files must not move in dry-run');

  for (const q of ['processed', 'actionRequired', 'blocked', 'quarantine']) {
    if (fs.existsSync(config.queues[q])) {
      const files = fs.readdirSync(config.queues[q]).filter(f => f.endsWith('.json'));
      assert.strictEqual(files.length, 0, `${q} must be empty after dry-run`);
    }
  }
});

// ============================================================
// TEST 2: invalid JSON -> quarantine
// ============================================================
test('invalid JSON routes to quarantine', (tmpRoot) => {
  const { worker, config } = makeWorker(tmpRoot, 'archivist', { dryRun: false });
  const badJsonPath = path.join(config.queues.inbox, '2026-01-01_bad.json');
  fs.writeFileSync(badJsonPath, '{ this is not valid json }}}', 'utf8');

  const summary = worker.processOnce();
  assert.strictEqual(summary.scanned, 1);
  assert.strictEqual(summary.routed.quarantine, 1);
  assert.strictEqual(summary.routed.processed, 0);

  const quarantineFiles = fs.readdirSync(config.queues.quarantine).filter(f => f.endsWith('.json'));
  assert.strictEqual(quarantineFiles.length, 1, 'File must exist in quarantine/');
});

// ============================================================
// TEST 3: invalid schema -> quarantine
// ============================================================
test('invalid schema routes to quarantine', (tmpRoot) => {
  const strictSchema = (msg) => {
    const errors = [];
    if (!msg.from) errors.push('Missing from');
    if (!msg.to) errors.push('Missing to');
    if (!msg.type) errors.push('Missing type');
    if (!msg.timestamp) errors.push('Missing timestamp');
    if (!msg.id) errors.push('Missing id');
    if (!msg.priority) errors.push('Missing priority');
    if (msg.requires_action === undefined) errors.push('Missing requires_action');
    return { valid: errors.length === 0, errors };
  };
  const { worker, config } = makeWorker(tmpRoot, 'archivist', {
    dryRun: false,
    schemaValidator: strictSchema,
  });
  const msg = { from: 'library' }; // missing most required fields
  writeMsg(config.queues.inbox, '2026-01-01_noschema.json', msg);

  const summary = worker.processOnce();
  assert.strictEqual(summary.routed.quarantine, 1, 'Schema-invalid must quarantine');
  assert.strictEqual(summary.routed.processed, 0);
});

// ============================================================
// TEST 4: missing signature -> blocked
// ============================================================
test('missing signature routes to blocked', (tmpRoot) => {
  const { worker, config } = makeWorker(tmpRoot, 'archivist', {
    dryRun: false,
    signatureValidator: () => ({ valid: false, reason: 'MISSING_SIGNATURE', details: null }),
  });
  const msg = {
    id: 'no-sig',
    from: 'library',
    to: 'archivist',
    type: 'task',
    priority: 'P2',
    timestamp: new Date().toISOString(),
    requires_action: true,
    subject: 'No signature',
    body: 'Should be blocked',
  };
  writeMsg(config.queues.inbox, '2026-01-01_nosig.json', msg);

  const summary = worker.processOnce();
  assert.strictEqual(summary.routed.blocked, 1, 'Missing signature must block');
  assert.strictEqual(summary.routed.processed, 0);

  const blockedFiles = fs.readdirSync(config.queues.blocked).filter(f => f.endsWith('.json'));
  assert.strictEqual(blockedFiles.length, 1);
});

// ============================================================
// TEST 5: signature mismatch -> blocked
// ============================================================
test('signature mismatch routes to blocked', (tmpRoot) => {
  const { worker, config } = makeWorker(tmpRoot, 'archivist', {
    dryRun: false,
    signatureValidator: () => ({ valid: false, reason: 'SIGNATURE_MISMATCH', details: null }),
  });
  const msg = {
    id: 'sig-mismatch',
    from: 'library',
    to: 'archivist',
    type: 'task',
    priority: 'P2',
    timestamp: new Date().toISOString(),
    requires_action: true,
    subject: 'Bad sig',
    body: 'Mismatched',
    signature: 'fake.signature.value',
    key_id: 'fake-key',
  };
  writeMsg(config.queues.inbox, '2026-01-01_sigmismatch.json', msg);

  const summary = worker.processOnce();
  assert.strictEqual(summary.routed.blocked, 1);
  assert.strictEqual(summary.routed.processed, 0);
});

// ============================================================
// TEST 6: lane mismatch -> blocked
// ============================================================
test('lane mismatch routes to blocked', (tmpRoot) => {
  const { worker, config } = makeWorker(tmpRoot, 'archivist', {
    dryRun: false,
    signatureValidator: () => ({ valid: false, reason: 'LANE_MISMATCH', details: null }),
  });
  const msg = {
    id: 'lane-mismatch',
    from: 'library',
    to: 'archivist',
    type: 'task',
    priority: 'P2',
    timestamp: new Date().toISOString(),
    requires_action: true,
    subject: 'Wrong lane',
    body: 'Lane mismatch',
  };
  writeMsg(config.queues.inbox, '2026-01-01_lanemismatch.json', msg);

  const summary = worker.processOnce();
  assert.strictEqual(summary.routed.blocked, 1);
  assert.strictEqual(summary.routed.processed, 0);
});

// ============================================================
// TEST 7: non-ASCII format violation -> quarantine/format-violation
// ============================================================
test('non-ASCII format violation routes to quarantine', (tmpRoot) => {
  const { worker, config } = makeWorker(tmpRoot, 'archivist', { dryRun: false });
  const msg = {
    id: 'emoji-test',
    from: 'library',
    to: 'archivist',
    type: 'task',
    priority: 'P2',
    timestamp: new Date().toISOString(),
    requires_action: true,
    subject: 'Task with emoji',
    body: 'This has non-ASCII: \u2705 done \ud83d\ude80',
  };
  writeMsg(config.queues.inbox, '2026-01-01_emoji.json', msg);

  const summary = worker.processOnce();
  assert.strictEqual(summary.routed.quarantine, 1, 'Non-ASCII must route to quarantine');
  assert.strictEqual(summary.routed.processed, 0);
  assert.strictEqual(summary.routed.blocked, 0, 'Non-ASCII must NOT route to blocked');

  const quarantineFiles = fs.readdirSync(config.queues.quarantine).filter(f => f.endsWith('.json'));
  assert.strictEqual(quarantineFiles.length, 1);
});

// ============================================================
// TEST 8: requires_action=true without proof -> action-required
// ============================================================
test('requires_action=true without proof routes to action-required', (tmpRoot) => {
  const { worker, config } = makeWorker(tmpRoot, 'archivist', { dryRun: false });
  const msg = {
    id: 'action-no-proof',
    from: 'library',
    to: 'archivist',
    type: 'task',
    priority: 'P1',
    timestamp: new Date().toISOString(),
    requires_action: true,
    subject: 'Actionable task',
    body: 'No completion proof provided',
  };
  writeMsg(config.queues.inbox, '2026-01-01_actionnoproof.json', msg);

  const summary = worker.processOnce();
  assert.strictEqual(summary.routed.action_required, 1);
  assert.strictEqual(summary.routed.processed, 0);
});

// ============================================================
// TEST 9: fake terminal_decision without artifact -> not processed
// ============================================================
test('fake terminal_decision without artifact routes to blocked', (tmpRoot) => {
  const { worker, config } = makeWorker(tmpRoot, 'archivist', { dryRun: false });
  const msg = {
    id: 'fake-proof',
    from: 'library',
    to: 'archivist',
    type: 'task',
    priority: 'P0',
    timestamp: new Date().toISOString(),
    requires_action: true,
    subject: 'Fake completion',
    body: 'Has terminal_decision but no artifact',
    terminal_decision: 'completed',
    disposition: 'resolved',
  };
  writeMsg(config.queues.inbox, '2026-01-01_fakeproof.json', msg);

  const summary = worker.processOnce();
  assert.strictEqual(summary.routed.processed, 0, 'Fake proof must NOT enter processed/');
  assert.strictEqual(summary.routed.blocked, 1, 'Fake proof must route to blocked');

  const processedFiles = fs.existsSync(config.queues.processed) ?
    fs.readdirSync(config.queues.processed).filter(f => f.endsWith('.json')) : [];
  assert.strictEqual(processedFiles.length, 0, 'processed/ must stay empty');
});

// ============================================================
// TEST 10: evidence.required=true without artifact_path -> not processed
// ============================================================
test('evidence.required=true without artifact_path routes to blocked', (tmpRoot) => {
  const { worker, config } = makeWorker(tmpRoot, 'archivist', { dryRun: false });
  const msg = {
    id: 'evidence-no-artifact',
    from: 'library',
    to: 'archivist',
    type: 'task',
    priority: 'P1',
    timestamp: new Date().toISOString(),
    requires_action: true,
    subject: 'Missing artifact path',
    body: 'evidence.required but no evidence_exchange.artifact_path',
    evidence: { required: true },
    terminal_decision: 'done',
  };
  writeMsg(config.queues.inbox, '2026-01-01_evidencenoartifact.json', msg);

  const summary = worker.processOnce();
  assert.strictEqual(summary.routed.processed, 0, 'Must NOT enter processed');
  assert.strictEqual(summary.routed.blocked, 1, 'Must route to blocked');
});

// ============================================================
// TEST 11: valid terminal informational -> processed
// ============================================================
test('valid terminal informational routes to processed', (tmpRoot) => {
  const { worker, config } = makeWorker(tmpRoot, 'archivist', { dryRun: false });
  const msg = {
    id: 'terminal-ack',
    from: 'library',
    to: 'archivist',
    type: 'ack',
    priority: 'P3',
    timestamp: new Date().toISOString(),
    requires_action: false,
    subject: 'Acknowledgment',
    body: 'Terminal informational message',
  };
  writeMsg(config.queues.inbox, '2026-01-01_terminalack.json', msg);

  const summary = worker.processOnce();
  assert.strictEqual(summary.routed.processed, 1, 'Terminal informational must enter processed/');
  assert.strictEqual(summary.routed.blocked, 0);
  assert.strictEqual(summary.routed.quarantine, 0);

  const processedFiles = fs.readdirSync(config.queues.processed).filter(f => f.endsWith('.json'));
  assert.strictEqual(processedFiles.length, 1);
});

// ============================================================
// TEST 12: lane-worker never writes system_state
// ============================================================
test('lane-worker never writes system_state.json', (tmpRoot) => {
  const { worker, config } = makeWorker(tmpRoot, 'archivist', { dryRun: false });
  const statePath = path.join(tmpRoot, 'lanes', 'broadcast', 'system_state.json');
  mkDir(path.dirname(statePath));
  fs.writeFileSync(statePath, JSON.stringify({ status: 'ok', written_by: 'heartbeat.js' }), 'utf8');
  const beforeContent = fs.readFileSync(statePath, 'utf8');

  const msg = {
    id: 'no-state-write',
    from: 'library',
    to: 'archivist',
    type: 'task',
    priority: 'P2',
    timestamp: new Date().toISOString(),
    requires_action: true,
    subject: 'State write test',
    body: 'Verify system_state unchanged',
  };
  writeMsg(config.queues.inbox, '2026-01-01_statewrite.json', msg);

  worker.processOnce();

  const afterContent = fs.readFileSync(statePath, 'utf8');
  assert.strictEqual(afterContent, beforeContent, 'lane-worker must not modify system_state.json');

  const workerCode = fs.readFileSync(path.join(__dirname, 'lane-worker.js'), 'utf8');
  assert.ok(
    !workerCode.includes('system_state') || workerCode.includes('lane-worker must not write system_state'),
    'lane-worker code must not contain system_state write logic'
  );
});

// ============================================================
// SUMMARY
// ============================================================
console.log('\n========================================');
console.log('WE4FREE Test Suite Results');
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
