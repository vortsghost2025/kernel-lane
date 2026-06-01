#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_CONFIG = {
  enabled: true,
  sample_window_seconds: 60,
  baseline_window_samples: 240,
  min_baseline_samples: 30,
  static_floor_pct: 5.0,
  warning_multiplier_p95: 2.5,
  critical_multiplier_p95: 5.0,
  warning_consecutive_samples: 3,
  critical_consecutive_samples: 5,
  warning_cooldown_seconds: 1800,
  critical_cooldown_seconds: 600,
  emergency_hard_ceiling_pct: 80.0,
  emergency_consecutive_samples: 2,
  mem_threshold_bytes: 100 * 1024 * 1024,
  mem_cooldown_seconds: 1800,
};

class AdaptiveCpuAlerts {
  constructor(options = {}) {
    this.lane = options.lane || 'kernel';
    this.stateDir = options.stateDir;
    this.config = Object.assign({}, DEFAULT_CONFIG, options.config || {});
    this.statePath = path.join(this.stateDir, 'adaptive-alert-state.json');
    this._state = null;
    this._prevCpu = null;
    this._prevWallMs = null;
  }

  loadState() {
    try {
      if (fs.existsSync(this.statePath)) {
        this._state = JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
        if (!this._state.samples) this._state.samples = [];
        if (!this._state.alertCooldowns) this._state.alertCooldowns = {};
    if (this._state.consecutiveHighCpu === undefined) this._state.consecutiveHighCpu = 0;
    if (this._state.consecutiveCriticalCpu === undefined) this._state.consecutiveCriticalCpu = 0;
    if (this._state.consecutiveEmergencyCpu === undefined) this._state.consecutiveEmergencyCpu = 0;
        return;
      }
    } catch (e) {
      process.stderr.write(`[adaptive-cpu-alerts] Failed to load state: ${e.message}\n`);
    }
    this._state = {
      samples: [],
      alertCooldowns: {},
      consecutiveHighCpu: 0,
      consecutiveCriticalCpu: 0,
      consecutiveEmergencyCpu: 0,
    };
  }

  saveState() {
    try {
      if (!fs.existsSync(this.stateDir)) {
        fs.mkdirSync(this.stateDir, { recursive: true });
      }
      fs.writeFileSync(this.statePath, JSON.stringify(this._state, null, 2), 'utf8');
    } catch (e) {
      process.stderr.write(`[adaptive-cpu-alerts] Failed to save state: ${e.message}\n`);
    }
  }

  _normalizeCpuPct(cpuUsagec, wallSeconds) {
    if (wallSeconds <= 0) return 0;
    return (cpuUsagec / (wallSeconds * 1_000_000)) * 100;
  }

  _computeBaseline() {
    const samples = this._state.samples;
    if (samples.length < this.config.min_baseline_samples) return null;

    const pctValues = samples.map(s => s.cpuPct).sort((a, b) => a - b);
    const n = pctValues.length;

    const median = n % 2 === 0
      ? (pctValues[n / 2 - 1] + pctValues[n / 2]) / 2
      : pctValues[Math.floor(n / 2)];

    const p95Idx = Math.floor(n * 0.95);
    const p95 = pctValues[Math.min(p95Idx, n - 1)];

    const absDeviations = pctValues.map(v => Math.abs(v - median)).sort((a, b) => a - b);
    const mad = absDeviations.length % 2 === 0
      ? (absDeviations[absDeviations.length / 2 - 1] + absDeviations[absDeviations.length / 2]) / 2
      : absDeviations[Math.floor(absDeviations.length / 2)];

    return { median, p95, mad };
  }

  _getAdaptiveThresholds() {
    const baseline = this._computeBaseline();
    if (!baseline) {
    return {
      warningPct: this.config.static_floor_pct,
      criticalPct: this.config.static_floor_pct * 5,
      emergencyPct: this.config.emergency_hard_ceiling_pct,
      mode: 'static',
      baseline: null,
    };
    }

    const adaptiveWarn = Math.max(
      this.config.static_floor_pct,
      baseline.p95 * this.config.warning_multiplier_p95,
      baseline.median + 3 * baseline.mad
    );
    const adaptiveCritical = Math.max(
      this.config.static_floor_pct * 2,
      baseline.p95 * this.config.critical_multiplier_p95
    );

    return {
      warningPct: adaptiveWarn,
      criticalPct: adaptiveCritical,
      emergencyPct: this.config.emergency_hard_ceiling_pct,
      mode: 'adaptive',
      baseline,
    };
  }

