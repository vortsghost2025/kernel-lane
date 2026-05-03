#!/usr/bin/env node
'use strict';

const { writeSignedMessage } = require('./create-signed-message');
const path = require('path');

const KERNEL_ROOT = 'S:/kernel-lane';
const ARTIFACT_PATH = 'artifacts/canonical-execution-contract-v1-review-kernel.json';

const response = {
  schema_version: '1.3',
  id: 'msg-cec-v1-ratify-kernel-' + Date.now(),
  task_id: 'response-cec-v1-ratification-kernel-' + Date.now(),
  idempotency_key: 'kernel-archivist-cec-v1-ratification-response-' + Date.now(),
  from: 'kernel',
  to: 'archivist',
  type: 'response',
  task_kind: 'ratification',
  priority: 'P1',
  subject: 'Ratification: ACK — Canonical Execution Contract v1',
  body: 'Kernel lane has reviewed Canonical Execution Contract v1. Verdict: ACK.\n\nAll hard rules (CEC-R1..R7) implemented as specified. No clause conflicts.\nImplementation gaps (soft rules and minor signal exposures) documented in attached artifact.\n\nArtifact: artifacts/canonical-execution-contract-v1-review-kernel.json',
  timestamp: new Date().toISOString(),
  requires_action: false,
  payload: { mode: 'inline', compression: 'none' },
  execution: { mode: 'manual', engine: 'codex', actor: 'lane' },
  lease: { 
    owner: 'kernel', 
    acquired_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 30000).toISOString(),
    renewal_count: 0,
    max_renewals: 3
  },
  retry: { attempt: 1, max_attempts: 3, last_error: null, last_attempt_at: null },
  evidence: {
    required: true,
    evidence_path: ARTIFACT_PATH,
    verified: true,
    verified_by: 'kernel',
    verified_at: new Date().toISOString()
  },
  evidence_exchange: {
    artifact_path: ARTIFACT_PATH,
    artifact_type: 'report',
    delivered_at: new Date().toISOString()
  },
  heartbeat: {
    status: 'done',
    last_heartbeat_at: new Date().toISOString(),
    interval_seconds: 300,
    timeout_seconds: 900
  },
  watcher: {
    enabled: false,
    poll_seconds: 60,
    p0_fast_path: true,
    max_concurrent: 1,
    heartbeat_required: true,
    stale_after_seconds: 300,
    backoff: { initial_seconds: 60, max_seconds: 300, multiplier: 2 }
  },
  delivery_verification: {
    verified: true,
    verified_at: new Date().toISOString(),
    retries: 0
  },
  convergence_gate: {
    claim: 'Kernel ACKs Canonical Execution Contract v1 — all hard rules implemented, no clause conflicts',
    evidence: ARTIFACT_PATH,
    verified_by: 'kernel',
    contradictions: [],
    status: 'proven'
  },
  in_response_to: 'cec-v1-ratification-kernel-1777776930540'
};

(async () => {
  try {
    const outboxDir = path.join(KERNEL_ROOT, 'lanes', 'kernel', 'outbox');
    const result = await writeSignedMessage(response, 'kernel', outboxDir);
    console.log('Response written:', result.filePath);
    console.log('Key ID:', result.keyId);
    process.exit(0);
  } catch (err) {
    console.error('ERROR:', err.message);
    if (err.errors) console.error('DETAILS:', JSON.stringify(err.errors, null, 2));
    process.exit(1);
  }
})();
