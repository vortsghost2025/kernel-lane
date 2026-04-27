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

function readFirstJson(dirPath) {
  const files = fs.existsSync(dirPath) ? fs.readdirSync(dirPath).filter((f) => f.endsWith('.json')) : [];
  assert.ok(files.length > 0, `Expected JSON file in ${dirPath}`);
  const fullPath = path.join(dirPath, files[0]);
  return JSON.parse(fs.readFileSync(fullPath, 'utf8'));
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
// TEST 13: signed message missing known defaults -> remediated + processed
// ============================================================
test('signed message missing known default fields -> remediated + processed', (tmpRoot) => {
  const schemaValidator = (msg) => {
    const required = ['timestamp', 'payload', 'execution', 'lease', 'retry', 'evidence', 'evidence_exchange', 'heartbeat'];
    const errors = [];
    for (const field of required) {
      if (!(field in (msg || {}))) errors.push(`Missing required field: ${field}`);
    }
    return { valid: errors.length === 0, errors };
  };
  const { worker, config } = makeWorker(tmpRoot, 'archivist', {
    dryRun: false,
    schemaValidator,
    signatureValidator: () => ({ valid: true, reason: null, details: null }),
  });
  const msg = {
    id: 'signed-remediate-known',
    from: 'library',
    to: 'archivist',
    type: 'ack',
    priority: 'P2',
    requires_action: false,
    subject: 'Remediation path',
    body: 'Missing known defaults only',
  };
  writeMsg(config.queues.inbox, '2026-01-01_signed_remediate_known.json', msg);

  const summary = worker.processOnce();
  assert.strictEqual(summary.routed.processed, 1, 'Remediated signed message should process');
  assert.strictEqual(summary.routed.quarantine, 0);
  assert.ok(summary.routes[0].schema_remediation && summary.routes[0].schema_remediation.success === true);
});

// ============================================================
// TEST 14: unsigned message missing fields -> quarantined
// ============================================================
test('unsigned message missing fields -> quarantined', (tmpRoot) => {
  const schemaValidator = (msg) => {
    const errors = [];
    if (!msg.timestamp) errors.push('Missing required field: timestamp');
    if (!msg.payload) errors.push('Missing required field: payload');
    return { valid: errors.length === 0, errors };
  };
  const { worker, config } = makeWorker(tmpRoot, 'archivist', {
    dryRun: false,
    schemaValidator,
    signatureValidator: () => ({ valid: false, reason: 'MISSING_SIGNATURE', details: null }),
  });
  const msg = {
    id: 'unsigned-remediate-blocked',
    from: 'library',
    to: 'archivist',
    type: 'ack',
    priority: 'P2',
    requires_action: false,
    subject: 'Unsigned remediation should fail',
    body: 'No signature',
  };
  writeMsg(config.queues.inbox, '2026-01-01_unsigned_missing_fields.json', msg);

  const summary = worker.processOnce();
  assert.strictEqual(summary.routed.quarantine, 1, 'Schema invalid should quarantine');
  assert.strictEqual(summary.routes[0].schema_remediation, null, 'Unsigned messages must not be remediated');
});

// ============================================================
// TEST 15: malformed schema field is not remediated silently
// ============================================================
test('malformed ownership/schema field -> not remediated silently', (tmpRoot) => {
  const schemaValidator = (msg) => {
    const errors = [];
    if (!msg.timestamp) errors.push('Missing required field: timestamp');
    if (msg.retry && typeof msg.retry !== 'object') errors.push('Field retry must be an object');
    return { valid: errors.length === 0, errors };
  };
  const { worker, config } = makeWorker(tmpRoot, 'archivist', {
    dryRun: false,
    schemaValidator,
    signatureValidator: () => ({ valid: true, reason: null, details: null }),
  });
  const msg = {
    id: 'signed-malformed-field',
    from: 'library',
    to: 'archivist',
    type: 'ack',
    priority: 'P2',
    requires_action: false,
    subject: 'Malformed field',
    body: 'retry has wrong type',
    retry: 'not-an-object',
  };
  writeMsg(config.queues.inbox, '2026-01-01_signed_malformed_field.json', msg);

  const summary = worker.processOnce();
  assert.strictEqual(summary.routed.quarantine, 1, 'Malformed schema should quarantine');
  assert.strictEqual(summary.routes[0].schema_remediation, null, 'Malformed fields must not be silently remediated');
});

// ============================================================
// TEST 16: remediated message includes audit metadata
// ============================================================
test('remediated message includes schema_remediation audit metadata', (tmpRoot) => {
  const schemaValidator = (msg) => {
    const errors = [];
    if (!msg.timestamp) errors.push('Missing required field: timestamp');
    if (!msg.payload) errors.push('Missing required field: payload');
    if (!msg.heartbeat) errors.push('Missing required field: heartbeat');
    return { valid: errors.length === 0, errors };
  };
  const { worker, config } = makeWorker(tmpRoot, 'archivist', {
    dryRun: false,
    schemaValidator,
    signatureValidator: () => ({ valid: true, reason: null, details: null }),
  });
  const msg = {
    id: 'signed-remediation-audit',
    from: 'library',
    to: 'archivist',
    type: 'ack',
    priority: 'P2',
    requires_action: false,
    subject: 'Audit metadata',
    body: 'Expect schema_remediation in metadata',
  };
  writeMsg(config.queues.inbox, '2026-01-01_signed_remediation_audit.json', msg);

  worker.processOnce();
  const enriched = readFirstJson(config.queues.processed);
  assert.ok(enriched._lane_worker && enriched._lane_worker.schema_remediation, 'Missing _lane_worker.schema_remediation');
  assert.strictEqual(enriched._lane_worker.schema_remediation.success, true);
  assert.ok(Array.isArray(enriched._lane_worker.schema_remediation.applied_fields));
});

// ============================================================
// TEST 17: remediation retries only once
// ============================================================
test('remediation retries only once', (tmpRoot) => {
  let validateCalls = 0;
  const schemaValidator = (msg) => {
    validateCalls += 1;
    const errors = [];
    if (!msg.timestamp) errors.push('Missing required field: timestamp');
    if (!msg.payload) errors.push('Missing required field: payload');
    if (!msg.non_remediable_required) errors.push('Missing required field: non_remediable_required');
    return { valid: errors.length === 0, errors };
  };
  const { worker, config } = makeWorker(tmpRoot, 'archivist', {
    dryRun: false,
    schemaValidator,
    signatureValidator: () => ({ valid: true, reason: null, details: null }),
  });
  const msg = {
    id: 'signed-one-retry-only',
    from: 'library',
    to: 'archivist',
    type: 'ack',
    priority: 'P2',
    requires_action: false,
    subject: 'Retry once',
    body: 'Should remediate once then stop',
  };
  writeMsg(config.queues.inbox, '2026-01-01_signed_retry_once.json', msg);

  const summary = worker.processOnce();
  assert.strictEqual(summary.routed.quarantine, 1, 'Non-remediable missing field should still quarantine');
  assert.strictEqual(validateCalls, 2, 'Schema validation should run exactly twice (initial + one retry)');
  assert.ok(summary.routes[0].schema_remediation && summary.routes[0].schema_remediation.attempted === true);
  assert.strictEqual(summary.routes[0].schema_remediation.success, false);
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
