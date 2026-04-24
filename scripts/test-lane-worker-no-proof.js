#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { LaneWorker } = require('./lane-worker');

function mkDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function run() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-worker-test-'));
  const lane = 'archivist';
  const inbox = path.join(tmpRoot, 'lanes', lane, 'inbox');
  const actionRequired = path.join(inbox, 'action-required');
  const inProgress = path.join(inbox, 'in-progress');
  const processed = path.join(inbox, 'processed');
  const blocked = path.join(inbox, 'blocked');
  const quarantine = path.join(inbox, 'quarantine');
  mkDir(inbox);

  const msgPath = path.join(inbox, '2026-04-24T00-00-00Z-test-actionable-no-proof.json');
  const msg = {
    id: 'test-actionable-no-proof',
    from: 'library',
    to: 'archivist',
    type: 'task',
    priority: 'P0',
    timestamp: new Date().toISOString(),
    requires_action: true,
    subject: 'Task without completion proof',
    body: 'This must not go to processed',
  };
  fs.writeFileSync(msgPath, JSON.stringify(msg, null, 2), 'utf8');

  const worker = new LaneWorker({
    repoRoot: tmpRoot,
    lane,
    dryRun: false,
    config: {
      repoRoot: tmpRoot,
      lane,
      queues: {
        inbox,
        actionRequired,
        inProgress,
        processed,
        blocked,
        quarantine,
      },
    },
    schemaValidator: () => ({ valid: true, errors: [] }),
    signatureValidator: () => ({ valid: true, reason: null, details: null }),
  });

  const summary = worker.processOnce();
  const routedToAllowed = summary.routed.action_required + summary.routed.blocked;

  assert.strictEqual(summary.scanned, 1, 'Expected exactly one scanned message');
  assert.strictEqual(summary.routed.processed, 0, 'Actionable message without proof must not enter processed/');
  assert.strictEqual(routedToAllowed, 1, 'Message must route to action-required/ or blocked/');

  const processedFiles = fs.existsSync(processed) ? fs.readdirSync(processed).filter((f) => f.endsWith('.json')) : [];
  assert.strictEqual(processedFiles.length, 0, 'processed/ must stay empty');

  const actionRequiredFiles = fs.existsSync(actionRequired) ? fs.readdirSync(actionRequired).filter((f) => f.endsWith('.json')) : [];
  const blockedFiles = fs.existsSync(blocked) ? fs.readdirSync(blocked).filter((f) => f.endsWith('.json')) : [];
  assert.ok(actionRequiredFiles.length + blockedFiles.length === 1, 'Expected file in action-required/ or blocked/');

  console.log('[PASS] actionable message without completion proof did not enter processed/');
  console.log(JSON.stringify({
    scanned: summary.scanned,
    routed: summary.routed,
    action_required_files: actionRequiredFiles.length,
    blocked_files: blockedFiles.length,
    processed_files: processedFiles.length,
  }, null, 2));
}

try {
  run();
} catch (err) {
  console.error('[FAIL]', err.message);
  process.exit(1);
}

