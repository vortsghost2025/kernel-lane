#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const LANE_REGISTRY = {
  archivist: { root: 'S:/Archivist-Agent', inbox_target: 'S:/Archivist-Agent/lanes/archivist/inbox' },
  kernel: { root: 'S:/kernel-lane', inbox_target: 'S:/Archivist-Agent/lanes/archivist/inbox' },
  library: { root: 'S:/self-organizing-library', inbox_target: 'S:/Archivist-Agent/lanes/archivist/inbox' },
  swarmmind: { root: 'S:/SwarmMind', inbox_target: 'S:/Archivist-Agent/lanes/archivist/inbox' },
};

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

function resolveTargetInbox(msg, senderLane) {
  if (msg.from === 'archivist') return LANE_REGISTRY.archivist.inbox_target;
  if (LANE_REGISTRY[msg.from]) return LANE_REGISTRY[msg.from].inbox_target;
  return LANE_REGISTRY.archivist.inbox_target;
}

function executeStatusTask(msg, lane) {
  const root = LANE_REGISTRY[lane].root;
  const processed = countJson(path.join(root, 'lanes', lane, 'inbox', 'processed'));
  const quarantine = countJson(path.join(root, 'lanes', lane, 'inbox', 'quarantine'));
  return {
    task_kind: 'status',
    results: { processed_count: processed, quarantine_count: quarantine },
    summary: `${lane}: Processed=${processed}, Quarantine=${quarantine}`,
  };
}

function executeTask(msg, lane) {
  const kind = (msg.task_kind || '').toLowerCase();
  const body = (msg.body || '').toLowerCase();

  if (kind === 'status' || body.includes('processed count') || body.includes('sync-gate')) {
    return executeStatusTask(msg, lane);
  }

  return {
    task_kind: kind || 'ack',
    results: { acknowledged: true },
    summary: `Acknowledged task: ${msg.subject || msg.task_id || 'unknown'}`,
  };
}

function createResponse(originalMsg, executionResult, lane) {
  return {
    schema_version: '1.3',
    task_id: `response-${originalMsg.task_id || Date.now()}`,
    idempotency_key: `resp-${Date.now()}-${(originalMsg.task_id || 'unknown').slice(0, 16)}`,
    from: lane,
    to: originalMsg.from || 'archivist',
    type: 'response',
    task_kind: executionResult.task_kind || 'ack',
    priority: originalMsg.priority || 'P2',
    subject: `Re: ${originalMsg.subject || 'Task'}`,
    body: executionResult.summary || 'Task completed.',
    timestamp: nowIso(),
    requires_action: false,
    payload: { mode: 'inline', compression: 'none' },
    execution: { mode: 'auto', engine: 'pipeline', actor: 'task-executor' },
    lease: { owner: lane, acquired_at: nowIso() },
    retry: { attempt: 1, max_attempts: 1 },
    evidence: { required: false, verified: true },
    evidence_exchange: {
      artifact_path: null,
      artifact_type: 'response',
      delivered_at: nowIso(),
    },
    heartbeat: { status: 'done', last_heartbeat_at: nowIso(), interval_seconds: 300, timeout_seconds: 900 },
    _original_task_id: originalMsg.task_id,
    _execution_result: executionResult.results,
  };
}

function signAndDeliver(response, lane) {
  const root = LANE_REGISTRY[lane].root;
  const outboxDir = path.join(root, 'lanes', lane, 'outbox');
  ensureDir(outboxDir);

  let signed = response;
  try {
    const { createSignedMessage } = require(path.join(root, 'scripts', 'create-signed-message.js'));
    signed = createSignedMessage(response, lane);
  } catch (e) {
    signed._signing_error = e.message;
  }

  const outPath = path.join(outboxDir, `${response.task_id}.json`);
  fs.writeFileSync(outPath, JSON.stringify(signed, null, 2), 'utf8');

  const targetDir = resolveTargetInbox(response, lane);
  ensureDir(targetDir);
  const targetPath = path.join(targetDir, `${response.task_id}.json`);
  fs.writeFileSync(targetPath, JSON.stringify(signed, null, 2), 'utf8');

  return { delivered: true, path: targetPath, outbox: outPath };
}

