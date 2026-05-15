#!/usr/bin/env node
'use strict';
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const {
  checkCanonicalDrift, checkServiceTopology, checkAgentActivationNeeded,
  testBroadcastDelivery, checkExecutorDependencies,
  buildRecommendationPackets, buildRollup, buildEnhancedRollup,
  emitCognitionHandoff, buildDedupeKey, updateRecommendationLedger,
  recordDisposition, loadRecommendationLedger,
  SERVICED_LANES, VIRTUAL_LANES, REQUIRED_EXECUTOR_FILES,
  RECOMMENDATION_TYPES, REC_LIFECYCLE_STATES, REC_DISPOSITIONS,
  DEDUPE_SUPPRESS_CYCLES, AUDIT_VERSION
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

// === 1. Topology state classification ===
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

// === 2. Drift state classification ===
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

// === 3. Recommendation packet schema ===
console.log('\n3. Recommendation packet schema');
test('NO_ACTION packet built for empty recommendations', () => {
  const mockAudit = { agent_activation: [] };
  const packets = buildRecommendationPackets(mockAudit, 'test-cycle-1');
  assert.strictEqual(packets.length, 1);
  assert.strictEqual(packets[0].recommendation_type, 'NO_ACTION');
  assert.strictEqual(packets[0].requires_agent_cognition, false);
  assert.strictEqual(packets[0].confidence, 1.0);
});
test('recommendation packet has all 12 required fields', () => {
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

// === 4. Dependency validation ===
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

// === 5. Broadcast proof cleanup ===
console.log('\n5. Broadcast proof cleanup safety');
test('broadcast test files are cleaned up after test', () => {
  const archivistRoot = path.join(__dirname, '..');
  const archivistOutbox = path.join(archivistRoot, 'lanes', 'archivist', 'outbox');
  if (!fs.existsSync(archivistOutbox)) {
    return;
  }
  testBroadcastDelivery();
  const afterFiles = fs.readdirSync(archivistOutbox)
    .filter(f => f.includes('audit-broadcast-proof'));
  assert.strictEqual(afterFiles.length, 0, `Leftover test files: ${afterFiles.join(', ')}`);
});

// === 6. Rollup ===
console.log('\n6. Rollup artifact');
test('rollup has all required fields', () => {
  const ledgerPath = path.join(__dirname, '..', 'context-buffer', 'autonomy-ledger.jsonl');
  if (!fs.existsSync(ledgerPath)) {
    return;
  }
  const rollup = buildRollup(ledgerPath, 24);
  assert(typeof rollup.cycle_count === 'number');
  assert(typeof rollup.topology_stability_pct === 'number');
  assert(typeof rollup.drift_incidents === 'number');
  assert(typeof rollup.cognition_needed_pct === 'number');
  assert(typeof rollup.substrate_status === 'string');
  assert(rollup.substrate_status.length > 0);
});

// === 7. Cognition handoff ===
console.log('\n7. Cognition handoff packet');
test('no handoff when NO_ACTION', () => {
  const recs = [{ recommendation_type: 'NO_ACTION', requires_agent_cognition: false }];
  const result = emitCognitionHandoff(recs, 'test-no-cog');
  assert.strictEqual(result, null);
});

// === 8. Recommendation lifecycle ===
console.log('\n8. Recommendation lifecycle');
test('dedupe_key format is type:lanes', () => {
  const rec = { recommendation_type: 'REVIEW_DRIFT', affected_lanes: ['kernel', 'swarmmind'] };
  const key = buildDedupeKey(rec);
  assert.strictEqual(key, 'REVIEW_DRIFT:kernel+swarmmind');
});
test('same recommendation produces same dedupe_key', () => {
  const rec1 = { recommendation_type: 'TOPOLOGY_ANOMALY', affected_lanes: ['library'] };
  const rec2 = { recommendation_type: 'TOPOLOGY_ANOMALY', affected_lanes: ['library'] };
  assert.strictEqual(buildDedupeKey(rec1), buildDedupeKey(rec2));
});
test('different lanes produce different dedupe_key', () => {
  const rec1 = { recommendation_type: 'REVIEW_DRIFT', affected_lanes: ['kernel'] };
  const rec2 = { recommendation_type: 'REVIEW_DRIFT', affected_lanes: ['library'] };
  assert.notStrictEqual(buildDedupeKey(rec1), buildDedupeKey(rec2));
});
test('lifecycle states are valid', () => {
  const validStates = ['NEW', 'ONGOING_MONITORED', 'ESCALATED', 'RESOLVED', 'SUPPRESSED'];
  for (const s of REC_LIFECYCLE_STATES) {
    assert(validStates.includes(s), `Invalid state: ${s}`);
  }
});
test('updateRecommendationLedger tracks NEW on first occurrence', () => {
  const testLedger = '/tmp/test-rec-ledger.jsonl';
  if (fs.existsSync(testLedger)) fs.unlinkSync(testLedger);
  process.env.REC_LEDGER = testLedger;
  const packets = [{
    id: 'rec-test-001', recommendation_type: 'CRASH_LOOP_DETECTED',
    severity: 'P0', affected_lanes: ['kernel'], reason: 'test crash',
    requires_agent_cognition: true
  }];
  const result = updateRecommendationLedger(packets, 'test-cycle-4');
  assert.strictEqual(result.new_count, 1);
  assert.strictEqual(result.total_active, 1);
  const entries = loadRecommendationLedger();
  const entry = entries.find(e => e.dedupe_key === 'CRASH_LOOP_DETECTED:kernel');
  assert(entry);
  assert.strictEqual(entry.current_state, 'NEW');
  assert.strictEqual(entry.occurrence_count, 1);
  assert.strictEqual(entry.cognition_handoff_emitted, true);
  delete process.env.REC_LEDGER;
  if (fs.existsSync(testLedger)) fs.unlinkSync(testLedger);
});

// === 9. Disposition capture ===
console.log('\n9. Disposition capture');
test('recordDisposition updates existing entry', () => {
  const testLedger = '/tmp/test-rec-ledger-disp.jsonl';
  if (fs.existsSync(testLedger)) fs.unlinkSync(testLedger);
  const dir = path.dirname(testLedger);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(testLedger, JSON.stringify({
    recommendation_id: 'rec-test-002',
    dedupe_key: 'TOPOLOGY_ANOMALY:all',
    recommendation_type: 'TOPOLOGY_ANOMALY',
    first_seen_at: '2026-05-15T04:00:00Z',
    last_seen_at: '2026-05-15T05:00:00Z',
    occurrence_count: 3,
    current_state: 'ONGOING_MONITORED',
    severity: 'P1',
    affected_lanes: ['all'],
    reason: 'test',
    cycles_since_first: 3,
    cycles_since_last_escalation: 0,
    disposition: null,
    disposition_at: null,
    resolution_evidence_refs: [],
    false_positive: null,
    cognition_handoff_emitted: false
  }) + '\n', 'utf8');
  process.env.REC_LEDGER = testLedger;
  const result = recordDisposition('TOPOLOGY_ANOMALY:all', 'REJECT', ['test-evidence'], true);
  assert.strictEqual(result.updated, true);
  assert.strictEqual(result.disposition, 'REJECT');
  const entries = loadRecommendationLedger();
  const entry = entries.find(e => e.dedupe_key === 'TOPOLOGY_ANOMALY:all');
  assert.strictEqual(entry.disposition, 'REJECT');
  assert.strictEqual(entry.false_positive, true);
  assert(entry.disposition_at);
  delete process.env.REC_LEDGER;
  if (fs.existsSync(testLedger)) fs.unlinkSync(testLedger);
});

// === 10. Enhanced rollup ===
console.log('\n10. Enhanced rollup with recommendation metrics');
test('enhanced rollup includes recommendation_metrics', () => {
  const ledgerPath = path.join(__dirname, '..', 'context-buffer', 'autonomy-ledger.jsonl');
  if (!fs.existsSync(ledgerPath)) return;
  const rollup = buildEnhancedRollup(ledgerPath, undefined, 24);
  assert(rollup.recommendation_metrics);
  assert(typeof rollup.recommendation_metrics.active_unresolved === 'number');
  assert(typeof rollup.recommendation_metrics.new_24h === 'number');
  assert(typeof rollup.verdict === 'string');
  assert(rollup.verdict.length > 0);
});

// === Summary ===
console.log(`\n=== Results: ${pass} passed, ${fail} failed ===\n`);
process.exit(fail > 0 ? 1 : 0);
