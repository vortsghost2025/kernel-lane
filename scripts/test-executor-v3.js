#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { executeTask, NLP_ROUTES, LANE_REGISTRY } = require('./generic-task-executor');

let passed = 0;
let failed = 0;
const results = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    results.push({ name, status: 'PASS' });
    console.log('[PASS] ' + name);
  } catch (err) {
    failed++;
    results.push({ name, status: 'FAIL', error: err.message });
    console.error('[FAIL] ' + name + ': ' + err.message);
  }
}

function makeMsg(body, opts = {}) {
  return {
    task_id: opts.task_id || 'test-' + Date.now(),
    task_kind: opts.task_kind || 'task',
    body,
    subject: opts.subject || body.slice(0, 60),
  };
}

const LANE_ROOT = LANE_REGISTRY.archivist.root;
const TEST_DIR = path.join(LANE_ROOT, 'tmp', 'test-executor-v3');

function ensureTestDir() {
  if (!fs.existsSync(TEST_DIR)) fs.mkdirSync(TEST_DIR, { recursive: true });
  return TEST_DIR;
}

function writeTmpFile(name, content) {
  const dir = ensureTestDir();
  const p = path.join(dir, name);
  fs.writeFileSync(p, content, 'utf8');
  return p;
}

function cleanupTestDir() {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
}

const LANE = 'archivist';

// ============================================================
// VERB 1: STATUS
// ============================================================
test('status: explicit task_kind', () => {
  const r = executeTask(makeMsg('', { task_kind: 'status' }), LANE);
  assert.strictEqual(r.task_kind, 'status');
  assert(typeof r.results.processed_count === 'number');
  assert.strictEqual(typeof r.results.system_state, 'object');
});

test('status: NLP "what is the lane status"', () => {
  const r = executeTask(makeMsg('what is the lane status'), LANE);
  assert.strictEqual(r.task_kind, 'status');
});

// ============================================================
// VERB 2: READ FILE
// ============================================================
test('read file: reads content', () => {
  const f = writeTmpFile('read-test.txt', 'hello world');
  const r = executeTask(makeMsg(`read file ${f}`), LANE);
  assert.strictEqual(r.task_kind, 'report');
  assert.strictEqual(r.results.content, 'hello world');
});

test('read file: directory listing', () => {
  const r = executeTask(makeMsg(`read file ${LANE_ROOT}/scripts`), LANE);
  assert.strictEqual(r.task_kind, 'report');
  assert.strictEqual(r.results.type, 'directory');
  assert(Array.isArray(r.results.entries));
});

// ============================================================
// VERB 3: RUN SCRIPT
// ============================================================
test('run script: missing script error', () => {
  const r = executeTask(makeMsg('run script nonexistent-script-xyz'), LANE);
  assert.strictEqual(r.task_kind, 'report');
  assert(r.results.error.includes('not found'));
});

test('run script: daemon skip', () => {
  const r = executeTask(makeMsg('run script heartbeat'), LANE);
  assert.strictEqual(r.task_kind, 'report');
  assert(r.results.skipped === true);
});

// ============================================================
// VERB 4: GIT
// ============================================================
test('git: status', () => {
  const r = executeTask(makeMsg('git status'), LANE);
  assert.strictEqual(r.task_kind, 'report');
  assert(r.results.git === 'status');
});

test('git: disallowed subcommand', () => {
  const r = executeTask(makeMsg('git push'), LANE);
  assert.strictEqual(r.task_kind, 'report');
  assert(r.results.error);
});

test('git: shell metacharacters blocked', () => {
  const r = executeTask(makeMsg('git log ; rm -rf /'), LANE);
  assert.strictEqual(r.task_kind, 'report');
  assert(r.results.error);
});

// ============================================================
// VERB 5: GREP
// ============================================================
test('grep: pattern search', () => {
  const r = executeTask(makeMsg('grep "function" in S:/Archivist-Agent/scripts/generic-task-executor.js'), LANE);
  assert.strictEqual(r.task_kind, 'report');
  assert.strictEqual(r.results.grep, 'function');
  assert(typeof r.results.matches === 'number');
});

test('grep: no pattern error', () => {
  const r = executeTask(makeMsg('just grep nothing'), LANE);
  assert.strictEqual(r.task_kind, 'report');
  assert(r.results.error);
});

