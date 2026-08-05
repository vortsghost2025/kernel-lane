#!/usr/bin/env node
'use strict';

const { AdaptiveCpuAlerts, DEFAULT_CONFIG } = require('./adaptive-cpu-alerts');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

let passed = 0;
let failed = 0;
let testIdx = 0;

function test(name, fn) {
  testIdx++;
  const tmpDir = path.join('/tmp', `adaptive-alert-test-${Date.now()}-${testIdx}`);
  try {
    fn(tmpDir);
    passed++;
    console.log(`  PASS: ${name}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL: ${name} — ${e.message}`);
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true }); } catch (e) {}
  }
}

function makeAlert(lane, tmpDir, overrides) {
  const stateDir = path.join(tmpDir, 'state');
  return new AdaptiveCpuAlerts({
    lane,
    stateDir,
    config: Object.assign({
      enabled: true,
      sample_window_seconds: 60,
      baseline_window_samples: 240,
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
    }, overrides || {}),
  });
}

const WALL = 60;

console.log('=== Adaptive CPU Alert Tests ===\n');

test('normal CPU does not alert', (tmpDir) => {
  const alert = makeAlert('archivist', tmpDir);
  const normalDelta = 2.5 * WALL * 1_000_000 / 100;
  const result = alert.evaluate(normalDelta, 50 * 1024 * 1024, WALL);
  assert.strictEqual(result.shouldAlert, false, 'Normal CPU should not alert');
});

test('one CPU spike does not alert (below consecutive threshold)', (tmpDir) => {
  const alert = makeAlert('archivist', tmpDir);
  const normalDelta = 2.5 * WALL * 1_000_000 / 100;
  let cpu = 0;
  for (let i = 0; i < 10; i++) {
    cpu += normalDelta;
    alert.evaluate(cpu, 50 * 1024 * 1024, WALL);
  }
  const spikeDelta = 50 * WALL * 1_000_000 / 100;
  cpu += spikeDelta;
  const result = alert.evaluate(cpu, 50 * 1024 * 1024, WALL);
  assert.strictEqual(result.shouldAlert, false, 'Single spike should not alert');
});

test('sustained high CPU triggers warning after consecutive samples', (tmpDir) => {
  const alert = makeAlert('archivist', tmpDir);
  const normalDelta = 2.5 * WALL * 1_000_000 / 100;
  let cpu = 0;
  for (let i = 0; i < 10; i++) {
    cpu += normalDelta;
    alert.evaluate(cpu, 50 * 1024 * 1024, WALL);
  }
  const highDelta = 50 * WALL * 1_000_000 / 100;
  let lastResult;
  for (let i = 0; i < 5; i++) {
    cpu += highDelta;
    lastResult = alert.evaluate(cpu, 50 * 1024 * 1024, WALL);
  }
  assert.strictEqual(lastResult.shouldAlert, true, 'Sustained high CPU should alert');
  assert(lastResult.severity === 'WARNING' || lastResult.severity === 'CRITICAL',
    `Should be at least WARNING, got ${lastResult.severity}`);
});

test('sustained extreme CPU triggers critical', (tmpDir) => {
  const alert = makeAlert('archivist', tmpDir);
  const normalDelta = 2.5 * WALL * 1_000_000 / 100;
  let cpu = 0;
  for (let i = 0; i < 10; i++) {
    cpu += normalDelta;
    alert.evaluate(cpu, 50 * 1024 * 1024, WALL);
  }
  const extremeDelta = 55 * WALL * 1_000_000 / 100;
  let results = [];
  for (let i = 0; i < 10; i++) {
    cpu += extremeDelta;
    results.push(alert.evaluate(cpu, 50 * 1024 * 1024, WALL));
  }
  const firedAlert = results.find(r => r.shouldAlert && r.severity === 'CRITICAL');
  assert(firedAlert, 'Sustained extreme CPU should trigger CRITICAL alert');
  assert.strictEqual(firedAlert.severity, 'CRITICAL');
});

