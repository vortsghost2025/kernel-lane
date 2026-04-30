#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const LANE_ROOTS = {
  archivist: 'S:/Archivist-Agent',
  kernel: 'S:/kernel-lane',
  library: 'S:/self-organizing-library',
  swarmmind: 'S:/SwarmMind',
};

function stateDir(lane) {
  return path.join(LANE_ROOTS[lane], 'lanes', lane, 'state');
}

function lockPath(lane) {
  return path.join(stateDir(lane), 'agent-active.lock');
}

function watcherModePath(lane) {
  return path.join(stateDir(lane), 'watcher-mode.json');
}

function readLock(lane) {
  const lp = lockPath(lane);
  if (!fs.existsSync(lp)) return null;
  try {
    return JSON.parse(fs.readFileSync(lp, 'utf8').replace(/^\uFEFF/, ''));
  } catch (_) {
    return null;
  }
}

function readWatcherMode(lane) {
  const mp = watcherModePath(lane);
  if (!fs.existsSync(mp)) return 'auto';
  try {
    const m = JSON.parse(fs.readFileSync(mp, 'utf8').replace(/^\uFEFF/, ''));
    return m.mode || 'auto';
  } catch (_) {
    return 'auto';
  }
}

function isAgentActive(lane) {
  const lock = readLock(lane);
  if (!lock) return false;
  const expiresAt = lock.expires_at ? new Date(lock.expires_at).getTime() : 0;
  if (expiresAt > 0 && Date.now() > expiresAt) {
    try { fs.unlinkSync(lockPath(lane)); } catch (_) {}
    return false;
  }
  return true;
}

function shouldWatcherProcess(lane) {
  const mode = readWatcherMode(lane);
  if (mode === 'disabled') return false;
  if (mode === 'agent-assist') return false;
  if (mode === 'manual') return false;
  if (isAgentActive(lane)) return false;
  return true;
}

function acquire(lane, opts = {}) {
  const sd = stateDir(lane);
  if (!fs.existsSync(sd)) fs.mkdirSync(sd, { recursive: true });
  const lock = {
    lane,
    acquired_at: new Date().toISOString(),
    expires_at: opts.expires_at || null,
    session_id: opts.session_id || `agent-${Date.now()}`,
    origin_runtime: opts.origin_runtime || 'kilo',
    origin_workspace: opts.origin_workspace || process.cwd(),
    pid: process.pid,
  };
  fs.writeFileSync(lockPath(lane), JSON.stringify(lock, null, 2));
  setWatcherMode(lane, 'agent-assist');
  return lock;
}

function release(lane) {
  const lp = lockPath(lane);
  if (fs.existsSync(lp)) {
    try { fs.unlinkSync(lp); } catch (_) {}
  }
  setWatcherMode(lane, 'auto');
}

function setWatcherMode(lane, mode) {
  const sd = stateDir(lane);
  if (!fs.existsSync(sd)) fs.mkdirSync(sd, { recursive: true });
  const valid = ['auto', 'agent-assist', 'manual', 'disabled'];
  if (!valid.includes(mode)) {
    throw new Error(`Invalid watcher mode: ${mode}. Valid: ${valid.join(', ')}`);
  }
  const m = {
    mode,
    lane,
    set_at: new Date().toISOString(),
    set_by: mode === 'agent-assist' ? 'agent-presence' : 'archivist',
  };
  fs.writeFileSync(watcherModePath(lane), JSON.stringify(m, null, 2));
  return m;
}

function status(lane) {
  const active = isAgentActive(lane);
  const lock = readLock(lane);
  const mode = readWatcherMode(lane);
  const willProcess = shouldWatcherProcess(lane);
  return {
    lane,
    agent_active: active,
    lock: lock ? { session_id: lock.session_id, acquired_at: lock.acquired_at, expires_at: lock.expires_at } : null,
    watcher_mode: mode,
    watcher_will_process: willProcess,
  };
}

function statusAll() {
  return Object.fromEntries(Object.keys(LANE_ROOTS).map(lane => [lane, status(lane)]));
}

module.exports = {
  isAgentActive,
  shouldWatcherProcess,
  acquire,
  release,
  setWatcherMode,
  readWatcherMode,
  status,
  statusAll,
  lockPath,
  watcherModePath,
  LANE_ROOTS,
};

if (require.main === module) {
  const args = process.argv.slice(2);
  const cmd = args[0];
  const lane = args[1];

  if (!cmd) {
    console.log('Usage: node agent-presence.js <command> [lane] [options]');
    console.log('');
    console.log('Commands:');
    console.log('  status [lane]     Show agent/watcher status (all lanes if omitted)');
    console.log('  acquire <lane>    Acquire agent lock (disables auto-watcher)');
    console.log('  release <lane>    Release agent lock (re-enables auto-watcher)');
    console.log('  mode <lane> <m>   Set watcher mode: auto|agent-assist|manual|disabled');
    console.log('  check <lane>      Exit 0 if watcher should process, 1 if not');
    process.exit(1);
  }

  if (cmd === 'status') {
    if (lane && LANE_ROOTS[lane]) {
      console.log(JSON.stringify(status(lane), null, 2));
    } else {
      console.log(JSON.stringify(statusAll(), null, 2));
    }
  } else if (cmd === 'acquire') {
    if (!lane || !LANE_ROOTS[lane]) { console.error('Specify a valid lane'); process.exit(1); }
    const lock = acquire(lane);
    console.log(JSON.stringify(lock, null, 2));
  } else if (cmd === 'release') {
    if (!lane || !LANE_ROOTS[lane]) { console.error('Specify a valid lane'); process.exit(1); }
    release(lane);
    console.log(`Released agent lock for ${lane}`);
  } else if (cmd === 'mode') {
    const mode = args[2];
    if (!lane || !LANE_ROOTS[lane] || !mode) { console.error('Usage: mode <lane> <auto|agent-assist|manual|disabled>'); process.exit(1); }
    const m = setWatcherMode(lane, mode);
    console.log(JSON.stringify(m, null, 2));
  } else if (cmd === 'check') {
    if (!lane || !LANE_ROOTS[lane]) { console.error('Specify a valid lane'); process.exit(1); }
    process.exit(shouldWatcherProcess(lane) ? 0 : 1);
  }
}