// ============================================================
// VERB 6: WRITE FILE
// ============================================================
test('write file: outside own lane rejected', () => {
  const r = executeTask(makeMsg('write file S:/kernel-lane/test.txt\ntest'), LANE);
  assert.strictEqual(r.task_kind, 'report');
  assert(r.results.error.includes('outside own lane'));
});

test('write file: governance file blocked', () => {
  const r = executeTask(makeMsg('write file S:/Archivist-Agent/BOOTSTRAP.md\nhacked'), LANE);
  assert.strictEqual(r.task_kind, 'report');
  assert(r.results.error.includes('blocked'));
});

test('write file: 10KB limit enforced', () => {
  const big = 'x'.repeat(10241);
  const r = executeTask(makeMsg(`write file S:/Archivist-Agent/test-overflow.txt\n${big}`), LANE);
  assert.strictEqual(r.task_kind, 'report');
  assert(r.results.error.includes('10KB'));
});

// ============================================================
// VERB 7: CONSISTENCY CHECK
// ============================================================
test('consistency check: explicit', () => {
  const r = executeTask(makeMsg('consistency check'), LANE);
  assert.strictEqual(r.task_kind, 'report');
  assert.strictEqual(r.results.check_type, 'cross-lane-consistency');
});

test('consistency check: NLP "is the system consistent"', () => {
  const r = executeTask(makeMsg('is the system consistent'), LANE);
  assert.strictEqual(r.task_kind, 'report');
  assert.strictEqual(r.results.check_type, 'cross-lane-consistency');
});

// ============================================================
// VERB 8: LIST DIR
// ============================================================
test('list dir: returns entries', () => {
  const r = executeTask(makeMsg('list dir S:/Archivist-Agent/scripts'), LANE);
  assert.strictEqual(r.task_kind, 'report');
  assert(Array.isArray(r.results.entries));
  assert(typeof r.results.count === 'number');
  assert(r.results.count > 0);
});

test('list dir: entry shape has name/type/size/modified', () => {
  const r = executeTask(makeMsg('list dir S:/Archivist-Agent/scripts'), LANE);
  const e = r.results.entries[0];
  assert('name' in e);
  assert('type' in e);
  assert(['DIR', 'FILE', 'UNKNOWN'].includes(e.type));
  assert(typeof e.size === 'number');
});

test('list dir: outside allowed roots rejected', () => {
  const r = executeTask(makeMsg('list dir C:/Windows/System32'), LANE);
  assert.strictEqual(r.task_kind, 'report');
  assert(r.results.error.includes('allowed roots'));
});

// ============================================================
// VERB 9: HASH FILE
// ============================================================
test('hash file: returns sha256', () => {
  const f = writeTmpFile('hash-test.txt', 'hash me');
  const r = executeTask(makeMsg(`hash file ${f}`), LANE);
  assert.strictEqual(r.task_kind, 'report');
  assert(r.results.sha256.length === 64);
  assert(typeof r.results.size === 'number');
});

test('hash file: deterministic', () => {
  const f = writeTmpFile('det-test.txt', 'deterministic test ' + Date.now());
  const r1 = executeTask(makeMsg(`hash file ${f}`), LANE);
  const r2 = executeTask(makeMsg(`hash file ${f}`), LANE);
  assert.strictEqual(r1.results.sha256, r2.results.sha256);
});

test('hash file: alias sha256', () => {
  const f = writeTmpFile('sha-test.txt', 'sha alias test');
  const r = executeTask(makeMsg(`sha256 ${f}`), LANE);
  assert.strictEqual(r.task_kind, 'report');
  assert(r.results.sha256.length === 64);
});

// ============================================================
// VERB 10: DIFF
// ============================================================
test('diff: identical files', () => {
  const dir = ensureTestDir();
  const f1 = path.join(dir, 'diff-a.txt');
  const f2 = path.join(dir, 'diff-b.txt');
  fs.writeFileSync(f1, 'same\ncontent\n', 'utf8');
  fs.writeFileSync(f2, 'same\ncontent\n', 'utf8');
  const r = executeTask(makeMsg(`diff ${f1} ${f2}`), LANE);
  assert.strictEqual(r.task_kind, 'report');
  assert.strictEqual(r.results.identical, true);
  assert.strictEqual(r.results.diff_count, 0);
});

test('diff: different files', () => {
  const dir = ensureTestDir();
  const f1 = path.join(dir, 'diff-c.txt');
  const f2 = path.join(dir, 'diff-d.txt');
  fs.writeFileSync(f1, 'line1\nline2\n', 'utf8');
  fs.writeFileSync(f2, 'line1\nchanged\n', 'utf8');
  const r = executeTask(makeMsg(`diff ${f1} ${f2}`), LANE);
  assert.strictEqual(r.task_kind, 'report');
  assert.strictEqual(r.results.identical, false);
  assert(r.results.diff_count > 0);
  assert(Array.isArray(r.results.diffs));
});