test('emergency hard ceiling triggers immediately', (tmpDir) => {
  const alert = makeAlert('archivist', tmpDir);
  const normalDelta = 2.5 * WALL * 1_000_000 / 100;
  let cpu = 0;
  for (let i = 0; i < 10; i++) {
    cpu += normalDelta;
    alert.evaluate(cpu, 50 * 1024 * 1024, WALL);
  }
  const emergencyDelta = 85 * WALL * 1_000_000 / 100;
  let results = [];
  for (let i = 0; i < 3; i++) {
    cpu += emergencyDelta;
    results.push(alert.evaluate(cpu, 50 * 1024 * 1024, WALL));
  }
  const firedAlert = results.find(r => r.shouldAlert && r.alerts.some(a => a.thresholdType === 'emergency_hard_ceiling'));
  assert(firedAlert, 'Emergency CPU should trigger CRITICAL emergency alert');
  assert.strictEqual(firedAlert.severity, 'CRITICAL', 'Emergency should be CRITICAL');
});

test('cooldown suppresses alert storm', (tmpDir) => {
  const alert = makeAlert('archivist', tmpDir);
  const normalDelta = 2.5 * WALL * 1_000_000 / 100;
  let cpu = 0;
  for (let i = 0; i < 10; i++) {
    cpu += normalDelta;
    alert.evaluate(cpu, 50 * 1024 * 1024, WALL);
  }
  const highDelta = 50 * WALL * 1_000_000 / 100;
  let alertCount = 0;
  for (let i = 0; i < 20; i++) {
    cpu += highDelta;
    const result = alert.evaluate(cpu, 50 * 1024 * 1024, WALL);
    if (result.shouldAlert) alertCount++;
  }
  assert(alertCount <= 2, `Expected at most 2 alerts during cooldown, got ${alertCount}`);
});

test('memory threshold triggers alert', (tmpDir) => {
  const alert = makeAlert('archivist', tmpDir);
  const result = alert.evaluate(1_500_000, 200 * 1024 * 1024, WALL);
  assert.strictEqual(result.shouldAlert, true, 'High memory should alert');
  const hasMem = result.alerts.some(a => a.metric === 'memory');
  assert.strictEqual(hasMem, true, 'Should include memory alert');
});

test('memory cooldown suppresses repeated alerts', (tmpDir) => {
  const alert = makeAlert('archivist', tmpDir);
  let alertCount = 0;
  let cpu = 0;
  const normalDelta = 2.5 * WALL * 1_000_000 / 100;
  for (let i = 0; i < 5; i++) {
    cpu += normalDelta;
    const result = alert.evaluate(cpu, 200 * 1024 * 1024, WALL);
    if (result.shouldAlert) alertCount++;
  }
  assert.strictEqual(alertCount, 1, `Expected exactly 1 memory alert, got ${alertCount}`);
});

test('adaptive thresholds use baseline when available', (tmpDir) => {
  const alert = makeAlert('archivist', tmpDir);
  const normalDelta = 2.5 * WALL * 1_000_000 / 100;
  let cpu = 0;
  for (let i = 0; i < 10; i++) {
    cpu += normalDelta;
    alert.evaluate(cpu, 50 * 1024 * 1024, WALL);
  }
  const thresholds = alert._getAdaptiveThresholds();
  assert.strictEqual(thresholds.mode, 'adaptive', 'Should use adaptive mode after baseline');
  assert(thresholds.baseline !== null, 'Should have baseline data');
  assert(thresholds.baseline.median >= 0, 'Median should be non-negative');
  assert(thresholds.baseline.p95 >= thresholds.baseline.median, 'P95 should be >= median');
});

test('falls back to static thresholds with insufficient baseline', (tmpDir) => {
  const alert = makeAlert('archivist', tmpDir);
  alert.loadState();
  const thresholds = alert._getAdaptiveThresholds();
  assert.strictEqual(thresholds.mode, 'static', 'Should use static mode with no baseline');
  assert.strictEqual(thresholds.warningPct, 5.0, 'Static floor should be 5%');
});

