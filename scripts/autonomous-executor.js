#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const _ld = require('./util/lane-discovery');

const AUTONOMOUS_VERSION = '1.0.0';
const POLL_INTERVAL_MS = 15000;
const REMEDIATOR_INTERVAL_MS = 600000;
const STALE_AR_MS = 3600000;

let LANE_ROOTS;
if (typeof _ld.getRoots === 'function') {
  LANE_ROOTS = _ld.getRoots();
} else {
  const discovery = new _ld.LaneDiscovery();
  LANE_ROOTS = {};
  for (const lane of discovery.listLanes()) {
    LANE_ROOTS[lane] = discovery.getLocalPath(lane);
  }
}
const KNOWN_LANES = Object.keys(LANE_ROOTS);

const isWin32 = process.platform === 'win32';

function resolveRepoRoot(lane) {
  if (LANE_ROOTS[lane]) return LANE_ROOTS[lane];
  return path.resolve(__dirname, '..');
}

function nowIso() { return new Date().toISOString(); }
function ensureDir(d) { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); }

function safeReadJson(p) {
  try { return { ok: true, value: JSON.parse(fs.readFileSync(p, 'utf8')) }; }
  catch (e) { return { ok: false, error: e.message }; }
}

function countJson(dir) {
  if (!fs.existsSync(dir)) return 0;
  return fs.readdirSync(dir).filter(f => f.endsWith('.json') && !f.toLowerCase().startsWith('heartbeat')).length;
}

function runNode(cwd, script, args) {
  const nodeBin = process.execPath || 'node';
  const res = spawnSync(nodeBin, [script, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 30000,
    maxBuffer: 200000,
    env: { ...process.env, LANE_SESSION_ID: `auto-${process.pid}` },
  });
  return {
    ok: res.status === 0,
    exitCode: res.status,
    stdout: (res.stdout || '').trim(),
    stderr: (res.stderr || '').trim(),
    timedOut: res.killed || res.signal === 'SIGTERM',
  };
}

function journalAppend(lane, event, data) {
  const repoRoot = resolveRepoRoot(lane);
  const args = [
    'scripts/store-journal.js', 'append',
    '--lane', lane,
    '--event', event,
    '--agent', `autonomous-executor-v${AUTONOMOUS_VERSION}`,
    '--session-id', `auto-${process.pid}`,
  ];
  if (data) args.push('--data', JSON.stringify(data));
  const res = runNode(repoRoot, args[0], args.slice(1));
  if (!res.ok) {
    process.stderr.write(`[autonomous-executor] journal append failed: ${res.stderr}\n`);
  }
  return res.ok;
}

function journalPreflight(lane, filePaths) {
  const repoRoot = resolveRepoRoot(lane);
  const res = runNode(repoRoot, 'scripts/store-journal.js', [
    'preflight', '--lane', lane, '--paths', filePaths.join(','),
  ]);
  if (!res.ok) {
    try {
      const parsed = JSON.parse(res.stdout);
      if (parsed.verdict === 'BLOCK') return { clear: false, reason: 'JOURNAL_BLOCK', details: parsed };
    } catch (_) {}
    return { clear: false, reason: 'PREFLIGHT_FAILED', details: res.stderr };
  }
  return { clear: true };
}

function runGenericExecutor(lane, dryRun) {
  const repoRoot = resolveRepoRoot(lane);
  const args = ['scripts/generic-task-executor.js', lane];
  if (!dryRun) args.push('--apply');
  const res = runNode(repoRoot, args[0], args.slice(1));
  return {
    ok: res.ok,
    output: res.stdout,
    error: res.stderr,
    timedOut: res.timedOut,
  };
}

function runBlockedRemediator(lane, dryRun) {
  const repoRoot = resolveRepoRoot(lane);
  const args = ['scripts/blocked-remediator.js', `--lane=${lane}`];
  if (!dryRun) args.push('--apply');
  const res = runNode(repoRoot, args[0], args.slice(1));
  return {
    ok: res.ok,
    output: res.stdout,
    error: res.stderr,
  };
}