test('diff: compare alias', () => {
  const dir = ensureTestDir();
  const f1 = path.join(dir, 'diff-e.txt');
  const f2 = path.join(dir, 'diff-f.txt');
  fs.writeFileSync(f1, 'same', 'utf8');
  fs.writeFileSync(f2, 'same', 'utf8');
  const r = executeTask(makeMsg(`compare ${f1} with ${f2}`), LANE);
  assert.strictEqual(r.task_kind, 'report');
  assert.strictEqual(r.results.identical, true);
});

test('diff: missing second path error', () => {
  const r = executeTask(makeMsg('diff S:/Archivist-Agent/scripts/heartbeat.js'), LANE);
  assert.strictEqual(r.task_kind, 'report');
  assert(r.results.error);
});

// ============================================================
// VERB 11: COUNT
// ============================================================
test('count: occurrences in file', () => {
  const f = writeTmpFile('cnt-test.txt', 'foo bar foo baz foo');
  const r = executeTask(makeMsg(`count "foo" in ${f}`), LANE);
  assert.strictEqual(r.task_kind, 'report');
  assert.strictEqual(r.results.count, 3);
});

test('count: zero occurrences', () => {
  const f = writeTmpFile('cnt-zero.txt', 'no match here');
  const r = executeTask(makeMsg(`count "xyzzy" in ${f}`), LANE);
  assert.strictEqual(r.task_kind, 'report');
  assert.strictEqual(r.results.count, 0);
});

test('count: directory mode works', () => {
  const r = executeTask(makeMsg('count "function" in S:/Archivist-Agent/scripts'), LANE);
  assert.strictEqual(r.task_kind, 'report');
  assert(typeof r.results.count === 'number');
  assert(typeof r.results.files_scanned === 'number');
});

// ============================================================
// NLP ROUTING
// ============================================================
test('NLP: "check if trust store is consistent" -> consistency check', () => {
  const r = executeTask(makeMsg('check if trust store is consistent'), LANE);
  assert.strictEqual(r.task_kind, 'report');
  assert.strictEqual(r.results.check_type, 'cross-lane-consistency');
});

test('NLP: "how many messages processed" -> status', () => {
  const r = executeTask(makeMsg('how many messages have been processed'), LANE);
  assert.strictEqual(r.task_kind, 'status');
});

test('NLP: "what files exist in scripts" -> list dir', () => {
  const r = executeTask(makeMsg('what files exist in S:/Archivist-Agent/scripts'), LANE);
  assert.strictEqual(r.task_kind, 'report');
  assert(Array.isArray(r.results.entries));
});

test('NLP: "what is the sha of heartbeat.js" -> hash file', () => {
  const r = executeTask(makeMsg('what is the sha of S:/Archivist-Agent/scripts/heartbeat.js'), LANE);
  assert.strictEqual(r.task_kind, 'report');
  assert(r.results.sha256);
});

test('NLP: "find where NFM is defined" -> grep', () => {
  const r = executeTask(makeMsg('search for "NFM" in S:/Archivist-Agent/docs'), LANE);
  assert.strictEqual(r.task_kind, 'report');
  assert.strictEqual(r.results.grep, 'NFM');
});

test('NLP: "latest commits" -> git log', () => {
  const r = executeTask(makeMsg('show me the latest commits'), LANE);
  assert.strictEqual(r.task_kind, 'report');
  assert(r.results.git === 'log');
});

test('NLP: "uncommitted changes" -> git status', () => {
  const r = executeTask(makeMsg('are there uncommitted changes'), LANE);
  assert.strictEqual(r.task_kind, 'report');
  assert(r.results.git === 'status');
});

test('NLP: 12 route groups loaded', () => {
  assert.strictEqual(NLP_ROUTES.length, 12);
});

// ============================================================
// ADVERSARIAL / EDGE CASES
// ============================================================
test('adversarial: empty body -> fallback ack', () => {
  const r = executeTask(makeMsg(''), LANE);
  assert.strictEqual(r.task_kind, 'ack');
  assert(r.results.acknowledged === true);
});

test('adversarial: gibberish body -> fallback ack', () => {
  const r = executeTask(makeMsg('xyzzy plugh plover'), LANE);
  assert.strictEqual(r.task_kind, 'ack');
});

