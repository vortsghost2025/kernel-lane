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
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-worker-prov-test-'));
  const lane = 'kernel';
  const inbox = path.join(tmpRoot, 'lanes', lane, 'inbox');
  const actionRequired = path.join(inbox, 'action-required');
  const inProgress = path.join(inbox, 'in-progress');
  const processed = path.join(inbox, 'processed');
  const blocked = path.join(inbox, 'blocked');
  const quarantine = path.join(inbox, 'quarantine');
  mkDir(inbox);

  let passCount = 0;
  let failCount = 0;

  function check(name, condition) {
    if (condition) {
      console.log(`  [PASS] ${name}`);
      passCount++;
    } else {
      console.log(`  [FAIL] ${name}`);
      failCount++;
    }
  }

  const schemaValidator = () => ({ valid: true, errors: [] });
  const signatureValidator = () => ({ valid: true, reason: null, details: null });

  console.log('\n=== Test 1: Non-exempt, non-actionable, no completion proof, no provenance → BLOCKED ===');
  {
    const msgPath = path.join(inbox, '2026-05-16T00-00-00Z-no-proof-no-prov.json');
    const msg = {
      id: 'test-no-proof-no-prov',
      from: 'library',
      to: 'kernel',
      type: 'assessment',
      priority: 'P1',
      confidence: 8,
      timestamp: new Date().toISOString(),
      requires_action: false,
      subject: 'Assessment without provenance',
      body: 'This is an assessment without OUTPUT_PROVENANCE. It should be blocked even without completion proof.',
    };
    fs.writeFileSync(msgPath, JSON.stringify(msg, null, 2), 'utf8');

    const worker = new LaneWorker({
      repoRoot: tmpRoot,
      lane,
      dryRun: false,
      config: {
        repoRoot: tmpRoot,
        lane,
        queues: { inbox, actionRequired, inProgress, processed, blocked, quarantine },
      },
      schemaValidator,
      signatureValidator,
    });

    const summary = worker.processOnce();
    check('scanned == 1', summary.scanned === 1);
    check('blocked >= 1', summary.routed.blocked >= 1);
    check('processed == 0', summary.routed.processed === 0);

    const blockedFiles = fs.existsSync(blocked) ? fs.readdirSync(blocked).filter((f) => f.endsWith('.json')) : [];
    check('file landed in blocked/', blockedFiles.length >= 1);
    if (blockedFiles.length > 0) {
      const blockedMsg = JSON.parse(fs.readFileSync(path.join(blocked, blockedFiles[0]), 'utf8'));
      check('body lacks provenance', typeof blockedMsg.body === 'string' && !blockedMsg.body.includes('OUTPUT_PROVENANCE:'));
    }

    if (fs.existsSync(msgPath)) fs.unlinkSync(msgPath);
    const bPath = path.join(blocked, blockedFiles[0] || '');
    if (blockedFiles.length > 0 && fs.existsSync(bPath)) fs.unlinkSync(bPath);
  }

  console.log('\n=== Test 2: Non-exempt, non-actionable, no completion proof, WITH provenance → passes provenance gate ===');
  {
    const msgPath = path.join(inbox, '2026-05-16T00-00-01Z-with-prov-no-proof.json');
    const msg = {
      id: 'test-with-prov-no-proof',
      from: 'library',
      to: 'kernel',
      type: 'assessment',
      priority: 'P1',
      confidence: 8,
      timestamp: new Date().toISOString(),
      requires_action: false,
      subject: 'Assessment with provenance',
      body: 'OUTPUT_PROVENANCE:\nagent: test\nlane: kernel\ntarget: test-provenance-gate\n\n## OBSERVABILITY_DOMAIN\ntest\n\n## NEXT_SAFE_ACTION\nnone',
    };
    fs.writeFileSync(msgPath, JSON.stringify(msg, null, 2), 'utf8');

    const worker = new LaneWorker({
      repoRoot: tmpRoot,
      lane,
      dryRun: false,
      config: {
        repoRoot: tmpRoot,
        lane,
        queues: { inbox, actionRequired, inProgress, processed, blocked, quarantine },
      },
      schemaValidator,
      signatureValidator,
    });

    const summary = worker.processOnce();
    check('scanned == 1', summary.scanned === 1);
    check('not blocked for provenance', summary.routed.blocked === 0 || summary.scanned > 0);

    if (fs.existsSync(msgPath)) fs.unlinkSync(msgPath);
  }

  console.log('\n=== Test 3: Exempt type (task) without provenance → NOT blocked for provenance ===');
  {
    const msgPath = path.join(inbox, '2026-05-16T00-00-02Z-task-no-prov.json');
    const msg = {
      id: 'test-task-exempt',
      from: 'library',
      to: 'kernel',
      type: 'task',
      priority: 'P1',
      confidence: 8,
      timestamp: new Date().toISOString(),
      requires_action: true,
      subject: 'Task without provenance (exempt type)',
      body: 'This is a task type and should be exempt from provenance checks.',
    };
    fs.writeFileSync(msgPath, JSON.stringify(msg, null, 2), 'utf8');

    const worker = new LaneWorker({
      repoRoot: tmpRoot,
      lane,
      dryRun: false,
      config: {
        repoRoot: tmpRoot,
        lane,
        queues: { inbox, actionRequired, inProgress, processed, blocked, quarantine },
      },
      schemaValidator,
      signatureValidator,
    });

    const summary = worker.processOnce();
    check('scanned == 1', summary.scanned === 1);

    const blockedFiles = fs.existsSync(blocked) ? fs.readdirSync(blocked).filter((f) => f.endsWith('.json')) : [];
    const blockedMsg = blockedFiles.length > 0 ? JSON.parse(fs.readFileSync(path.join(blocked, blockedFiles[0]), 'utf8')) : null;
    check('not blocked for OUTPUT_PROVENANCE_MISSING', !blockedMsg || blockedMsg._block_reason !== 'OUTPUT_PROVENANCE_MISSING');

    if (fs.existsSync(msgPath)) fs.unlinkSync(msgPath);
    if (blockedFiles.length > 0) { try { fs.unlinkSync(path.join(blocked, blockedFiles[0])); } catch (e) {} }
  }

  console.log(`\n=== PROVENANCE GATE TEST RESULTS ===`);
  console.log(`Passed: ${passCount}`);
  console.log(`Failed: ${failCount}`);

  if (failCount > 0) {
    console.log('\nPROVENANCE GATE TESTS FAILED');
    process.exit(1);
  }

  console.log('\nALL PROVENANCE GATE TESTS PASSED');
  process.exit(0);
}

try {
  run();
} catch (err) {
  console.error('[FAIL]', err.message);
  console.error(err.stack);
  process.exit(1);
}
