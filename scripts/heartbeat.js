'use strict';

const fs = require('fs');
const path = require('path');
const { loadPolicy, assertWatcherConfig } = require('./concurrency-policy');

const DEFAULT_CONFIG = {
  laneName: 'kernel',
  inboxPath: path.join(__dirname, '..', 'lanes', 'kernel', 'inbox'),
  intervalSeconds: 60,
  staleAfterSeconds: 900,
  canonicalPaths: {
    archivist: 'S:/Archivist-Agent/lanes/archivist/inbox/',
    library: 'S:/self-organizing-library/lanes/library/inbox/',
    swarmmind: 'S:/SwarmMind/lanes/swarmmind/inbox/',
    kernel: 'S:/kernel-lane/lanes/kernel/inbox/'
  }
};

const REPO_ROOT = path.join(__dirname, '..');
const POLICY = loadPolicy(REPO_ROOT);
assertWatcherConfig({
  laneName: DEFAULT_CONFIG.laneName,
  heartbeatSeconds: DEFAULT_CONFIG.intervalSeconds
}, POLICY);

class Heartbeat {
  constructor(configOverrides) {
    this.config = Object.assign({}, DEFAULT_CONFIG, configOverrides || {});
    this.startTime = Date.now();
    this.messagesProcessed = 0;
    this._timer = null;
    this._shuttingDown = false;
  }

  start() {
    this.writeHeartbeat();
    this._timer = setInterval(() => {
      this.writeHeartbeat();
    }, this.config.intervalSeconds * 1000);
    process.on('SIGINT', () => this._handleSignal('SIGINT'));
    process.on('SIGTERM', () => this._handleSignal('SIGTERM'));
  }

