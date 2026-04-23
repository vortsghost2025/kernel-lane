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

  writeHeartbeat() {
    const now = new Date();
    const uptimeSeconds = Math.floor((Date.now() - this.startTime) / 1000);
    const status = this._shuttingDown ? 'shutdown' : 'alive';

    const payload = {
      lane: this.config.laneName,
      timestamp: now.toISOString(),
      status: status,
      session_active: !this._shuttingDown,
      uptime_seconds: uptimeSeconds,
      messages_processed: this.messagesProcessed,
      last_inbox_scan: now.toISOString(),
      version: '1.0'
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
