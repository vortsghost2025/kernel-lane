#!/usr/bin/env node
'use strict';

const { LaneWorker } = require('./lane-worker');
const { AdaptiveCpuAlerts } = require('./adaptive-cpu-alerts');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

let passed = 0;
let failed = 0;

function test(name, fn) {
  const tmpDir = path.join('/tmp', `lane-worker-alert-test-${Date.now()}-${Math.random().toString(36).slice(2,8)}`);
  try {
    fn(tmpDir);
    passed++;
    console.log(` PASS: ${name}`);
  } catch (e) {
    failed++;
    console.log(` FAIL: ${name} — ${e.message}`);
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true }); } catch (e) {}
  }
}

function setupLaneDir(tmpDir) {
  const lane = 'kernel';
  const dirs = [
    path.join(tmpDir, 'lanes', lane, 'inbox'),
    path.join(tmpDir, 'lanes', lane, 'inbox', 'processed'),
    path.join(tmpDir, 'lanes', lane, 'state'),
    path.join(tmpDir, 'lanes', lane, 'metrics'),
    path.join(tmpDir, 'config'),
    path.join(tmpDir, 'scripts'),
  ];
  for (const d of dirs) {
    fs.mkdirSync(d, { recursive: true });
  }
  const configPath = path.join(tmpDir, 'config', 'adaptive-alerts.json');
  fs.writeFileSync(configPath, JSON.stringify({
    enabled: true,
    sample_window_seconds: 60,
    min_baseline_samples: 5,
    static_floor_pct: 5.0,
    warning_multiplier_p95: 2.5,
    critical_multiplier_p95: 5.0,
    warning_consecutive_samples: 3,
    critical_consecutive_samples: 5,
    warning_cooldown_seconds: 10,
    critical_cooldown_seconds: 5,
    emergency_hard_ceiling_pct: 80.0,
    emergency_consecutive_samples: 2,
    mem_threshold_bytes: 100 * 1024 * 1024,
    mem_cooldown_seconds: 10,
  }, null, 2), 'utf8');
  return lane;
}

console.log('=== LaneWorker Adaptive Alert Integration Tests ===\n');

test('LaneWorker constructor initializes adaptiveAlerts', (tmpDir) => {
  const lane = setupLaneDir(tmpDir);
  const worker = new LaneWorker({ repoRoot: tmpDir, lane, dryRun: true });
  assert(worker.adaptiveAlerts instanceof AdaptiveCpuAlerts, 'Should have adaptiveAlerts instance');
  assert.strictEqual(worker.adaptiveAlerts.lane, lane, 'Lane should match');
});

test('LaneWorker loads adaptive-alerts.json config', (tmpDir) => {
  const lane = setupLaneDir(tmpDir);
  const worker = new LaneWorker({ repoRoot: tmpDir, lane, dryRun: true });
  assert.strictEqual(worker.adaptiveAlerts.config.min_baseline_samples, 5, 'Should load overridden config');
  assert.strictEqual(worker.adaptiveAlerts.config.static_floor_pct, 5.0, 'Should load static_floor_pct');
});

test('LaneWorker logResourceMetrics uses adaptive alerts (no false positive)', (tmpDir) => {
  const lane = setupLaneDir(tmpDir);
  const worker = new LaneWorker({ repoRoot: tmpDir, lane, dryRun: true });
  worker.logResourceMetrics();
  const alertFile = path.join(tmpDir, 'lanes', lane, 'state', 'alerts.log');
  assert(!fs.existsSync(alertFile), 'Should not create alerts.log on normal CPU');
  const metricsFile = path.join(tmpDir, 'lanes', lane, 'metrics', 'resource_usage.jsonl');
  assert(fs.existsSync(metricsFile), 'Should still create metrics log');
});

test('LaneWorker logResourceMetrics persists adaptive state', (tmpDir) => {
  const lane = setupLaneDir(tmpDir);
  const worker = new LaneWorker({ repoRoot: tmpDir, lane, dryRun: true });
  worker.logResourceMetrics();
  const stateFile = path.join(tmpDir, 'lanes', lane, 'state', 'adaptive-alert-state.json');
  assert(fs.existsSync(stateFile), 'Should persist adaptive alert state');
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert(Array.isArray(state.samples), 'State should have samples array');
});

test('LaneWorker adaptiveAlerts replaces broken 80,000µs threshold', (tmpDir) => {
  const lane = setupLaneDir(tmpDir);
  const worker = new LaneWorker({ repoRoot: tmpDir, lane, dryRun: true });
  const cpuUsage = process.cpuUsage();
  const cpuTotalUsec = cpuUsage.user + cpuUsage.system;
  const result = worker.adaptiveAlerts.evaluate(cpuTotalUsec, process.memoryUsage().rss);
  assert(result !== null, 'Should return a result');
  assert.strictEqual(typeof result.shouldAlert, 'boolean', 'Should have shouldAlert boolean');
  assert.strictEqual(typeof result.cpuPct, 'number', 'Should have normalized cpuPct');
  assert(result.cpuPct >= 0 && result.cpuPct <= 100, `cpuPct should be 0-100%, got ${result.cpuPct}`);
});

test('LaneWorker _loadAdaptiveAlertConfig falls back gracefully on missing file', (tmpDir) => {
  const lane = 'kernel';
  fs.mkdirSync(path.join(tmpDir, 'lanes', lane, 'inbox', 'processed'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, 'config'), { recursive: true });
  const worker = new LaneWorker({ repoRoot: tmpDir, lane, dryRun: true });
  assert.strictEqual(worker.adaptiveAlerts.config.sample_window_seconds, 60, 'Should use defaults');
});

console.log(`\n=== Results: ${passed} passed, ${failed} failed, ${passed + failed} total ===`);
process.exit(failed > 0 ? 1 : 0);
