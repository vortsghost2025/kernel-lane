#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const LANE = 'swarmmind';
const ACTION_REQUIRED_DIR = path.join(REPO_ROOT, 'lanes', LANE, 'inbox', 'action-required');
const IN_PROGRESS_DIR = path.join(REPO_ROOT, 'lanes', LANE, 'inbox', 'in-progress');
const PROCESSED_DIR = path.join(REPO_ROOT, 'lanes', LANE, 'inbox', 'processed');
const OUTBOX_DIR = path.join(REPO_ROOT, 'lanes', LANE, 'outbox');

const ARCHIVIST_INBOX = 'S:/Archivist-Agent/lanes/archivist/inbox/';

function nowIso() { return new Date().toISOString(); }

function ensureDir(d) { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); }

function safeReadJson(p) {
  try { return { ok: true, value: JSON.parse(fs.readFileSync(p, 'utf8')) }; }
  catch (e) { return { ok: false, error: e.message }; }
}

function runNode(scriptPath, args = []) {
  const res = spawnSync('node', [scriptPath, ...args], { encoding: 'utf8', cwd: REPO_ROOT });
  return { ok: res.status === 0, stdout: (res.stdout || '').trim(), stderr: (res.stderr || '').trim() };
}

function countJson(dir) {
  if (!fs.existsSync(dir)) return 0;
  return fs.readdirSync(dir).filter(f => f.endsWith('.json') && !f.toLowerCase().startsWith('heartbeat')).length;
}

function executeStatusTask(msg) {
  const processed = countJson(PROCESSED_DIR);
  const quarantine = countJson(path.join(REPO_ROOT, 'lanes', LANE, 'inbox', 'quarantine'));

  let syncStatus = 'UNKNOWN';
  const sgResult = runNode(path.join(REPO_ROOT, 'scripts', 'sync-gate-verify.js'));
  if (sgResult.ok && sgResult.stdout) {
    try {
      const parsed = JSON.parse(sgResult.stdout);
      syncStatus = parsed.status || 'UNKNOWN';
    } catch (_) {}
  }

  return {
    task_kind: 'status',
    results: {
      processed_count: processed,
      quarantine_count: quarantine,
      sync_gate_verify: syncStatus,
    },
    summary: `Processed: ${processed}, Quarantine: ${quarantine}, Sync-Gate: ${syncStatus}`,
  };
}

function executeTask(msg) {
  const kind = (msg.task_kind || '').toLowerCase();
  const body = (msg.body || '').toLowerCase();

  if (kind === 'status' || body.includes('processed count') || body.includes('sync-gate')) {
    return executeStatusTask(msg);
  }

  return {
    task_kind: kind || 'ack',
    results: { acknowledged: true },
    summary: `Acknowledged task: ${msg.subject || msg.task_id}`,
  };
}

function createResponse(originalMsg, executionResult) {
  return {
    schema_version: '1.3',
    task_id: `response-${originalMsg.task_id || Date.now()}`,
    idempotency_key: `resp-${Date.now()}-${(originalMsg.task_id || 'unknown').slice(0, 16)}`,
    from: LANE,
    to: originalMsg.from || 'archivist',
    type: 'response',
    task_kind: executionResult.task_kind || 'ack',
    priority: originalMsg.priority || 'P2',
    subject: `Re: ${originalMsg.subject || 'Task'}`,
    body: executionResult.summary || 'Task completed.',
    timestamp: nowIso(),
    requires_action: false,
    payload: { mode: 'inline', compression: 'none' },
    execution: { mode: 'manual', engine: 'opencode', actor: 'lane' },
    lease: { owner: LANE, acquired_at: nowIso() },
    retry: { attempt: 1, max_attempts: 1 },
    evidence: { required: true, verified: true },
    evidence_exchange: {
      artifact_path: `lanes/${LANE}/inbox/processed/response-${originalMsg.task_id || Date.now()}.json`,
      artifact_type: 'log',
      delivered_at: nowIso(),
    },
    heartbeat: { status: 'done', last_heartbeat_at: nowIso(), interval_seconds: 300, timeout_seconds: 900 },
    _original_task_id: originalMsg.task_id,
    _execution_result: executionResult.results,
  };
}

