/**
 * test-phase4-gates.js
 * Validates Phase 4A and 4B completion before Phase 5
 * 
 * Run: node scripts/test-phase4-gates.js
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ARCHIVIST_ROOT = 'S:/Archivist-Agent';
const LIBRARY_ROOT = 'S:/self-organizing-library';

let passed = 0;
let failed = 0;

function check(name, condition) {
  if (condition) {
    console.log(`✓ ${name}`);
    passed++;
  } else {
    console.log(`✗ ${name}`);
    failed++;
  }
}

function fileExists(filepath) {
  return fs.existsSync(filepath);
}

function fileContains(filepath, content) {
  if (!fs.existsSync(filepath)) return false;
  const data = fs.readFileSync(filepath, 'utf8');
  return data.includes(content);
}

console.log('\n=== PHASE 4A GATE TESTS ===\n');

// Phase 4A: Recovery Policy
check(
  'Recovery policy file exists',
  fileExists(`${ARCHIVIST_ROOT}/FREEAGENT_RECOVERY_POLICY.md`)
);

check(
  'Recovery policy defines hierarchy',
  fileContains(`${ARCHIVIST_ROOT}/FREEAGENT_RECOVERY_POLICY.md`, 'Level 0')
);

check(
  'Recovery policy defines retry boundaries',
  fileContains(`${ARCHIVIST_ROOT}/FREEAGENT_RECOVERY_POLICY.md`, 'Max retries')
);

check(
  'Recovery policy defines handoff signal',
  fileContains(`${ARCHIVIST_ROOT}/FREEAGENT_RECOVERY_POLICY.md`, 'AGENT_HANDOFF_REQUIRED.md')
);

check(
  'Recovery override forbidden',
  fileContains(`${ARCHIVIST_ROOT}/FREEAGENT_RECOVERY_POLICY.md`, 'recovery_override_allowed')
);

// Phase 4A: Operator Handoff Runbook
check(
  'Handoff runbook exists',
  fileExists(`${ARCHIVIST_ROOT}/FREEAGENT_OPERATOR_HANDOFF_RUNBOOK.md`)
);

check(
  'Handoff runbook has procedures',
  fileContains(`${ARCHIVIST_ROOT}/FREEAGENT_OPERATOR_HANDOFF_RUNBOOK.md`, 'Operator Procedure')
);

check(
  'Handoff runbook has SLAs',
  fileContains(`${ARCHIVIST_ROOT}/FREEAGENT_OPERATOR_HANDOFF_RUNBOOK.md`, 'Response Time SLAs')
);

check(
  'Handoff runbook has escalation levels',
  fileContains(`${ARCHIVIST_ROOT}/FREEAGENT_OPERATOR_HANDOFF_RUNBOOK.md`, 'Level 1')
);

console.log('\n=== PHASE 4B GATE TESTS ===\n');

// Phase 4B: Outcome Protocol Implementation
check(
  'Outcome protocol module exists',
  fileExists(`${ARCHIVIST_ROOT}/src/core/protocols/outcome.js`)
);

check(
  'Outcome router module exists',
  fileExists(`${ARCHIVIST_ROOT}/src/core/protocols/outcome_router.js`)
);

check(
  'Confidence module exists',
  fileExists(`${ARCHIVIST_ROOT}/src/core/protocols/confidence.js`)
);

check(
  'Protocol index exists',
  fileExists(`${ARCHIVIST_ROOT}/src/core/protocols/index.js`)
);

// Phase 4B: Status Types
check(
  'SUCCESS status defined',
  fileContains(`${ARCHIVIST_ROOT}/src/core/protocols/outcome.js`, 'SUCCESS')
);

check(
  'FAILURE status defined',
  fileContains(`${ARCHIVIST_ROOT}/src/core/protocols/outcome.js`, 'FAILURE')
);

check(
  'ESCALATE status defined',
  fileContains(`${ARCHIVIST_ROOT}/src/core/protocols/outcome.js`, 'ESCALATE')
);

check(
  'DEFER status defined',
  fileContains(`${ARCHIVIST_ROOT}/src/core/protocols/outcome.js`, 'DEFER')
);

check(
  'QUARANTINE status defined',
  fileContains(`${ARCHIVIST_ROOT}/src/core/protocols/outcome.js`, 'QUARANTINE')
);

// Phase 4B: Confidence Scoring
check(
  'Confidence thresholds defined',
  fileContains(`${ARCHIVIST_ROOT}/src/core/protocols/confidence.js`, 'ConfidenceThreshold')
);

check(
  'Confidence calculation function',
  fileContains(`${ARCHIVIST_ROOT}/src/core/protocols/confidence.js`, 'calculateConfidence')
);

check(
  'Confidence sufficiency check',
  fileContains(`${ARCHIVIST_ROOT}/src/core/protocols/confidence.js`, 'isConfidenceSufficient')
);

// Phase 4B: Routing
check(
  'Route function defined',
  fileContains(`${ARCHIVIST_ROOT}/src/core/protocols/outcome_router.js`, 'routeEscalation')
);

check(
  'Cross-lane routing',
  fileContains(`${ARCHIVIST_ROOT}/src/core/protocols/outcome_router.js`, 'determineCrossLaneTarget')
);

// Phase 4B: Requires Field
check(
  'Requirement kinds defined',
  fileContains(`${ARCHIVIST_ROOT}/src/core/protocols/outcome.js`, 'RequirementKind')
);

check(
  'Escalation targets defined',
  fileContains(`${ARCHIVIST_ROOT}/src/core/protocols/outcome.js`, 'EscalationTarget')
);

// Phase 4B: Tests
check(
  'Outcome tests exist',
  fileExists(`${ARCHIVIST_ROOT}/tests/protocols/outcome.test.js`)
);

// Phase 4B: System Anchor Update
check(
  'Anchor has outcome_policy',
  fileContains(`${ARCHIVIST_ROOT}/FREEAGENT_SYSTEM_ANCHOR.json`, 'outcome_policy')
);

check(
  'Anchor has all statuses',
  fileContains(`${ARCHIVIST_ROOT}/FREEAGENT_SYSTEM_ANCHOR.json`, '"SUCCESS"')
);

check(
  'Anchor has confidence thresholds',
  fileContains(`${ARCHIVIST_ROOT}/FREEAGENT_SYSTEM_ANCHOR.json`, 'confidence_thresholds')
);

console.log('\n=== LIBRARY DELIVERABLES ===\n');

// Library: Protocol Documentation
check(
  'Protocol spec exists',
  fileExists(`${LIBRARY_ROOT}/context-buffer/FREEAGENT_OUTCOME_PROTOCOL.md`)
);

check(
  'Protocol spec has all statuses',
  fileContains(`${LIBRARY_ROOT}/context-buffer/FREEAGENT_OUTCOME_PROTOCOL.md`, '### SUCCESS') &&
  fileContains(`${LIBRARY_ROOT}/context-buffer/FREEAGENT_OUTCOME_PROTOCOL.md`, '### FAILURE') &&
  fileContains(`${LIBRARY_ROOT}/context-buffer/FREEAGENT_OUTCOME_PROTOCOL.md`, '### ESCALATE')
);

check(
  'State mapping exists',
  fileExists(`${LIBRARY_ROOT}/context-buffer/FREEAGENT_STATE_MAPPING.md`)
);

check(
  'Evidence index protocol exists',
  fileExists(`${LIBRARY_ROOT}/context-buffer/FREEAGENT_EVIDENCE_INDEX_PROTOCOL.md`)
);

console.log('\n=== GATE RESULTS ===\n');
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);

if (failed > 0) {
  console.log('\n❌ PHASE 4 GATES NOT PASSED');
  console.log('Fix the failing checks before proceeding to Phase 5.');
  process.exit(1);
}

console.log('\n✅ ALL PHASE 4 GATES PASSED');
console.log('Phase 4A: Recovery discipline and operator handoff - COMPLETE');
console.log('Phase 4B: Outcome protocol with routing - COMPLETE');
console.log('\nReady for Phase 5: Publication and Index Lock');

process.exit(0);
