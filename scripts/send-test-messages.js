#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const mod = require('./identity-enforcer.js');

const archPriv = fs.readFileSync('S:/Archivist-Agent/.identity/private.pem', 'utf8');

const targets = [
  { name: 'library', inbox: 'S:/self-organizing-library/lanes/library/inbox' },
  { name: 'swarmmind', inbox: 'S:/SwarmMind/lanes/swarmmind/inbox' },
  { name: 'kernel', inbox: 'S:/kernel-lane/lanes/kernel/inbox' }
];

function makeMsg(toLane) {
  return {
    schema_version: '1.3',
    task_id: 'cross-lane-mail-test-' + toLane + '-20260424',
    idempotency_key: 'test-' + toLane + '-' + Date.now(),
    from: 'archivist',
    to: toLane,
    type: 'ack',
    task_kind: 'review',
    priority: 'P2',
    subject: 'Cross-Lane Mail Test from Archivist',
    body: 'Terminal informational test message. If your lane-worker processes this to processed/, the mail pipeline is verified.',
    timestamp: new Date().toISOString(),
    requires_action: false,
    payload: { mode: 'inline', compression: 'none', content: 'mail pipeline test' },
    execution: { mode: 'manual', engine: 'opencode', actor: 'lane' },
    lease: { owner: toLane, acquired_at: new Date().toISOString(), expires_at: new Date(Date.now()+86400000).toISOString(), renew_count: 0, max_renewals: 0 },
    retry: { count: 0, max_retries: 0, backoff_ms: 0 },
    evidence: { required: false },
    evidence_exchange: { artifact_path: null, artifact_type: 'log', delivered_at: new Date().toISOString() },
    heartbeat: { status: 'done', updated_at: new Date().toISOString(), next_due: new Date(Date.now()+300000).toISOString() }
  };
}

const ie = new mod.IdentityEnforcer();

for (const t of targets) {
  const msg = makeMsg(t.name);
  const signed = mod.IdentityEnforcer.signMessage(msg, archPriv, 'a0230f635bcc0f2e');
  const fp = path.join(t.inbox, 'archivist-mail-test-' + t.name + '-20260424.json');
  fs.writeFileSync(fp, JSON.stringify(signed, null, 2));
  const result = ie.enforceMessage(signed);
  console.log(t.name + ':', result.decision, '|', result.reason, '| authenticated:', result.authenticated, '| key_id:', result.key_id);
}