  _isCooldownActive(key) {
    const cooldowns = this._state.alertCooldowns;
    if (!cooldowns[key]) return false;
    return Date.now() < cooldowns[key];
  }

  _setCooldown(key, seconds) {
    this._state.alertCooldowns[key] = Date.now() + (seconds * 1000);
  }

  evaluate(cpuTotalUsec, memRss, _wallSecondsOverride) {
    if (!this.config.enabled) return null;

    this.loadState();

    const now = Date.now();

    let deltaCpuUsec;
    let wallSeconds;

    if (this._prevCpu !== null && this._prevWallMs !== null) {
      deltaCpuUsec = Math.max(0, cpuTotalUsec - this._prevCpu);
      wallSeconds = _wallSecondsOverride != null
        ? _wallSecondsOverride
        : (now - this._prevWallMs) / 1000;
    } else {
      this._state.consecutiveHighCpu = 0;
      this._state.consecutiveCriticalCpu = 0;
      this._state.consecutiveEmergencyCpu = 0;
      deltaCpuUsec = cpuTotalUsec;
      wallSeconds = _wallSecondsOverride != null
        ? _wallSecondsOverride
        : Math.max(this.config.sample_window_seconds, process.uptime());
    }

    const cpuPct = this._normalizeCpuPct(deltaCpuUsec, wallSeconds);

    this._prevWallMs = now;
    this._prevCpu = cpuTotalUsec;

  const thresholds = this._getAdaptiveThresholds();
  const result = this._checkThresholds(cpuPct, memRss, thresholds);

  if (cpuPct < thresholds.warningPct) {
    this._state.samples.push({
      timestamp: new Date().toISOString(),
      cpuPct: Math.round(cpuPct * 1000) / 1000,
      cpuDeltaUsec: deltaCpuUsec,
      cpuTotalUsec,
      wallSeconds: Math.round(wallSeconds * 10) / 10,
    });
  }

    const maxSamples = this.config.baseline_window_samples * 2;
    if (this._state.samples.length > maxSamples) {
      this._state.samples = this._state.samples.slice(-this.config.baseline_window_samples);
    }

    this.saveState();
    return result;
  }