test('adversarial: explicit verb + NLP conflict -> explicit wins', () => {
  const r = executeTask(makeMsg('list dir S:/Archivist-Agent/scripts while checking trust store health'), LANE);
  assert.strictEqual(r.task_kind, 'report');
  assert(Array.isArray(r.results.entries));
});

test('adversarial: path traversal in read', () => {
  const r = executeTask(makeMsg('read file ../../etc/passwd'), LANE);
  assert.strictEqual(r.task_kind, 'report');
  assert(r.results.error);
});

test('adversarial: path traversal in hash', () => {
  const r = executeTask(makeMsg('hash file ../../etc/shadow'), LANE);
  assert.strictEqual(r.task_kind, 'report');
  assert(r.results.error);
});

test('adversarial: git push rejected', () => {
  const r = executeTask(makeMsg('git push origin main'), LANE);
  assert.strictEqual(r.task_kind, 'report');
  assert(r.results.error);
});

test('adversarial: git checkout rejected', () => {
  const r = executeTask(makeMsg('git checkout -b evil'), LANE);
  assert.strictEqual(r.task_kind, 'report');
  assert(r.results.error);
});

test('adversarial: write to trust-store.json blocked', () => {
  const r = executeTask(makeMsg('write file S:/Archivist-Agent/lanes/broadcast/trust-store.json\n{"evil":true}'), LANE);
  assert.strictEqual(r.task_kind, 'report');
  assert(r.results.error.includes('blocked'));
});

test('adversarial: write to .identity/ blocked', () => {
  const r = executeTask(makeMsg('write file S:/Archivist-Agent/.identity/private.key\nSTOLEN'), LANE);
  assert.strictEqual(r.task_kind, 'report');
  assert(r.results.error.includes('blocked'));
});

// ============================================================
// SAFETY RAILS (v3 Reliability #2)
// ============================================================
test('safety: path outside roots in grep rejected', () => {
  const r = executeTask(makeMsg('grep "test" in Z:/nonexistent/path'), LANE);
  assert.strictEqual(r.task_kind, 'report');
  assert(r.results.error.includes('allowed roots'));
});

test('safety: path outside roots in count rejected', () => {
  const r = executeTask(makeMsg('count "test" in Z:/nonexistent/path'), LANE);
  assert.strictEqual(r.task_kind, 'report');
  assert(r.results.error.includes('allowed roots'));
});

test('safety: path outside roots in diff rejected', () => {
  const f1 = writeTmpFile('diff-safety-1.txt', 'aaa');
  const r = executeTask(makeMsg('diff ' + f1 + ' Z:/nonexistent/evil.txt'), LANE);
  assert.strictEqual(r.task_kind, 'report');
  assert(r.results.error.includes('allowed roots'));
});

test('safety: write to BOOTSTRAP.md blocked', () => {
  const r = executeTask(makeMsg('write file S:/Archivist-Agent/BOOTSTRAP.md\nEVIL'), LANE);
  assert.strictEqual(r.task_kind, 'report');
  assert(r.results.error.includes('blocked'));
});

test('safety: write to GOVERNANCE.md blocked', () => {
  const r = executeTask(makeMsg('write file S:/Archivist-Agent/GOVERNANCE.md\nEVIL'), LANE);
  assert.strictEqual(r.task_kind, 'report');
  assert(r.results.error.includes('blocked'));
});

test('safety: write to contradictions.json blocked', () => {
  const r = executeTask(makeMsg('write file S:/Archivist-Agent/lanes/broadcast/contradictions.json\n[]'), LANE);
  assert.strictEqual(r.task_kind, 'report');
  assert(r.results.error.includes('blocked'));
});

test('safety: isPathAllowed rejects unknown root', () => {
  const { isPathAllowed } = require('./generic-task-executor');
  assert.strictEqual(isPathAllowed('Z:/random/path'), false);
});

test('safety: isPathAllowed accepts lane root', () => {
  const { isPathAllowed } = require('./generic-task-executor');
  assert.strictEqual(isPathAllowed('S:/Archivist-Agent/scripts/test.js'), true);
});

test('instrumentation: timing metadata on result', () => {
  const r = executeTask(makeMsg('', { task_kind: 'status' }), LANE);
  assert(r.results._timing);
  assert(typeof r.results._timing.ms === 'number');
  assert(r.results._timing.ms >= 0);
  assert.strictEqual(r.results._timing.verb, 'status');
  assert.strictEqual(r.results._timing.source, 'explicit');
});

