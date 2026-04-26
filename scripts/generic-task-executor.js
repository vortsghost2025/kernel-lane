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
  const blocked = countJson(path.join(root, 'lanes', lane, 'inbox', 'blocked'));
  const ar = countJson(path.join(root, 'lanes', lane, 'inbox', 'action-required'));
  let trustStoreKeyId = null;
  try {
    const ts = JSON.parse(fs.readFileSync(path.join(root, 'lanes/broadcast/trust-store.json'), 'utf8'));
    if (ts[lane]) trustStoreKeyId = ts[lane].key_id;
  } catch (_) {}
  let systemState = null;
  try {
    const ss = JSON.parse(fs.readFileSync(path.join(root, 'lanes/broadcast/system_state.json'), 'utf8'));
    systemState = { status: ss.system_state, contradictions: ss.active_contradictions?.length ?? 0, processed_ok: ss.processed_ok };
  } catch (_) {}
  return {
    task_kind: 'status',
    results: { processed_count: processed, quarantine_count: quarantine, blocked_count: blocked, action_required_count: ar, trust_store_key_id: trustStoreKeyId, system_state: systemState },
    summary: `${lane}: processed=${processed} quarantine=${quarantine} blocked=${blocked} ar=${ar} key_id=${trustStoreKeyId} state=${systemState?.status || 'unknown'} ok=${systemState?.processed_ok}`,
  };
}

function executeFileReadTask(msg, lane) {
  const root = LANE_REGISTRY[lane].root;
  const body = (msg.body || '');
  const targetPath = body.match(/read\s+file\s+["']?([^"'\s]+)["']?/i)?.[1]
    || body.match(/read\s+["']?([^"'\s]+)["']?/i)?.[1]
    || body.match(/file[:=]\s*["']?([^"'\s]+)["']?/i)?.[1];
  if (!targetPath) {
    return { task_kind: 'report', results: { error: 'No file path specified. Use: "read file <path>" or "file: <path>"' }, summary: 'Error: no file path in task body' };
  }
  const resolved = targetPath.startsWith('/') || targetPath.match(/^[A-Za-z]:/) ? targetPath : path.join(root, targetPath);
  const normalized = resolved.replace(/\\/g, '/');
  const allowedRoots = Object.values(LANE_REGISTRY).map(r => r.root.replace(/\\/g, '/'));
  if (!allowedRoots.some(ar => normalized.startsWith(ar)) && !normalized.match(/^[A-Za-z]:\//)) {
    return { task_kind: 'report', results: { error: `Path outside allowed roots: ${resolved}` }, summary: `Error: path outside allowed roots` };
  }
  try {
    const stat = fs.statSync(resolved);
    if (stat.isDirectory()) {
      const entries = fs.readdirSync(resolved).slice(0, 100);
      return { task_kind: 'report', results: { type: 'directory', path: resolved, entries, count: entries.length }, summary: `Directory ${resolved}: ${entries.length} entries` };
    }
    if (stat.size > 50000) {
      const content = fs.readFileSync(resolved, 'utf8').slice(0, 50000);
      return { task_kind: 'report', results: { type: 'file', path: resolved, size: stat.size, content: content + '\n... TRUNCATED (50KB limit)' }, summary: `File ${resolved}: ${stat.size} bytes (truncated to 50KB)` };
    }
    const content = fs.readFileSync(resolved, 'utf8');
    return { task_kind: 'report', results: { type: 'file', path: resolved, size: stat.size, content }, summary: `File ${resolved}: ${stat.size} bytes` };
  } catch (e) {
    return { task_kind: 'report', results: { error: `Cannot read ${resolved}: ${e.message}` }, summary: `Error reading ${resolved}` };
  }
}

function executeScriptTask(msg, lane) {
  const root = LANE_REGISTRY[lane].root;
  const body = (msg.body || '');
  const scriptMatch = body.match(/run\s+script\s+["']?([^"'\s]+)["']?/i) || body.match(/script[:=]\s*["']?([^"'\s]+)["']?/i);
  if (!scriptMatch) {
    return { task_kind: 'report', results: { error: 'No script specified. Use: "run script <name>"' }, summary: 'Error: no script in task body' };
  }
  const scriptName = scriptMatch[1];
  const scriptPath = path.join(root, 'scripts', scriptName.endsWith('.js') ? scriptName : scriptName + '.js');
  if (!fs.existsSync(scriptPath)) {
    return { task_kind: 'report', results: { error: `Script not found: ${scriptPath}` }, summary: `Error: script ${scriptName} not found` };
  }
  try {
    const { execSync } = require('child_process');
    const output = execSync(`node "${scriptPath}"`, { cwd: root, timeout: 30000, encoding: 'utf8', maxBuffer: 50000 });
    return { task_kind: 'report', results: { script: scriptName, exit_code: 0, output: output.slice(0, 50000) }, summary: `Script ${scriptName}: success (${output.length} chars output)` };
  } catch (e) {
    return { task_kind: 'report', results: { script: scriptName, exit_code: e.status || 1, output: (e.stdout || '').slice(0, 25000), error: (e.stderr || '').slice(0, 5000) || e.message.slice(0, 5000) }, summary: `Script ${scriptName}: exit ${e.status || 1}` };
  }
}

function executeConsistencyCheck(msg, lane) {
  const root = LANE_REGISTRY[lane].root;
  try {
    const scriptPath = path.join(root, 'scripts', 'cross-lane-consistency-check.js');
    if (!fs.existsSync(scriptPath)) {
      return { task_kind: 'report', results: { error: 'cross-lane-consistency-check.js not found' }, summary: 'Error: consistency check script not found' };
    }
    const { execSync } = require('child_process');
    const output = execSync(`node "${scriptPath}"`, { cwd: root, timeout: 60000, encoding: 'utf8', maxBuffer: 100000 });
    return { task_kind: 'report', results: { check_type: 'cross-lane-consistency', output: output.slice(0, 100000) }, summary: `Consistency check: ${output.includes('Consistent: YES') ? 'PASS' : 'ISSUES FOUND'}` };
  } catch (e) {
    return { task_kind: 'report', results: { error: e.message.slice(0, 5000) }, summary: 'Error running consistency check' };
  }
}

function executeTask(msg, lane) {
  const kind = (msg.task_kind || '').toLowerCase();
  const body = (msg.body || '').toLowerCase();

  if (kind === 'status' || body.includes('report status') || body.includes('processed count')) {
    return executeStatusTask(msg, lane);
  }
  if (body.includes('read file') || body.includes('read ') || body.includes('file:') || body.includes('file=')) {
    return executeFileReadTask(msg, lane);
  }
  if (body.includes('run script') || body.includes('script:') || body.includes('script=')) {
    return executeScriptTask(msg, lane);
  }
  if (body.includes('consistency check') || body.includes('audit') || kind === 'review') {
    return executeConsistencyCheck(msg, lane);
  }

  return {
    task_kind: kind || 'ack',
    results: { acknowledged: true, note: 'Task type not recognized. Supported: status, "read file <path>", "run script <name>", "consistency check"' },
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