class GenericTaskExecutor {
  constructor(lane, options = {}) {
    this.lane = lane;
    this.dryRun = options.dryRun !== undefined ? !!options.dryRun : true;
    this.root = LANE_REGISTRY[lane].root;
    this.arDir = path.join(this.root, 'lanes', lane, 'inbox', 'action-required');
    this.ipDir = path.join(this.root, 'lanes', lane, 'inbox', 'in-progress');
    this.procDir = path.join(this.root, 'lanes', lane, 'inbox', 'processed');
    this.executed = 0;
    this.errors = [];
    this.details = [];
  }

  run() {
    ensureDir(this.arDir);
    ensureDir(this.ipDir);
    ensureDir(this.procDir);

    const files = fs.readdirSync(this.arDir)
      .filter(f => f.endsWith('.json') && !f.toLowerCase().startsWith('heartbeat'));

    if (files.length === 0) {
      return { lane: this.lane, scanned: 0, executed: 0, errors: [] };
    }

    for (const filename of files) {
      const filePath = path.join(this.arDir, filename);
      const read = safeReadJson(filePath);
      if (!read.ok) {
        this.errors.push({ file: filename, error: read.error });
        continue;
      }

      const msg = read.value;
      delete msg._lane_worker;

      if (this.dryRun) {
        this.details.push({ file: filename, task_id: msg.task_id, subject: (msg.subject || '').slice(0, 60), action: 'WOULD_EXECUTE' });
        continue;
      }

      const inProgressPath = path.join(this.ipDir, filename);
      try { fs.renameSync(filePath, inProgressPath); }
      catch (e) { this.errors.push({ file: filename, error: `Move to in-progress failed: ${e.message}` }); continue; }

      const result = executeTask(msg, this.lane);
      const response = createResponse(msg, result, this.lane);
      const delivery = signAndDeliver(response, this.lane);

      const processedPath = path.join(this.procDir, filename);
      try { fs.renameSync(inProgressPath, processedPath); }
      catch (e) { this.errors.push({ file: filename, error: `Move to processed failed: ${e.message}` }); }

      this.executed++;
      this.details.push({
        file: filename, task_id: msg.task_id, subject: (msg.subject || '').slice(0, 60),
        action: 'EXECUTED', response_id: response.task_id, delivered_to: delivery.path,
      });
    }

    return { lane: this.lane, scanned: files.length, executed: this.executed, errors: this.errors, details: this.details };
  }
}

function parseArgs(argv) {
  const out = { lane: null, apply: false };
  for (const a of argv) {
    if (a === '--apply') out.apply = true;
    else if (a.startsWith('--lane=')) out.lane = a.split('=')[1];
    else if (!a.startsWith('-') && !out.lane && LANE_REGISTRY[a]) out.lane = a;
  }
  return out;
}

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));

  if (!args.lane) {
    console.error('Usage: node generic-task-executor.js <lane> [--apply]');
    console.error('  Lanes: ' + Object.keys(LANE_REGISTRY).join(', '));
    process.exit(1);
  }

  const executor = new GenericTaskExecutor(args.lane, { dryRun: !args.apply });
  const result = executor.run();

  console.log(`[task-executor] lane=${result.lane} dry_run=${!args.apply} scanned=${result.scanned} executed=${result.executed} errors=${result.errors.length}`);
  for (const d of (result.details || [])) {
    console.log(`  ${d.action}: ${d.task_id} "${d.subject}" ${d.delivered_to ? '-> ' + d.delivered_to : ''}`);
  }
  for (const e of result.errors) {
    console.log(`  ERROR: ${e.file}: ${e.error}`);
  }
}

module.exports = { GenericTaskExecutor, executeTask, createResponse, LANE_REGISTRY };
