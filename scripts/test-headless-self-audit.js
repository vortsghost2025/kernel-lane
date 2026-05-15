#!/usr/bin/env node
'use strict';
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const {
  checkCanonicalDrift, checkServiceTopology, checkAgentActivationNeeded,
  testBroadcastDelivery, checkExecutorDependencies,
  buildRecommendationPackets, buildRollup, emitCognitionHandoff,
  SERVICED_LANES, VIRTUAL_LANES, REQUIRED_EXECUTOR_FILES,
  RECOMMENDATION_TYPES, AUDIT_VERSION
} = require('./headless-self-audit');

let pass = 0, fail = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  PASS: ${name}`);
    pass++;
  } catch (err) {
    console.log(`  FAIL: ${name} — ${err.message}`);
    fail++;
  }
}

console.log(`\n=== headless-self-audit.js v${AUDIT_VERSION} smoke tests ===\n`);

// === Topology state classification ===
console.log('1. Topology state classification');
test('SERVICED_LANES has 4 lanes', () => {
  assert.deepStrictEqual(SERVICED_LANES, ['archivist', 'kernel', 'swarmmind', 'library']);
});
test('VIRTUAL_LANES has authority', () => {
  assert.deepStrictEqual(VIRTUAL_LANES, ['authority']);
});
test('topology check returns expected structure', () => {
  const result = checkServiceTopology();
  assert.strictEqual(typeof result.expected_total, 'number');
  assert.strictEqual(result.expected_total, 18);
  assert(Array.isArray(result.missing));
  assert(Array.isArray(result.duplicates));
  assert(Array.isArray(result.crash_loops));
  assert(typeof result.invariant_ok, 'boolean');
});
test('topology 18/18 active means invariant_ok true when no issues', () => {
  const result = checkServiceTopology();
  if (result.active === 18 && result.missing.length === 0 && result.duplicates.length === 0 && result.crash_loops.length === 0) {
    assert.strictEqual(result.invariant_ok, true);
  }
});

// === Drift state classification ===
console.log('\n2. Drift state classification');
test('drift check returns valid status', () => {
  const result = checkCanonicalDrift();
  const validStatuses = ['NO_DRIFT', 'EXPECTED_DRIFT_CANONICAL_CHANGED', 'UNEXPECTED_TARGET_DRIFT', 'SYNC_REQUIRED', 'ERROR'];
  assert(validStatuses.includes(result.status), `Got invalid status: ${result.status}`);
});
test('drift check returns governance packet', () => {
  const result = checkCanonicalDrift();
  assert(result.governance_packet);
  assert(['OK', 'INFO', 'WARNING', 'CRITICAL', 'FATAL'].includes(result.governance_packet.severity));
  assert(['NONE', 'NO_ACTION', 'NEEDS_APPROVAL', 'BLOCK_SYNC'].includes(result.governance_packet.action));
});
test('NO_DRIFT when all aligned', () => {
  const result = checkCanonicalDrift();
  if (result.drift_details.length === 0) {
    assert.strictEqual(result.status, 'NO_DRIFT');
  }
});

// === Recommendation packet schema ===
console.log('\n3. Recommendation packet schema');
test('NO_ACTION packet built for empty recommendations', () => {
  const mockAudit = { agent_activation: [] };
  const packets = buildRecommendationPackets(mockAudit, 'test-cycle-1');
  assert.strictEqual(packets.length, 1);
  assert.strictEqual(packets[0].recommendation_type, 'NO_ACTION');
  assert.strictEqual(packets[0].requires_agent_cognition, false);
  assert.strictEqual(packets[0].confidence, 1.0);
});
test('recommendation packet has all required fields', () => {
  const mockAudit = {
    agent_activation: [{
      trigger: 'canonical_drift', priority: 'P1',
      description: 'Test drift on kernel', action: 'Review and sync'
    }]
  };
  const packets = buildRecommendationPackets(mockAudit, 'test-cycle-2');
  const p = packets[0];
  const requiredFields = ['id', 'generated_at', 'source_cycle_id', 'severity',
    'recommendation_type', 'reason', 'evidence_refs', 'affected_lanes',
    'requires_agent_cognition', 'requires_operator_attention', 'next_safe_action', 'confidence'];
  for (const f of requiredFields) {
    assert(p[f] !== undefined, `Missing field: ${f}`);
  }
});
test('P0 recommendation has high confidence', () => {
  const mockAudit = {
    agent_activation: [{
      trigger: 'blocker', priority: 'P0',
      description: 'Active blocker', action: 'Review'
    }]
  };
  const packets = buildRecommendationPackets(mockAudit, 'test-cycle-3');
  assert.strictEqual(packets[0].confidence, 0.95);
  assert.strictEqual(packets[0].requires_agent_cognition, true);
});

// === Dependency validation missing-file behavior ===
console.log('\n4. Dependency validation missing-file behavior');
test('deps check returns ok boolean and missing array', () => {
  const result = checkExecutorDependencies();
  assert(typeof result.ok === 'boolean');
  assert(Array.isArray(result.missing));
  if (result.ok) {
    assert.strictEqual(result.missing.length, 0);
  }
});
test('REQUIRED_EXECUTOR_FILES is non-empty', () => {
  assert(REQUIRED_EXECUTOR_FILES.length > 0);
});

// === Broadcast proof cleanup safety ===
console.log('\n5. Broadcast proof cleanup safety');
test('broadcast test files are cleaned up after test', () => {
  const beforeFiles = fs.readdirSync(path.join(__dirname, '..', 'lanes', 'archivist', 'outbox'))
    .filter(f => f.includes('audit-broadcast-proof'));
  // Run broadcast test (this modifies state)
  const result = testBroadcastDelivery();
  const afterFiles = fs.readdirSync(path.join(__dirname, '..', 'lanes', 'archivist', 'outbox'))
    .filter(f => f.includes('audit-broadcast-proof'));
  // No test files should remain in outbox
  assert.strictEqual(afterFiles.length, 0, `Leftover test files: ${afterFiles.join(', ')}`);
  // Check target inboxes are clean too
  for (const lane of ['kernel', 'swarmmind', 'library']) {
    const inboxDir = path.join(__dirname, '..', '..', lane === 'kernel' ? 'kernel-lane' : lane === 'swarmmind' ? 'SwarmMind' : 'self-organizing-library', 'lanes', lane, 'inbox');
    if (fs.existsSync(inboxDir)) {
      const leftovers = fs.readdirSync(inboxDir).filter(f => f.includes('audit-broadcast-proof'));
      assert.strictEqual(leftovers.length, 0, `Leftover in ${lane} inbox: ${leftovers.join(', ')}`);
    }
  }
});

// === Rollup ===
console.log('\n6. Rollup artifact');
test('rollup has all required fields', () => {
  const ledgerPath = path.join(__dirname, '..', 'context-buffer', 'autonomy-ledger.jsonl');
  const rollup = buildRollup(ledgerPath, 24);
  assert(typeof rollup.cycle_count === 'number');
  assert(typeof rollup.topology_stability_pct === 'number');
  assert(typeof rollup.drift_incidents === 'number');
  assert(typeof rollup.cognition_needed_pct === 'number');
  assert(typeof rollup.substrate_status === 'string');
  assert(rollup.substrate_status.length > 0);
});

// === Cognition handoff ===
console.log('\n7. Cognition handoff packet');
test('no handoff when NO_ACTION', () => {
  const recs = [{ recommendation_type: 'NO_ACTION', requires_agent_cognition: false }];
  const result = emitCognitionHandoff(recs, 'test-no-cog');
  assert.strictEqual(result, null);
});

// === Summary ===
console.log(`\n=== Results: ${pass} passed, ${fail} failed ===\n`);
process.exit(fail > 0 ? 1 : 0);