  stop() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    this._shuttingDown = true;
    this.writeHeartbeat();
  }

  _handleSignal(signal) {
    if (this._shuttingDown) return;
    this.stop();
    process.exit(0);
  }

  _heartbeatFilename(laneName) {
    return `heartbeat-${laneName}.json`;
  }

  _writeSystemState(systemState, activeContradictions, processedOk) {
    const broadcastDir = path.join(REPO_ROOT, 'lanes', 'broadcast');
    const statePath = path.join(broadcastDir, 'system_state.json');
    const payload = {
      system_status: systemState,
      timestamp: new Date().toISOString(),
      active_contradictions: activeContradictions,
      total_contradictions: activeContradictions.length,
      compaction_enabled: activeContradictions.length === 0,
      compaction_suspend_reason: activeContradictions.length > 0 ? 'Active contradictions present' : null,
      processed_ok: processedOk,
      derived_from: 'contradictions.json',
      written_by: 'heartbeat.js'
    };
    try {
      if (!fs.existsSync(broadcastDir)) {
        fs.mkdirSync(broadcastDir, { recursive: true });
      }
      fs.writeFileSync(statePath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
    } catch (err) {
      console.error('Failed to write system_state.json:', err.message);
    }
  }

  writeHeartbeat() {
    const now = new Date();
    const uptimeSeconds = Math.floor((Date.now() - this.startTime) / 1000);
    const status = this._shuttingDown ? 'shutdown' : 'alive';

    const hbStatus = this._shuttingDown ? 'done' : 'in_progress';

  // Load contradictions (truth-over-stability) — derive system_state, do NOT read system_state.json
  let systemState = 'consistent';
  let activeContradictions = [];
  let processedOk = true;
  try {
    const broadcastDir = path.join(REPO_ROOT, 'lanes', 'broadcast');
    const contraPath = path.join(broadcastDir, 'contradictions.json');

    if (fs.existsSync(contraPath)) {
      const contraData = JSON.parse(fs.readFileSync(contraPath, 'utf8'));
      activeContradictions = contraData
        .filter(c => c.status === 'active' || c.status === 'resolving')
        .map(c => c.id);
    }

    // TRUTH-OVER-STABILITY: contradictions override system_state
    if (activeContradictions.length > 0) {
      systemState = 'degraded';
    }
    this._writeSystemState(systemState, activeContradictions, processedOk);

    // Verify processed/ messages have completion proof
      const processedDir = path.join(this.config.inboxPath, 'processed');
      if (fs.existsSync(processedDir)) {
        const processedFiles = fs.readdirSync(processedDir).filter(f => f.endsWith('.json'));
        for (const f of processedFiles) {
          try {
            const msg = JSON.parse(fs.readFileSync(path.join(processedDir, f), 'utf8'));
            if (msg.requires_action) {
              const hasProof = (msg.completion_artifact_path || msg.completion_message_id || msg.resolved_by_task_id || msg.terminal_decision);
              if (!hasProof) {
                processedOk = false;
                break;
              }
            }
          } catch (_) { processedOk = false; break; }
        }
      }
    } catch (err) {
      console.error('Warning: could not load system state for heartbeat:', err.message);
    }

    const payload = {
      schema_version: '1.2',
      task_id: `heartbeat-${this.config.laneName}`,
      idempotency_key: (() => { const c = require('crypto'); return c.createHash('sha256').update(`heartbeat-${this.config.laneName}-fixed`).digest('hex'); })(),
      from: this.config.laneName,
      to: this.config.laneName,
      type: 'heartbeat',
      task_kind: 'proposal',
      priority: 'P3',
      subject: `Heartbeat: ${this.config.laneName} ${status}`,
      body: `Lane ${this.config.laneName} heartbeat. Uptime: ${uptimeSeconds}s. Messages processed: ${this.messagesProcessed}.`,
      timestamp: now.toISOString(),
      requires_action: false,
      payload: { mode: 'inline', compression: 'none', path: null, chunk: null },
      execution: { mode: 'manual', engine: 'kilo', actor: 'lane', session_id: null, parent_id: null },
      lease: { owner: this.config.laneName, acquired_at: now.toISOString(), expires_at: new Date(now.getTime() + 900000).toISOString(), renew_count: 0, max_renewals: 3 },
      retry: { attempt: 1, max_attempts: 3, last_error: null, last_attempt_at: null },
      evidence: { required: false, evidence_path: null, verified: true, verified_by: 'self', verified_at: now.toISOString() },
      heartbeat: { interval_seconds: this.config.intervalSeconds, last_heartbeat_at: now.toISOString(), timeout_seconds: this.config.staleAfterSeconds, status: hbStatus },
      lane: this.config.laneName,
      session_active: !this._shuttingDown,
      uptime_seconds: uptimeSeconds,
      messages_processed: this.messagesProcessed,
      last_inbox_scan: now.toISOString(),
      version: '1.0',
      system_state: systemState,
      active_contradictions: activeContradictions,
      processed_ok: processedOk,
      compaction_enabled: false,
      compaction_suspend_reason: activeContradictions.length > 0 ? 'P0 contradictions present in system' : null
    };

  const dir = this.config.inboxPath;
  try {
    if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); }
    const filePath = path.join(dir, this._heartbeatFilename(this.config.laneName));
    fs.writeFileSync(filePath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  } catch (err) {
    console.error('Failed to write heartbeat:', err.message);
  }
}

  incrementProcessed() { this.messagesProcessed++; }

  checkLaneHealth() {
    const now = Date.now();
    const lanes = {};
    for (const laneName of Object.keys(this.config.canonicalPaths)) {
      const inboxPath = this.config.canonicalPaths[laneName];
      const hbPath = path.join(inboxPath, this._heartbeatFilename(laneName));
      try {
        if (!fs.existsSync(hbPath)) {
          lanes[laneName] = { status: 'unknown', last_heartbeat: null, stale_for_seconds: 0 };
          continue;
        }
        const data = JSON.parse(fs.readFileSync(hbPath, 'utf8'));
        const elapsed = Math.floor((now - new Date(data.timestamp).getTime()) / 1000);
        lanes[laneName] = {
          status: elapsed > this.config.staleAfterSeconds ? 'stale' : 'alive',
          last_heartbeat: data.timestamp,
          stale_for_seconds: elapsed
        };
      } catch (err) {
        lanes[laneName] = { status: 'unknown', last_heartbeat: null, stale_for_seconds: 0 };
      }
    }
    return { timestamp: new Date().toISOString(), lanes };
  }
}

module.exports = { Heartbeat, DEFAULT_CONFIG };

if (require.main === module) {
  const args = process.argv.slice(2);
  const heartbeat = new Heartbeat();
  if (args.includes('--check')) {
    console.log(JSON.stringify(heartbeat.checkLaneHealth(), null, 2));
  } else if (args.includes('--once')) {
    heartbeat.writeHeartbeat();
  } else {
    heartbeat.start();
  }
}