function scanActionRequired(lane) {
  const repoRoot = resolveRepoRoot(lane);
  const arDir = path.join(repoRoot, 'lanes', lane, 'inbox', 'action-required');
  const ipDir = path.join(repoRoot, 'lanes', lane, 'inbox', 'in-progress');
  const procDir = path.join(repoRoot, 'lanes', lane, 'inbox', 'processed');

  ensureDir(arDir);
  ensureDir(ipDir);
  ensureDir(procDir);

  const files = fs.readdirSync(arDir)
    .filter(f => f.endsWith('.json') && !f.toLowerCase().startsWith('heartbeat'))
    .map(f => {
      const fullPath = path.join(arDir, f);
      const stat = fs.statSync(fullPath);
      const ageMs = Date.now() - stat.mtimeMs;
      const read = safeReadJson(fullPath);
      return {
        filename: f,
        fullPath,
        ageMs,
        isStale: ageMs > STALE_AR_MS,
        msg: read.ok ? read.value : null,
        readError: read.ok ? null : read.error,
      };
    });

  return { arDir, ipDir, procDir, files };
}

function executeTaskWithJournal(lane, fileInfo) {
  const repoRoot = resolveRepoRoot(lane);
  const arDir = path.join(repoRoot, 'lanes', lane, 'inbox', 'action-required');
  const ipDir = path.join(repoRoot, 'lanes', lane, 'inbox', 'in-progress');
  const procDir = path.join(repoRoot, 'lanes', lane, 'inbox', 'processed');

  if (!fileInfo.msg) {
    const quarantineDir = path.join(repoRoot, 'lanes', lane, 'inbox', 'quarantine');
    ensureDir(quarantineDir);
    const qPath = path.join(quarantineDir, fileInfo.filename);
    try { fs.renameSync(fileInfo.fullPath, qPath); } catch (_) {}
    return { status: 'QUARANTINED', reason: fileInfo.readError };
  }

  const msg = fileInfo.msg;
  const targetPaths = [];

  if (msg.body) {
    const fileMatch = msg.body.match(/(?:file[:=]\s*|write\s+(?:file\s+)?(?:to\s+)?["']?)([^\s"']+)/i);
    if (fileMatch) targetPaths.push(fileMatch[1]);
  }

  if (targetPaths.length > 0) {
    const preflight = journalPreflight(lane, targetPaths);
    if (!preflight.clear) {
      return { status: 'BLOCKED', reason: preflight.reason, details: preflight.details };
    }
  }

  const inProgressPath = path.join(ipDir, fileInfo.filename);
  try { fs.renameSync(fileInfo.fullPath, inProgressPath); }
  catch (e) { return { status: 'ERROR', reason: `Move to in-progress failed: ${e.message}` }; }

  const execResult = runGenericExecutor(lane, false);

  let processedPath;
  try {
    processedPath = path.join(procDir, fileInfo.filename);
    let dest = processedPath;
    let counter = 0;
    while (fs.existsSync(dest) && counter < 100) {
      counter++;
      dest = path.join(procDir, fileInfo.filename.replace('.json', `-${counter}.json`));
    }
    if (fs.existsSync(inProgressPath)) {
      fs.renameSync(inProgressPath, dest);
    }
  } catch (e) {
    return { status: 'ERROR', reason: `Move to processed failed: ${e.message}`, execResult };
  }

  journalAppend(lane, 'work_completed', {
    target: fileInfo.filename,
    intent: `executed action-required task: ${msg.subject || msg.task_id || 'unknown'}`,
    handoff: { task_id: msg.task_id, executor: 'autonomous-executor', result: execResult.ok ? 'ok' : 'error' },
  });

  return { status: 'EXECUTED', execResult };
}

function handleStaleTasks(lane, staleFiles) {
  const repoRoot = resolveRepoRoot(lane);
  const procDir = path.join(repoRoot, 'lanes', lane, 'inbox', 'processed');
  ensureDir(procDir);

  const results = [];
  for (const fileInfo of staleFiles) {
    const destPath = path.join(procDir, fileInfo.filename);
    let dest = destPath;
    let counter = 0;
    while (fs.existsSync(dest) && counter < 100) {
      counter++;
      dest = path.join(procDir, fileInfo.filename.replace('.json', `-${counter}.json`));
    }
    try { fs.renameSync(fileInfo.fullPath, dest); }
    catch (e) { results.push({ file: fileInfo.filename, error: e.message }); continue; }

    journalAppend(lane, 'quarantine_event', {
      target: fileInfo.filename,
      intent: `stale action-required task expired after ${Math.round(fileInfo.ageMs / 3600000)}h, moved to processed`,
    });
    results.push({ file: fileInfo.filename, status: 'EXPIRED' });
  }
  return results;
}

class AutonomousExecutor {
  constructor(lane, options = {}) {
    this.lane = lane;
    this.repoRoot = resolveRepoRoot(lane);
    this.dryRun = options.dryRun || false;
    this.pollMs = options.pollMs || POLL_INTERVAL_MS;
    this.remediatorMs = options.remediatorMs || REMEDIATOR_INTERVAL_MS;
    this.running = false;
    this.stats = {
      cycleCount: 0,
      tasksExecuted: 0,
      tasksBlocked: 0,
      tasksExpired: 0,
      remediatorRuns: 0,
      errors: [],
    };
    this._lastRemediator = 0;
  }

  async runCycle() {
    this.stats.cycleCount++;
    const scan = scanActionRequired(this.lane);

    if (scan.files.length === 0) return;

    const stale = scan.files.filter(f => f.isStale);
    const active = scan.files.filter(f => !f.isStale);

    if (stale.length > 0) {
      const expiryResults = this.dryRun ? stale.map(f => ({ file: f.filename, status: 'WOULD_EXPIRE' })) : handleStaleTasks(this.lane, stale);
      this.stats.tasksExpired += stale.length;
      for (const r of expiryResults) {
        process.stdout.write(`[autonomous-executor] EXPIRED: ${r.file} (stale > ${Math.round(STALE_AR_MS / 3600000)}h)\n`);
      }
    }

    for (const fileInfo of active) {
      if (this.dryRun) {
        process.stdout.write(`[autonomous-executor] WOULD_EXECUTE: ${fileInfo.filename} task_id=${(fileInfo.msg || {}).task_id || '?'}\n`);
        continue;
      }

      const result = executeTaskWithJournal(this.lane, fileInfo);

      if (result.status === 'EXECUTED') {
        this.stats.tasksExecuted++;
        process.stdout.write(`[autonomous-executor] EXECUTED: ${fileInfo.filename}\n`);
      } else if (result.status === 'BLOCKED') {
        this.stats.tasksBlocked++;
        process.stdout.write(`[autonomous-executor] BLOCKED: ${fileInfo.filename} reason=${result.reason}\n`);
      } else if (result.status === 'QUARANTINED') {
        process.stdout.write(`[autonomous-executor] QUARANTINED: ${fileInfo.filename} reason=${result.reason}\n`);
      } else {
        this.stats.errors.push({ file: fileInfo.filename, reason: result.reason });
        process.stderr.write(`[autonomous-executor] ERROR: ${fileInfo.filename} ${result.reason}\n`);
      }
    }

    const now = Date.now();
    if (now - this._lastRemediator >= this.remediatorMs) {
      this._lastRemediator = now;
      this.stats.remediatorRuns++;
      const remResult = runBlockedRemediator(this.lane, this.dryRun);
      if (remResult.ok) {
        process.stdout.write(`[autonomous-executor] REMEDIATOR: cycle complete\n`);
      } else {
        process.stderr.write(`[autonomous-executor] REMEDIATOR: failed ${remResult.error}\n`);
      }
    }
  }

  async start() {
    this.running = true;
    journalAppend(this.lane, 'work_started', {
      target: `autonomous-executor-${this.lane}`,
      intent: `Autonomous executor v${AUTONOMOUS_VERSION} started (poll=${this.pollMs}ms, remediator=${this.remediatorMs}ms)`,
      active_ownership: {
        owner_agent: `autonomous-executor-v${AUTONOMOUS_VERSION}`,
        paths: [`lanes/${this.lane}/inbox/action-required`],
        reason: 'autonomous task execution',
        expires_at: new Date(Date.now() + 86400000).toISOString(),
      },
    });

    process.stdout.write(`[autonomous-executor] lane=${this.lane} dry_run=${this.dryRun} poll_ms=${this.pollMs} version=${AUTONOMOUS_VERSION}\n`);

    while (this.running) {
      try {
        await this.runCycle();
      } catch (err) {
        this.stats.errors.push({ cycle: this.stats.cycleCount, reason: err.message });
        process.stderr.write(`[autonomous-executor] CYCLE ERROR: ${err.message}\n`);
      }
      await new Promise(resolve => setTimeout(resolve, this.pollMs));
    }
  }

  stop() {
    this.running = false;
    journalAppend(this.lane, 'work_completed', {
      target: `autonomous-executor-${this.lane}`,
      intent: `Autonomous executor stopped after ${this.stats.cycleCount} cycles`,
      handoff: this.stats,
    });
  }

  getStats() {
    return {
      lane: this.lane,
      version: AUTONOMOUS_VERSION,
      dryRun: this.dryRun,
      ...this.stats,
    };
  }
}

function parseArgs(argv) {
  const out = { lane: null, dryRun: true, pollMs: POLL_INTERVAL_MS, remediatorMs: REMEDIATOR_INTERVAL_MS, once: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--lane' && argv[i + 1]) { out.lane = String(argv[i + 1]).toLowerCase(); i++; continue; }
    if (a.startsWith('--lane=')) { out.lane = a.split('=')[1].toLowerCase(); continue; }
    if (a === '--apply') { out.dryRun = false; continue; }
    if (a === '--once') { out.once = true; continue; }
    if (a === '--poll-ms' && argv[i + 1]) { out.pollMs = Math.max(1000, Number(argv[i + 1]) || out.pollMs); i++; continue; }
    if (a === '--remediator-ms' && argv[i + 1]) { out.remediatorMs = Math.max(60000, Number(argv[i + 1]) || out.remediatorMs); i++; continue; }
    if (!a.startsWith('-') && !out.lane && KNOWN_LANES.includes(a.toLowerCase())) { out.lane = a.toLowerCase(); }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.lane) {
    console.error(`Usage: node autonomous-executor.js <lane> [--apply] [--once] [--poll-ms N] [--remediator-ms N]`);
    console.error(`  Lanes: ${KNOWN_LANES.join(', ')}`);
    console.error(`  --apply     Execute tasks (default is dry run)`);
    console.error(`  --once      Run one cycle then exit`);
    console.error(`  --poll-ms   Poll interval in ms (default: ${POLL_INTERVAL_MS})`);
    console.error(`  --remediator-ms  Blocked-remediator interval in ms (default: ${REMEDIATOR_INTERVAL_MS})`);
    process.exit(1);
  }

  const executor = new AutonomousExecutor(args.lane, {
    dryRun: args.dryRun,
    pollMs: args.pollMs,
    remediatorMs: args.remediatorMs,
  });

  if (args.once) {
    await executor.runCycle();
    console.log(JSON.stringify(executor.getStats(), null, 2));
    return;
  }

  const handleSignal = (sig) => {
    process.stdout.write(`\n[autonomous-executor] Received ${sig}, shutting down...\n`);
    executor.stop();
    console.log(JSON.stringify(executor.getStats(), null, 2));
    process.exit(0);
  };

  process.on('SIGTERM', () => handleSignal('SIGTERM'));
  process.on('SIGINT', () => handleSignal('SIGINT'));

  await executor.start();
}

if (require.main === module) {
  main().catch(err => {
    console.error(`[autonomous-executor] FATAL: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { AutonomousExecutor, AUTONOMOUS_VERSION };
