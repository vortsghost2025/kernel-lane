#!/usr/bin/env node
'use strict';

const assert = require('assert');
const path = require('path');
const { ArtifactResolver } = require('./artifact-resolver');
const { evaluateVerificationDomain } = require('./verification-domain-gate');

function makeResolver(dryRun = false) {
  return new ArtifactResolver({
    dryRun,
    allowedRoots: [
      'S:/Archivist-Agent',
      'S:/kernel-lane',
      'S:/self-organizing-library',
      'S:/SwarmMind',
    ],
    configPath: path.join(__dirname, '..', 'config', 'allowed_roots.json'),
  });
}

function testTemporalViolation() {
  const resolver = makeResolver(true);
  const now = Date.now();
  const msg = {
    from: 'swarmmind',
    to: 'archivist',
    type: 'response',
    task_kind: 'report',
    timestamp: new Date(now).toISOString(),
    dispatch_timestamp: new Date(now + 60_000).toISOString(),
    execution_timestamp: new Date(now).toISOString(),
    evidence_exchange: {
      artifact_path: 'S:/SwarmMind/lanes/swarmmind/outbox/task-result.json',
      delivered_at: new Date(now).toISOString(),
    },
  };
  const out = evaluateVerificationDomain(msg, { resolver });
  assert.strictEqual(out.domain_valid, false);
  assert.strictEqual(out.verification_outcome, 'INVALID_DOMAIN');
  assert.ok(String(out.invalid_domain_reason).includes('timestamp'));
  assert.strictEqual(out.phase, 'post_execution');
  assert.strictEqual(out.execution_preserved, true);
}

function testSemanticViolation() {
  const resolver = makeResolver(true);
  const now = Date.now();
  const msg = {
    from: 'swarmmind',
    to: 'archivist',
    type: 'response',
    task_kind: 'impossible-kind',
    timestamp: new Date(now).toISOString(),
    dispatch_timestamp: new Date(now - 60_000).toISOString(),
    execution_timestamp: new Date(now).toISOString(),
    evidence_exchange: {
      artifact_path: 'S:/SwarmMind/lanes/swarmmind/outbox/task-result.json',
      delivered_at: new Date(now).toISOString(),
    },
  };
  const out = evaluateVerificationDomain(msg, { resolver });
  assert.strictEqual(out.domain_valid, false);
  assert.strictEqual(out.verification_outcome, 'INVALID_DOMAIN');
  assert.strictEqual(out.invalid_domain_reason, 'schema does not cover behavior');
  assert.strictEqual(out.phase, 'post_execution');
  assert.strictEqual(out.execution_preserved, true);
}

function testObservabilityViolation() {
  const resolver = makeResolver(false);
  const now = Date.now();
  const msg = {
    from: 'swarmmind',
    to: 'archivist',
    type: 'response',
    task_kind: 'report',
    timestamp: new Date(now).toISOString(),
    dispatch_timestamp: new Date(now - 60_000).toISOString(),
    execution_timestamp: new Date(now).toISOString(),
    evidence_exchange: {
      artifact_path: 'S:/does-not-exist/not-observable.json',
      delivered_at: new Date(now).toISOString(),
    },
  };
  const out = evaluateVerificationDomain(msg, { resolver });
  assert.strictEqual(out.domain_valid, false);
  assert.strictEqual(out.verification_outcome, 'INVALID_DOMAIN');
  assert.strictEqual(out.invalid_domain_reason, 'artifact not observable');
  assert.strictEqual(out.phase, 'post_execution');
  assert.strictEqual(out.execution_preserved, true);
}

function testPreExecutionInvalidDomain() {
  const resolver = makeResolver(false);
  const now = Date.now();
  const msg = {
    from: 'archivist',
    to: 'swarmmind',
    type: 'task',
    task_kind: 'review',
    timestamp: new Date(now).toISOString(),
    dispatch_timestamp: new Date(now).toISOString(),
    // no execution timestamp / no delivery marker => pre_execution
    evidence_exchange: {
      artifact_path: 'S:/missing/pre-exec-proof.json',
    },
  };
  const out = evaluateVerificationDomain(msg, { resolver });
  assert.strictEqual(out.domain_valid, false);
  assert.strictEqual(out.phase, 'pre_execution');
  assert.strictEqual(out.execution_preserved, false);
}

function testPostExecutionSemanticDrift() {
  const resolver = makeResolver(false);
  const now = Date.now();
  const msg = {
    from: 'swarmmind',
    to: 'archivist',
    type: 'response',
    task_kind: 'bad-kind',
    timestamp: new Date(now).toISOString(),
    dispatch_timestamp: new Date(now - 60_000).toISOString(),
    execution_timestamp: new Date(now).toISOString(),
    evidence_exchange: {
      artifact_path: 'S:/Archivist-Agent/scripts/lane-worker.js',
      delivered_at: new Date(now).toISOString(),
    },
  };
  const out = evaluateVerificationDomain(msg, { resolver });
  assert.strictEqual(out.domain_valid, false);
  assert.strictEqual(out.phase, 'post_execution');
  assert.strictEqual(out.invalid_domain_reason, 'schema does not cover behavior');
  assert.strictEqual(out.execution_preserved, true);
}

function main() {
  testTemporalViolation();
  testSemanticViolation();
  testObservabilityViolation();
  testPreExecutionInvalidDomain();
  testPostExecutionSemanticDrift();
  console.log('Verification domain gate: PASS (5/5 checks)');
}

if (require.main === module) main();