test('CPU normalization is correct', (tmpDir) => {
  const alert = makeAlert('archivist', tmpDir);
  const pct = alert._normalizeCpuPct(3_000_000, 60);
  assert.strictEqual(pct, 5, '3M usec over 60s should be 5%');
});

test('getStatus returns expected structure', (tmpDir) => {
  const alert = makeAlert('archivist', tmpDir);
  alert.evaluate(1_500_000, 50 * 1024 * 1024, WALL);
  const status = alert.getStatus();
  assert.strictEqual(status.lane, 'archivist');
  assert.strictEqual(status.sampleCount, 1);
  assert.strictEqual(typeof status.thresholds, 'object');
  assert.strictEqual(typeof status.consecutive, 'object');
});

test('escalate flag set on CRITICAL alerts', (tmpDir) => {
  const alert = makeAlert('archivist', tmpDir);
  const normalDelta = 2.5 * WALL * 1_000_000 / 100;
  let cpu = 0;
  for (let i = 0; i < 10; i++) {
    cpu += normalDelta;
    alert.evaluate(cpu, 50 * 1024 * 1024, WALL);
  }
  const extremeDelta = 55 * WALL * 1_000_000 / 100;
  let results = [];
  for (let i = 0; i < 10; i++) {
    cpu += extremeDelta;
    results.push(alert.evaluate(cpu, 50 * 1024 * 1024, WALL));
  }
  const criticalResult = results.find(r => r.shouldAlert && r.severity === 'CRITICAL');
  assert(criticalResult, 'Should have a CRITICAL alert result');
  assert.strictEqual(criticalResult.escalate, true, 'CRITICAL should set escalate=true');
});

test('disabled config produces no alerts', (tmpDir) => {
  const alert = makeAlert('archivist', tmpDir);
  alert.config.enabled = false;
  const result = alert.evaluate(55_000_000, 200 * 1024 * 1024, WALL);
  assert.strictEqual(result, null, 'Disabled should return null');
});

test('state persists across instances', (tmpDir) => {
  const alert1 = makeAlert('archivist', tmpDir);
  alert1.evaluate(1_500_000, 50 * 1024 * 1024, WALL);
  alert1.evaluate(3_000_000, 50 * 1024 * 1024, WALL);

  const alert2 = makeAlert('archivist', tmpDir);
  const status = alert2.getStatus();
  assert.strictEqual(status.sampleCount, 2, 'State should persist across instances');
});

test('consecutive counters reset on normal CPU', (tmpDir) => {
  const alert = makeAlert('archivist', tmpDir);
  const normalDelta = 2.5 * WALL * 1_000_000 / 100;
  let cpu = 0;
  for (let i = 0; i < 10; i++) {
    cpu += normalDelta;
    alert.evaluate(cpu, 50 * 1024 * 1024, WALL);
  }
  const highDelta = 10 * WALL * 1_000_000 / 100;
  for (let i = 0; i < 2; i++) {
    cpu += highDelta;
    alert.evaluate(cpu, 50 * 1024 * 1024, WALL);
  }
  assert.strictEqual(alert._state.consecutiveHighCpu, 2, 'Should have warning consecutive count of 2');

  cpu += normalDelta;
  alert.evaluate(cpu, 50 * 1024 * 1024, WALL);
  assert.strictEqual(alert._state.consecutiveHighCpu, 0, 'Warning consecutive should reset on normal CPU');
  assert.strictEqual(alert._state.consecutiveCriticalCpu, 0, 'Critical consecutive should reset on normal CPU');
  assert.strictEqual(alert._state.consecutiveEmergencyCpu, 0, 'Emergency consecutive should reset on normal CPU');
});

console.log(`\n=== Results: ${passed} passed, ${failed} failed, ${passed + failed} total ===`);
process.exit(failed > 0 ? 1 : 0);