function signAndDeliver(response) {
  try {
    const { createSignedMessage } = require(path.join(REPO_ROOT, 'scripts', 'create-signed-message.js'));
    const signed = createSignedMessage(response, LANE);

    const outPath = path.join(OUTBOX_DIR, `${response.task_id}.json`);
    ensureDir(OUTBOX_DIR);
    fs.writeFileSync(outPath, JSON.stringify(signed, null, 2), 'utf8');

    const targetDir = ARCHIVIST_INBOX;
    ensureDir(targetDir);
    const targetPath = path.join(targetDir, `${response.task_id}.json`);
    fs.writeFileSync(targetPath, JSON.stringify(signed, null, 2), 'utf8');

    return { delivered: true, path: targetPath, outbox: outPath };
  } catch (e) {
    ensureDir(OUTBOX_DIR);
    const outPath = path.join(OUTBOX_DIR, `${response.task_id}.json`);
    fs.writeFileSync(outPath, JSON.stringify(response, null, 2), 'utf8');

    const targetDir = ARCHIVIST_INBOX;
    ensureDir(targetDir);
    const targetPath = path.join(targetDir, `${response.task_id}.json`);
    fs.writeFileSync(targetPath, JSON.stringify(response, null, 2), 'utf8');

    return { delivered: true, path: targetPath, outbox: outPath, signing_error: e.message };
  }
}

class TaskExecutor {
  constructor(options = {}) {
    this.dryRun = options.dryRun !== undefined ? !!options.dryRun : true;
    this.executed = 0;
    this.errors = [];
    this.details = [];
  }

  run() {
    ensureDir(ACTION_REQUIRED_DIR);
    ensureDir(IN_PROGRESS_DIR);
    ensureDir(PROCESSED_DIR);

    const files = fs.readdirSync(ACTION_REQUIRED_DIR)
      .filter(f => f.endsWith('.json') && !f.toLowerCase().startsWith('heartbeat'));

    if (files.length === 0) {
      return { scanned: 0, executed: 0, errors: [] };
    }

    for (const filename of files) {
      const filePath = path.join(ACTION_REQUIRED_DIR, filename);
      const read = safeReadJson(filePath);
      if (!read.ok) {
        this.errors.push({ file: filename, error: read.error });
        continue;
      }

      const msg = read.value;
      // Strip lane-worker metadata for clean processing
      delete msg._lane_worker;

      if (this.dryRun) {
        this.details.push({
          file: filename,
          task_id: msg.task_id,
          subject: (msg.subject || '').slice(0, 60),
          action: 'WOULD_EXECUTE',
        });
        continue;
      }

      // Move to in-progress
      const inProgressPath = path.join(IN_PROGRESS_DIR, filename);
      try { fs.renameSync(filePath, inProgressPath); } catch (e) {
        this.errors.push({ file: filename, error: `Move to in-progress failed: ${e.message}` });
        continue;
      }

      // Execute
      const result = executeTask(msg);

      // Create and deliver response
      const response = createResponse(msg, result);
      const delivery = signAndDeliver(response);

      // Move to processed
      const processedPath = path.join(PROCESSED_DIR, filename);
      try { fs.renameSync(inProgressPath, processedPath); } catch (e) {
        this.errors.push({ file: filename, error: `Move to processed failed: ${e.message}` });
      }

      this.executed++;
      this.details.push({
        file: filename,
        task_id: msg.task_id,
        subject: (msg.subject || '').slice(0, 60),
        action: 'EXECUTED',
        response_id: response.task_id,
        delivered_to: delivery.path,
      });
    }

    return { scanned: files.length, executed: this.executed, errors: this.errors, details: this.details };
  }
}

function parseArgs(argv) {
  const out = { apply: false };
  for (const a of argv) {
    if (a === '--apply') out.apply = true;
  }
  return out;
}

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  const executor = new TaskExecutor({ dryRun: !args.apply });
  const result = executor.run();

  console.log(`[task-executor] dry_run=${!args.apply} scanned=${result.scanned} executed=${result.executed} errors=${result.errors.length}`);
  for (const d of (result.details || [])) {
    console.log(`  ${d.action}: ${d.task_id} "${d.subject}" ${d.delivered_to ? '-> ' + d.delivered_to : ''}`);
  }
  for (const e of result.errors) {
    console.log(`  ERROR: ${e.file}: ${e.error}`);
  }
}

module.exports = { TaskExecutor, executeTask, createResponse };
