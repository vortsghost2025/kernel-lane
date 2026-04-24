#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const LANE_ROOTS = {
  archivist: 'S:/Archivist-Agent',
  kernel: 'S:/kernel-lane',
  library: 'S:/self-organizing-library',
  swarmmind: 'S:/SwarmMind'
};

const COMPLETION_PROOF_FIELDS = [
  'completion_artifact_path',
  'completion_message_id',
  'resolved_by_task_id',
  'terminal_decision',
  'disposition'
];

const VALID_DISPOSITIONS = new Set(['completed', 'declined', 'superseded', 'expired', 'quarantined']);

function hasCompletionProof(msg) {
  if (!msg) return false;
  for (const field of COMPLETION_PROOF_FIELDS) {
    if (msg[field]) return true;
  }
  if (msg.convergence_gate && msg.convergence_gate.status) {
    const status = String(msg.convergence_gate.status).toLowerCase();
    if (['proven', 'approved', 'ratified', 'accepted'].includes(status)) return true;
  }
  if (msg.disposition && VALID_DISPOSITIONS.has(String(msg.disposition).toLowerCase())) return true;
  return false;
}

function auditProcessedDir(laneId) {
  const root = LANE_ROOTS[laneId];
  if (!root) return { lane: laneId, ok: false, error: 'LANE_ROOT_NOT_FOUND' };
  
  const processedPath = path.join(root, 'lanes', laneId, 'inbox', 'processed');
  if (!fs.existsSync(processedPath)) {
    return { lane: laneId, ok: true, total: 0, violations: [], message: 'No processed/ directory' };
  }
  
  const files = fs.readdirSync(processedPath).filter(f => f.endsWith('.json'));
  const violations = [];
  
  for (const f of files) {
    try {
      const filePath = path.join(processedPath, f);
      const msg = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      
      // Check: requires_action=true AND no completion proof = VIOLATION
      if (msg.requires_action === true && !hasCompletionProof(msg)) {
        violations.push({
          file: f,
          type: msg.type,
          subject: (msg.subject || '').substring(0, 60),
          requires_action: msg.requires_action
        });
      }
    } catch (e) {
      violations.push({ file: f, error: e.message });
    }
  }
  
  return {
    lane: laneId,
    ok: violations.length === 0,
    total: files.length,
    violations,
    message: violations.length > 0 ? 'VIOLATIONS FOUND' : 'All clear'
  };
}

function main() {
  const args = process.argv.slice(2);
  const lanes = args.length > 0 ? args : Object.keys(LANE_ROOTS);
  
  const results = {
    timestamp: new Date().toISOString(),
    overall_ok: true,
    lanes: {}
  };
  
  for (const laneId of lanes) {
    const result = auditProcessedDir(laneId);
    results.lanes[laneId] = result;
    if (!result.ok) results.overall_ok = false;
  }
  
  const reportPath = path.join('S:/Archivist-Agent', 'docs', 'autonomous-cycle-test', 'completion-proof-audit.json');
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify(results, null, 2), 'utf8');
  
  console.log(JSON.stringify(results, null, 2));
  
  if (!results.overall_ok) {
    console.error('\n[P0] VIOLATIONS: Actionable tasks in processed/ without completion proof!');
    process.exit(1);
  } else {
    console.log('\nAll lanes clear: no false-processed tasks');
    process.exit(0);
  }
}

if (require.main === module) {
  main();
}
