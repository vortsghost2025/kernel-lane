#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');
const { enforceProcessedDirCap, PROCESSED_DIR_CAP } = require('./inbox-watcher');

let passed = 0;
let failed = 0;

function assertEqual(actual, expected, label) {
  if (actual === expected) {
    passed++;
  } else {
    failed++;
    console.error(`FAIL: ${label} — expected ${expected}, got ${actual}`);
  }
}

function testDirectoryCapGuard() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-cap-test-'));
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-cap-repo-'));
  const logsDir = path.join(repoRoot, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  const testCap = 200;
  const dummyCount = 210;

  for (let i = 0; i < dummyCount; i++) {
    const name = `task-${String(i).padStart(4, '0')}-test.json`;
    fs.writeFileSync(path.join(tmpDir, name), JSON.stringify({ i }), 'utf8');
  }

  const beforeCount = fs.readdirSync(tmpDir).filter(f => f.endsWith('.json')).length;
  assertEqual(beforeCount, dummyCount, 'before cap: file count is 210');

  const result = enforceProcessedDirCap(tmpDir, 'kernel-test', repoRoot);

  assertEqual(result.capped, true, 'cap was enforced');
  assertEqual(result.removed.length, 10, '10 files removed (210 - 200)');

  const afterCount = fs.readdirSync(tmpDir).filter(f => f.endsWith('.json')).length;
  assertEqual(afterCount, testCap, 'after cap: file count is 200');

  const cpsLogPath = path.join(logsDir, 'cps_log.jsonl');
  const logExists = fs.existsSync(cpsLogPath);
  assertEqual(logExists, true, 'cps_log.jsonl was created');

  if (logExists) {
    const logContent = fs.readFileSync(cpsLogPath, 'utf8').trim();
    const logLines = logContent.split('\n');
    assertEqual(logLines.length, 1, 'one log entry written');
    const entry = JSON.parse(logLines[0]);
    assertEqual(entry.action, 'processed_dir_cap_truncation', 'log entry has correct action');
    assertEqual(entry.lane, 'kernel-test', 'log entry has correct lane');
    assertEqual(entry.removed_count, 10, 'log entry has correct removed_count');
    assertEqual(entry.cap, testCap, 'log entry has correct cap value');
  }

  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.rmSync(repoRoot, { recursive: true, force: true });
}

function testNoCapNeeded() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-cap-test-under-'));
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-cap-repo-under-'));

  for (let i = 0; i < 50; i++) {
    fs.writeFileSync(path.join(tmpDir, `msg-${i}.json`), '{}', 'utf8');
  }

  const result = enforceProcessedDirCap(tmpDir, 'kernel-test', repoRoot);
  assertEqual(result.capped, false, 'no cap enforced when under limit');
  assertEqual(result.removed.length, 0, 'no files removed');

  const afterCount = fs.readdirSync(tmpDir).filter(f => f.endsWith('.json')).length;
  assertEqual(afterCount, 50, 'file count unchanged at 50');

  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.rmSync(repoRoot, { recursive: true, force: true });
}

function testExactCap() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-cap-test-exact-'));
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-cap-repo-exact-'));

  for (let i = 0; i < 200; i++) {
    fs.writeFileSync(path.join(tmpDir, `msg-${i}.json`), '{}', 'utf8');
  }

  const result = enforceProcessedDirCap(tmpDir, 'kernel-test', repoRoot);
  assertEqual(result.capped, false, 'no cap enforced at exactly 200');
  assertEqual(result.removed.length, 0, 'no files removed at exactly 200');

  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.rmSync(repoRoot, { recursive: true, force: true });
}

function testOldestFilesRemoved() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-cap-test-oldest-'));
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-cap-repo-oldest-'));

  for (let i = 0; i < 205; i++) {
    const name = `task-${String(i).padStart(4, '0')}-test.json`;
    fs.writeFileSync(path.join(tmpDir, name), JSON.stringify({ i }), 'utf8');
  }

  const result = enforceProcessedDirCap(tmpDir, 'kernel-test', repoRoot);
  assertEqual(result.capped, true, 'cap enforced');
  assertEqual(result.removed.length, 5, '5 oldest files removed');

  const remaining = fs.readdirSync(tmpDir).filter(f => f.endsWith('.json')).sort();
  assertEqual(remaining.length, 200, '200 files remain');
  assertEqual(remaining[0], 'task-0005-test.json', 'oldest surviving file is task-0005');
  assertEqual(remaining[remaining.length - 1], 'task-0204-test.json', 'newest file preserved');

  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.rmSync(repoRoot, { recursive: true, force: true });
}

console.log('=== test-processed-dir-cap.js ===');
testDirectoryCapGuard();
testNoCapNeeded();
testExactCap();
testOldestFilesRemoved();
console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
