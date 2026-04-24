#!/usr/bin/env node
'use strict';

const assert = require('assert');

const cp = require('./completion-proof');

let passed = 0;
let failed = 0;
const results = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    results.push({ name, status: 'PASS' });
    console.log(`[PASS] ${name}`);
  } catch (err) {
    failed++;
    results.push({ name, status: 'FAIL', error: err.message });
    console.error(`[FAIL] ${name}: ${err.message}`);
  }
}

// TEST 1: completion-gate rejects requires_action=true + terminal_decision only
test('evaluate rejects requires_action=true with terminal_decision only', () => {
  const msg = {
    id: 'fake-td',
    from: 'library',
    to: 'archivist',
    type: 'task',
    priority: 'P0',
    timestamp: new Date().toISOString(),
    requires_action: true,
    subject: 'Fake proof',
    body: 'Has terminal_decision but no artifact',
    terminal_decision: 'completed',
    disposition: 'resolved',
  };

  const result = cp.evaluate(msg);
  assert.strictEqual(result.pass, false, 'Must not pass');
  assert.strictEqual(result.reason, 'FAKE_COMPLETION_PROOF', 'Reason must be FAKE_COMPLETION_PROOF');
  assert.ok(result.detail.includes('terminal_decision'), 'Detail must mention terminal_decision');
});

// TEST 2: completion-gate rejects evidence.required=true without artifact path
test('evaluate rejects evidence.required=true without artifact path', () => {
  const msg = {
    id: 'evidence-no-path',
    from: 'library',
    to: 'archivist',
    type: 'task',
    priority: 'P1',
    timestamp: new Date().toISOString(),
    requires_action: true,
    subject: 'Missing artifact',
    body: 'evidence.required but no path',
    evidence: { required: true },
    terminal_decision: 'done',
  };

  const result = cp.evaluate(msg);
  assert.strictEqual(result.pass, false, 'Must not pass');
  assert.strictEqual(result.reason, 'EVIDENCE_REQUIRED_NO_ARTIFACT', 'Reason must be EVIDENCE_REQUIRED_NO_ARTIFACT');
});

// TEST 3: completion-gate accepts valid evidence_exchange
test('evaluate accepts requires_action=true with valid evidence_exchange', () => {
  const msg = {
    id: 'valid-evidence',
    from: 'library',
    to: 'archivist',
    type: 'task',
    priority: 'P1',
    timestamp: new Date().toISOString(),
    requires_action: true,
    subject: 'Valid proof',
    body: 'Has evidence_exchange with artifact_path',
    evidence: { required: true },
    evidence_exchange: {
      artifact_path: '/lanes/archivist/outbox/result.json',
      artifact_type: 'benchmark',
      delivered_at: new Date().toISOString(),
    },
    terminal_decision: 'completed',
  };

  const result = cp.evaluate(msg);
  assert.strictEqual(result.pass, true, 'Must pass with valid evidence_exchange');
  assert.strictEqual(result.reason, 'ACTIONABLE_WITH_PROOF');
});

// TEST 4: completion-gate accepts terminal informational
test('evaluate accepts terminal informational message', () => {
  const msg = {
    id: 'terminal-ack',
    from: 'library',
    to: 'archivist',
    type: 'ack',
    priority: 'P3',
    timestamp: new Date().toISOString(),
    requires_action: false,
    subject: 'Acknowledgment',
    body: 'Terminal informational',
  };

  const result = cp.evaluate(msg);
  assert.strictEqual(result.pass, true);
  assert.strictEqual(result.reason, 'TERMINAL_INFORMATIONAL');
});

// TEST 5: hasCompletionProof rejects bare terminal_decision
test('hasCompletionProof returns false for bare terminal_decision', () => {
  const msg = { terminal_decision: 'completed', disposition: 'resolved' };
  assert.strictEqual(cp.hasCompletionProof(msg), false);
});

// TEST 6: hasCompletionProof accepts evidence_exchange
test('hasCompletionProof returns true for evidence_exchange with artifact_path', () => {
  const msg = {
    evidence_exchange: { artifact_path: '/tmp/proof.txt' },
    terminal_decision: 'completed',
  };
  assert.strictEqual(cp.hasCompletionProof(msg), true);
});

// TEST 7: hasCompletionProof accepts legacy artifact fields
test('hasCompletionProof returns true for legacy completion_artifact_path', () => {
  const msg = { completion_artifact_path: '/tmp/artifact.json' };
  assert.strictEqual(cp.hasCompletionProof(msg), true);
});

// TEST 8: hasFakeProof detects terminal_decision without artifact
test('hasFakeProof detects terminal_decision without artifact', () => {
  const msg = { terminal_decision: 'done', disposition: 'resolved' };
  assert.strictEqual(cp.hasFakeProof(msg), true);
});

// TEST 9: hasFakeProof returns false when artifact present alongside terminal_decision
test('hasFakeProof returns false when evidence_exchange present alongside terminal_decision', () => {
  const msg = {
    terminal_decision: 'done',
    evidence_exchange: { artifact_path: '/tmp/proof.txt' },
  };
  assert.strictEqual(cp.hasFakeProof(msg), false);
});

// TEST 10: hasUnresolvableEvidence detects missing artifact_path
test('hasUnresolvableEvidence detects evidence.required=true without artifact_path', () => {
  const msg = { evidence: { required: true } };
  assert.strictEqual(cp.hasUnresolvableEvidence(msg), true);
});

// TEST 11: hasUnresolvableEvidence returns false when artifact_path present
test('hasUnresolvableEvidence returns false when evidence_exchange.artifact_path present', () => {
  const msg = {
    evidence: { required: true },
    evidence_exchange: { artifact_path: '/tmp/proof.txt' },
  };
  assert.strictEqual(cp.hasUnresolvableEvidence(msg), false);
});

// TEST 12: hasUnresolvableEvidence returns false when evidence not required
test('hasUnresolvableEvidence returns false when evidence.required is not true', () => {
  const msg = { evidence: { required: false } };
  assert.strictEqual(cp.hasUnresolvableEvidence(msg), false);
});

console.log('\n========================================');
console.log('Completion-Gate Regression Tests');
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