  _checkThresholds(cpuPct, memRss, thresholds) {
    const alerts = [];

    if (cpuPct >= thresholds.emergencyPct) {
      this._state.consecutiveEmergencyCpu++;
      this._state.consecutiveHighCpu = 0;
      this._state.consecutiveCriticalCpu = 0;

      if (this._state.consecutiveEmergencyCpu >= this.config.emergency_consecutive_samples) {
        const key = `cpu-emergency-${this.lane}`;
        if (!this._isCooldownActive(key)) {
          alerts.push({
            severity: 'CRITICAL',
            metric: 'cpu',
            value: cpuPct,
            threshold: thresholds.emergencyPct,
            thresholdType: 'emergency_hard_ceiling',
            mode: thresholds.mode,
            consecutive: this._state.consecutiveEmergencyCpu,
            message: `EMERGENCY: CPU at ${cpuPct.toFixed(1)}% exceeds hard ceiling ${thresholds.emergencyPct}% for ${this._state.consecutiveEmergencyCpu} consecutive samples`,
          });
          this._setCooldown(key, this.config.critical_cooldown_seconds);
          this._state.consecutiveEmergencyCpu = 0;
        }
      }
    } else if (cpuPct >= thresholds.criticalPct) {
      this._state.consecutiveCriticalCpu++;
      this._state.consecutiveHighCpu = 0;
      this._state.consecutiveEmergencyCpu = 0;

      if (this._state.consecutiveCriticalCpu >= this.config.critical_consecutive_samples) {
        const key = `cpu-critical-${this.lane}`;
        if (!this._isCooldownActive(key)) {
          alerts.push({
            severity: 'CRITICAL',
            metric: 'cpu',
            value: cpuPct,
            threshold: thresholds.criticalPct,
            thresholdType: 'adaptive_critical',
            mode: thresholds.mode,
            consecutive: this._state.consecutiveCriticalCpu,
            baseline: thresholds.baseline,
            message: `CRITICAL: CPU at ${cpuPct.toFixed(1)}% exceeds adaptive critical threshold ${thresholds.criticalPct.toFixed(1)}% for ${this._state.consecutiveCriticalCpu} consecutive samples`,
          });
          this._setCooldown(key, this.config.critical_cooldown_seconds);
          this._state.consecutiveCriticalCpu = 0;
        }
      }
    } else if (cpuPct >= thresholds.warningPct) {
      this._state.consecutiveHighCpu++;
      this._state.consecutiveCriticalCpu = 0;
      this._state.consecutiveEmergencyCpu = 0;

      if (this._state.consecutiveHighCpu >= this.config.warning_consecutive_samples) {
        const key = `cpu-warning-${this.lane}`;
        if (!this._isCooldownActive(key)) {
          alerts.push({
            severity: 'WARNING',
            metric: 'cpu',
            value: cpuPct,
            threshold: thresholds.warningPct,
            thresholdType: 'adaptive_warning',
            mode: thresholds.mode,
            consecutive: this._state.consecutiveHighCpu,
            baseline: thresholds.baseline,
            message: `WARNING: CPU at ${cpuPct.toFixed(1)}% exceeds adaptive warning threshold ${thresholds.warningPct.toFixed(1)}% for ${this._state.consecutiveHighCpu} consecutive samples`,
          });
          this._setCooldown(key, this.config.warning_cooldown_seconds);
          this._state.consecutiveHighCpu = 0;
        }
      }
    } else {
      this._state.consecutiveHighCpu = 0;
      this._state.consecutiveCriticalCpu = 0;
      this._state.consecutiveEmergencyCpu = 0;
    }

    if (memRss > this.config.mem_threshold_bytes) {
      const key = `mem-warning-${this.lane}`;
      if (!this._isCooldownActive(key)) {
        const memPct = (memRss / this.config.mem_threshold_bytes) * 100;
        alerts.push({
          severity: memPct > 200 ? 'CRITICAL' : 'WARNING',
          metric: 'memory',
          value: memRss,
          threshold: this.config.mem_threshold_bytes,
          thresholdType: 'static',
          mode: 'static',
          message: `Memory RSS at ${(memRss / 1024 / 1024).toFixed(1)}MB exceeds threshold ${(this.config.mem_threshold_bytes / 1024 / 1024).toFixed(0)}MB`,
        });
        this._setCooldown(key, this.config.mem_cooldown_seconds);
      }
    }

    const escalate = alerts.some(a => a.severity === 'CRITICAL');
    const maxAlert = alerts.length > 0 ? alerts.reduce((a, b) => {
      const rank = { CRITICAL: 3, WARNING: 2, INFO: 1 };
      return (rank[a.severity] || 0) >= (rank[b.severity] || 0) ? a : b;
    }) : null;

    return {
      shouldAlert: alerts.length > 0,
      severity: maxAlert ? maxAlert.severity : null,
      alerts,
      cpuPct,
      thresholds,
      escalate,
    };
  }

  getStatus() {
    this.loadState();
    const thresholds = this._getAdaptiveThresholds();
    const lastSample = this._state.samples.length > 0
      ? this._state.samples[this._state.samples.length - 1]
      : null;

    return {
      lane: this.lane,
      sampleCount: this._state.samples.length,
      baselineReady: this._state.samples.length >= this.config.min_baseline_samples,
      thresholds,
      lastSample,
      consecutive: {
        warning: this._state.consecutiveHighCpu,
        critical: this._state.consecutiveCriticalCpu,
        emergency: this._state.consecutiveEmergencyCpu,
      },
      cooldowns: Object.entries(this._state.alertCooldowns).reduce((acc, [k, v]) => {
        acc[k] = { expiresAt: new Date(v).toISOString(), active: Date.now() < v };
        return acc;
      }, {}),
    };
  }
}

AdaptiveCpuAlerts.DEFAULT_CONFIG = DEFAULT_CONFIG;

module.exports = { AdaptiveCpuAlerts, DEFAULT_CONFIG };