test('instrumentation: NLP routing includes timing', () => {
  const r = executeTask(makeMsg('what is the lane status'), LANE);
  assert(r.results._timing);
  assert.strictEqual(r.results._timing.source, 'nlp');
});

test('rollout: version is 3.x', () => {
  const { EXECUTOR_VERSION } = require('./generic-task-executor');
  assert(EXECUTOR_VERSION.startsWith('3.'));
});

test('rollout: feature flags present and enabled', () => {
  const { FEATURE_FLAGS } = require('./generic-task-executor');
  assert.strictEqual(FEATURE_FLAGS.v3_enabled, true);
  assert.strictEqual(FEATURE_FLAGS.nlp_routing, true);
  assert.strictEqual(FEATURE_FLAGS.safety_rails, true);
  assert.strictEqual(FEATURE_FLAGS.timing_instrumentation, true);
});

test('governance: createResponse includes _governance metadata', () => {
  const { createResponse } = require('./generic-task-executor');
  const msg = { task_id: 'gov-test', subject: 'test', from: 'archivist' };
  const result = { task_kind: 'status', results: { processed_count: 1 }, summary: 'ok' };
  const resp = createResponse(msg, result, 'archivist');
  assert(resp._governance);
  assert(resp._governance.executor_version.startsWith('3.'));
  assert(resp._governance.content_hash.startsWith('sha256:'));
  assert(resp._governance.timestamp);
});

// ============================================================
// DETERMINISM CHECKS
// ============================================================
test('determinism: status same result twice', () => {
  const r1 = executeTask(makeMsg('', { task_kind: 'status' }), LANE);
  const r2 = executeTask(makeMsg('', { task_kind: 'status' }), LANE);
  assert.strictEqual(r1.results.processed_count, r2.results.processed_count);
  assert.strictEqual(r1.results.quarantine_count, r2.results.quarantine_count);
});

test('determinism: hash same file twice', () => {
  const f = writeTmpFile('det2-test.bin', crypto.randomBytes(1024).toString('hex'));
  const r1 = executeTask(makeMsg(`hash file ${f}`), LANE);
  const r2 = executeTask(makeMsg(`hash file ${f}`), LANE);
  assert.strictEqual(r1.results.sha256, r2.results.sha256);
});

  // ============================================================
  // CONCURRENCY & HASH TESTS
  // ============================================================
  test('concurrency: lock file prevents double-execution', () => {
    const lockDir = path.join(TEST_DIR, 'concurrency');
    fs.mkdirSync(lockDir, { recursive: true });
    const lockFile = path.join(lockDir, 'task.lock');
    fs.writeFileSync(lockFile, JSON.stringify({ pid: 99999, ts: new Date().toISOString() }));
    const r = executeTask(makeMsg(`list dir ${lockDir}`), LANE);
    assert.ok(r.results !== undefined, 'Should still execute even with stale lock present');
  });

  test('concurrency: stale lock is re-entrant', () => {
    const lockDir = path.join(TEST_DIR, 'concurrency-stale');
    fs.mkdirSync(lockDir, { recursive: true });
    const lockFile = path.join(lockDir, 'task.lock');
    const staleTs = new Date(Date.now() - 3600000).toISOString();
    fs.writeFileSync(lockFile, JSON.stringify({ pid: 1, ts: staleTs }));
    const r = executeTask(makeMsg(`list dir ${lockDir}`), LANE);
    assert.ok(r.results !== undefined, 'Stale lock should not block execution');
  });

  test('hash: different files produce different hashes', () => {
    const f1 = writeTmpFile('hash-diff-a.txt', 'content A');
    const f2 = writeTmpFile('hash-diff-b.txt', 'content B');
    const r1 = executeTask(makeMsg(`hash file ${f1}`), LANE);
    const r2 = executeTask(makeMsg(`hash file ${f2}`), LANE);
    assert.notStrictEqual(r1.results.sha256, r2.results.sha256);
  });

  // ============================================================
  // SUMMARY
  // ============================================================
  cleanupTestDir();
console.log('\n========================================');
console.log(`Executor v3 Golden Tests: ${passed} PASS, ${failed} FAIL, ${passed + failed} total`);
console.log('========================================');
for (const r of results.filter(r => r.status === 'FAIL')) {
  console.log(`  FAIL: ${r.name}: ${r.error}`);
}
process.exit(failed > 0 ? 1 : 0);
