#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const mod = require('./identity-enforcer.js');

const ie = new mod.IdentityEnforcer();
const archInbox = 'S:/Archivist-Agent/lanes/archivist/inbox';

const lanes = [
  { name: 'library', dir: 'S:/self-organizing-library' },
  { name: 'swarmmind', dir: 'S:/SwarmMind' },
  { name: 'kernel', dir: 'S:/kernel-lane' }
];

for (const lane of lanes) {
  const priv = fs.readFileSync(path.join(lane.dir, '.identity/private.pem'), 'utf8');
  const snap = JSON.parse(fs.readFileSync(path.join(lane.dir, '.identity/snapshot.json'), 'utf8'));

  const msg = {
    schema_version: '1.3',
    task_id: lane.name + '-to-archivist-mail-test-20260424',
    idempotency_key: lane.name + '-archivist-test-' + Date.now(),
    from: lane.name,
    to: 'archivist',
    type: 'ack',
    task_kind: 'review',
    priority: 'P2',
    subject: 'Mail Test from ' + lane.name + ' to Archivist',
    body: 'Cross-lane mail pipeline test. Signed with new keypair. Terminal informational.',
    timestamp: new Date().toISOString(),
    requires_action: false,
    payload: { mode: 'inline', compression: 'none', content: 'mail pipeline test' },
    execution: { mode: 'manual', engine: 'opencode', actor: 'lane' },
    lease: { owner: 'archivist', acquired_at: new Date().toISOString(), expires_at: new Date(Date.now()+86400000).toISOString(), renew_count: 0, max_renewals: 0 },
    retry: { count: 0, max_retries: 0, backoff_ms: 0 },
    evidence: { required: false },
    evidence_exchange: { artifact_path: null, artifact_type: 'log', delivered_at: new Date().toISOString() },
    heartbeat: { status: 'done', updated_at: new Date().toISOString(), next_due: new Date(Date.now()+300000).toISOString() }
  };

  const signed = mod.IdentityEnforcer.signMessage(msg, priv, snap.key_id);
  const fp = path.join(archInbox, lane.name + '-to-archivist-mail-test-20260424.json');
  fs.writeFileSync(fp, JSON.stringify(signed, null, 2));

  const result = ie.enforceMessage(signed);
  console.log(lane.name + ' -> archivist:', result.decision, '|', result.reason, '| key_id:', result.key_id);
}
