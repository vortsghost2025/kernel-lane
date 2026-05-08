#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_CHAIN_DEPTH = 5;
const DEFAULT_POLL_SECONDS = 60;
const DEFAULT_MAX_ITERATIONS = 3;

class TaskChainEngine {
  constructor(options) {
    var opts = options || {};
    this.repoRoot = opts.repoRoot || path.resolve(__dirname, '..');
    this.lane = opts.lane || this._guessLane();
    this.dryRun = opts.dryRun !== undefined ? !!opts.dryRun : true;
    this.maxChainDepth = opts.maxChainDepth || MAX_CHAIN_DEPTH;
    this.maxIterations = opts.maxIterations || DEFAULT_MAX_ITERATIONS;
    this.inboxDir = path.join(this.repoRoot, 'lanes', this.lane, 'inbox');
    this.outboxDir = path.join(this.repoRoot, 'lanes', this.lane, 'outbox');
    this.processedDir = path.join(this.inboxDir, 'processed');
    this.actionRequiredDir = path.join(this.inboxDir, 'action-required');
    this.blockedDir = path.join(this.inboxDir, 'blocked');
    this.quarantineDir = path.join(this.inboxDir, 'quarantine');
    this.chainLogPath = path.join(this.repoRoot, 'logs', 'task-chain.log');
    this.chainStatePath = path.join(this.repoRoot, 'lanes', this.lane, 'state', 'task-chain-state.json');
    this.state = this._loadState();
    this._processedThisRun = {};
    this.stats = { iterations: 0, tasks_processed: 0, chains_started: 0, chains_completed: 0, chains_depth_exceeded: 0, followups_generated: 0, errors: 0 };
  }

  _guessLane() {
    var lower = this.repoRoot.toLowerCase();
    if (lower.includes('archivist')) return 'archivist';
    if (lower.includes('kernel-lane')) return 'kernel';
    if (lower.includes('self-organizing') || lower.includes('library')) return 'library';
    if (lower.includes('swarmmind')) return 'swarmmind';
    return 'archivist';
  }

  _loadState() {
    try {
      if (fs.existsSync(this.chainStatePath)) {
        return JSON.parse(fs.readFileSync(this.chainStatePath, 'utf8'));
      }
    } catch (_) {}
    return { active_chains: {}, completed_chains: [], last_run: null };
  }

  _saveState() {
    var dir = path.dirname(this.chainStatePath);
    if (!fs.existsSync(dir)) {
      try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
    }
    this.state.last_run = new Date().toISOString();
    fs.writeFileSync(this.chainStatePath, JSON.stringify(this.state, null, 2), 'utf8');
  }

  _log(msg) {
    var line = '[' + new Date().toISOString() + '] [task-chain] ' + msg;
    var dir = path.dirname(this.chainLogPath);
    if (!fs.existsSync(dir)) {
      try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
    }
    try {
      fs.appendFileSync(this.chainLogPath, line + '\n', 'utf8');
    } catch (_) {}
  }

  _readJson(filePath) {
    try {
      return { ok: true, value: JSON.parse(fs.readFileSync(filePath, 'utf8')) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  _writeJson(filePath, data) {
    var dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
    }
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
  }

  _scanInbox() {
    var tasks = [];
    if (!fs.existsSync(this.inboxDir)) return tasks;

    var entries = fs.readdirSync(this.inboxDir);
    for (var i = 0; i < entries.length; i++) {
      var name = entries[i];
      if (!name.endsWith('.json')) continue;
      if (name.toLowerCase().startsWith('heartbeat')) continue;
      var filePath = path.join(this.inboxDir, name);
      try {
        var stat = fs.statSync(filePath);
        if (!stat.isFile()) continue;
      } catch (_) { continue; }
      var read = this._readJson(filePath);
      if (!read.ok) {
        this.stats.errors++;
        continue;
      }
      var msg = read.value;
      if (!msg.id && !msg.task_id) continue;
      tasks.push({ file: name, path: filePath, msg: msg });
    }
    return tasks;
  }

  _extractChainId(msg) {
    if (msg.chain_id) return msg.chain_id;
    if (msg.parent_task_id) return msg.parent_task_id;
    return msg.task_id || msg.id || crypto.randomUUID();
  }

  _getChainDepth(chainId) {
    var chain = this.state.active_chains[chainId];
    if (!chain) return 0;
    return chain.depth || 0;
  }

  _startChain(msg) {
    var chainId = this._extractChainId(msg);
    var existing = this.state.active_chains[chainId];
    if (existing) {
      existing.depth = (existing.depth || 0) + 1;
      existing.last_task = msg.task_id || msg.id;
      existing.last_updated = new Date().toISOString();
      if (existing.depth > this.maxChainDepth) {
        this._completeChain(chainId, 'depth_exceeded', 'Depth ' + existing.depth + ' exceeds max ' + this.maxChainDepth);
        return null;
      }
      return existing;
    }

    var isFollowup = !!(msg.parent_task_id || msg.chain_id);
    if (isFollowup) {
      this._log('Followup task ' + (msg.task_id || msg.id) + ' has chain_id=' + chainId + ' but no active chain found — completing as orphan');
      return null;
    }

    var chain = {
      chain_id: chainId,
      origin_task: msg.task_id || msg.id,
      origin_priority: msg.priority || 'P2',
      depth: 1,
      followups: [],
      started_at: new Date().toISOString(),
      last_task: msg.task_id || msg.id,
      last_updated: new Date().toISOString()
    };
    this.state.active_chains[chainId] = chain;
    this.stats.chains_started++;
    return chain;
  }

  _completeChain(chainId, status, note) {
    var chain = this.state.active_chains[chainId];
    if (!chain) return;

    chain.completed_at = new Date().toISOString();
    chain.status = status || 'completed';
    chain.completion_note = note || '';

    this.state.completed_chains.push(chain);
    delete this.state.active_chains[chainId];

    if (status === 'depth_exceeded') {
      this.stats.chains_depth_exceeded++;
    } else {
      this.stats.chains_completed++;
    }
  }

  _generateFollowups(msg, chain) {
    var followups = [];
    var chainId = chain.chain_id;
    var depth = chain.depth || 1;

    if (depth >= this.maxChainDepth) {
      this._log('Chain ' + chainId + ' hit max depth ' + this.maxChainDepth + ' — no more followups');
      this._completeChain(chainId, 'depth_exceeded', 'Max chain depth ' + this.maxChainDepth + ' reached');
      return followups;
    }

    var msgType = (msg.type || '').toLowerCase();
    var taskKind = (msg.task_kind || '').toLowerCase();
    var priority = msg.priority || 'P2';
    var nextPriority = priority === 'P0' ? 'P0' : priority === 'P1' ? 'P1' : 'P2';

    if (msgType === 'task' || taskKind === 'amendment' || taskKind === 'review') {
      if (depth < this.maxChainDepth && taskKind !== 'review' && taskKind !== 'ratification') {
        followups.push(this._createVerificationFollowup(msg, chainId, depth, nextPriority));
      }
    }

    if ((msgType === 'review' || taskKind === 'ratification') && depth < this.maxChainDepth) {
      followups.push(this._createConsensusFollowup(msg, chainId, depth));
    }

    if (taskKind === 'status' || taskKind === 'report') {
      followups = [];
    }

    return followups;
  }

  _createVerificationFollowup(parentMsg, chainId, depth, priority) {
    var parentId = parentMsg.task_id || parentMsg.id;
    var followupId = parentId + '-verify-' + depth;
    return {
      schema_version: '1.3',
      task_id: followupId,
      idempotency_key: followupId,
      from: this.lane,
      to: this.lane,
      type: 'task',
      task_kind: 'review',
      priority: priority,
      subject: 'Verify completion of ' + parentId,
      body: 'Auto-generated verification followup for task ' + parentId + ' (chain depth ' + depth + '). Check that the task outcome matches the claimed result.',
      timestamp: new Date().toISOString(),
      requires_action: true,
      parent_task_id: parentId,
      chain_id: chainId,
      payload: { mode: 'inline', compression: 'none' },
      execution: { mode: 'manual', engine: 'local', actor: this.lane + '-agent' },
      lease: { owner: this.lane, acquired_at: new Date().toISOString(), expires_at: new Date(Date.now() + 86400000).toISOString(), renew_count: 0, max_renewals: 3 },
      retry: { attempt: 1, max_attempts: 3 },
      evidence: { required: true, evidence_path: '', verified: false, verified_by: this.lane },
      heartbeat: { interval_seconds: 300, last_heartbeat_at: new Date().toISOString(), status: 'active' },
      signature: 'eyJ1bmludmVyaWZpZWQifQ.eyJmcm9tIjoi' + this.lane + 'IiwidGFza19raW5kIjoicmV2aWV3In0.unsigned',
      signature_alg: 'RS256',
      key_id: 'self'
    };
  }

  _createConsensusFollowup(parentMsg, chainId, depth) {
    var parentId = parentMsg.task_id || parentMsg.id;
    var followupId = parentId + '-consensus-' + depth;
    return {
      schema_version: '1.3',
      task_id: followupId,
      idempotency_key: followupId,
      from: this.lane,
      to: 'archivist',
      type: 'task',
      task_kind: 'ratification',
      priority: 'P1',
      subject: 'Consensus check for ' + parentId,
      body: 'Auto-generated consensus followup for review/ratification task ' + parentId + ' (chain depth ' + depth + '). Other lanes must confirm or contest.',
      timestamp: new Date().toISOString(),
      requires_action: true,
      parent_task_id: parentId,
      chain_id: chainId,
      payload: { mode: 'inline', compression: 'none' },
      execution: { mode: 'manual', engine: 'local', actor: 'archivist-agent' },
      lease: { owner: 'archivist', acquired_at: new Date().toISOString(), expires_at: new Date(Date.now() + 86400000).toISOString(), renew_count: 0, max_renewals: 3 },
      retry: { attempt: 1, max_attempts: 3 },
      evidence: { required: true, evidence_path: '', verified: false, verified_by: 'archivist' },
      heartbeat: { interval_seconds: 300, last_heartbeat_at: new Date().toISOString(), status: 'active' },
      signature: 'eyJ1bmludmVyaWZpZWQifQ.eyJmcm9tIjoiYXJjaGl2aXN0IiwidGFza19raW5kIjoicmF0aWZpY2F0aW9uIn0.unsigned',
      signature_alg: 'RS256',
      key_id: 'self'
    };
  }

  _writeFollowupToInbox(followup) {
    var targetLane = followup.to || this.lane;
    var targetDir;
    if (targetLane === this.lane) {
      targetDir = this.inboxDir;
    } else {
      targetDir = path.join(this.repoRoot, '..', this._laneDir(targetLane), 'lanes', targetLane, 'inbox');
    }

    if (!fs.existsSync(targetDir)) {
      try { fs.mkdirSync(targetDir, { recursive: true }); } catch (_) {}
    }

    var fileName = new Date().toISOString().replace(/[:.]/g, '-') + '_' + this.lane + '_' + followup.task_id + '.json';
    var filePath = path.join(targetDir, fileName);
    this._writeJson(filePath, followup);
    this._log('Followup written: ' + filePath);
    return filePath;
  }

  _laneDir(laneId) {
    var dirs = { archivist: 'Archivist-Agent', kernel: 'kernel-lane', library: 'self-organizing-library', swarmmind: 'SwarmMind' };
    return dirs[laneId] || 'Archivist-Agent';
  }

  _moveToProcessed(task) {
    if (!fs.existsSync(this.processedDir)) {
      try { fs.mkdirSync(this.processedDir, { recursive: true }); } catch (_) {}
    }
    var destPath = path.join(this.processedDir, task.file);
    try {
      fs.renameSync(task.path, destPath);
    } catch (_) {
      try {
        fs.copyFileSync(task.path, destPath);
        fs.unlinkSync(task.path);
      } catch (_2) {}
    }
  }

  _moveToBlocked(task) {
    if (!fs.existsSync(this.blockedDir)) {
      try { fs.mkdirSync(this.blockedDir, { recursive: true }); } catch (_) {}
    }
    var destPath = path.join(this.blockedDir, task.file);
    try {
      fs.renameSync(task.path, destPath);
    } catch (_) {
      try {
        fs.copyFileSync(task.path, destPath);
        fs.unlinkSync(task.path);
      } catch (_2) {}
    }
  }

  processTask(task) {
    var msg = task.msg;
    var chainId = this._extractChainId(msg);

    this._log('Processing task ' + (msg.task_id || msg.id) + ' chain=' + chainId + ' depth=' + this._getChainDepth(chainId));

    var chain = this._startChain(msg);
    if (!chain) {
      this._log('Chain ' + chainId + ' failed to start — moving to blocked');
      this._moveToBlocked(task);
      this.stats.errors++;
      return;
    }

    if (chain.depth > this.maxChainDepth) {
      this._log('Chain ' + chainId + ' exceeded max depth — completing chain, moving task to blocked');
      this._completeChain(chainId, 'depth_exceeded', 'Task arrived when chain already at max depth');
      this._moveToBlocked(task);
      this.stats.chains_depth_exceeded++;
      return;
    }

    var followups = this._generateFollowups(msg, chain);
    chain.followups = (chain.followups || []).concat(followups.map(function(f) { return f.task_id; }));

    if (!this.dryRun) {
      for (var i = 0; i < followups.length; i++) {
        this._writeFollowupToInbox(followups[i]);
        this.stats.followups_generated++;
      }
      this._moveToProcessed(task);
    } else {
      this._log('DRY RUN: Would generate ' + followups.length + ' followups for ' + (msg.task_id || msg.id));
    }

    this.stats.tasks_processed++;
  }

  run() {
    this._log('Starting task-chain-engine run (lane=' + this.lane + ', dry_run=' + this.dryRun + ')');

    for (var iteration = 0; iteration < this.maxIterations; iteration++) {
      this.stats.iterations++;
      var tasks = this._scanInbox();

      if (tasks.length === 0) {
        this._log('No tasks in inbox — iteration ' + iteration + ' idle');
        break;
      }

      this._log('Iteration ' + iteration + ': ' + tasks.length + ' tasks in inbox');

      for (var i = 0; i < tasks.length; i++) {
        if (this._processedThisRun[tasks[i].file]) continue;
        this._processedThisRun[tasks[i].file] = true;
        this.processTask(tasks[i]);
      }
    }

    var activeChainCount = Object.keys(this.state.active_chains).length;

    this._log('Run complete: iterations=' + this.stats.iterations + ' processed=' + this.stats.tasks_processed + ' chains_active=' + activeChainCount + ' chains_completed=' + this.stats.chains_completed + ' followups=' + this.stats.followups_generated);

    if (!this.dryRun) {
      this._saveState();
    }

    return {
      lane: this.lane,
      dry_run: this.dryRun,
      stats: this.stats,
      active_chains: activeChainCount,
      completed_chains: this.state.completed_chains.length
    };
  }
}

function parseArgs(argv) {
  var out = { dryRun: true, lane: null, maxDepth: MAX_CHAIN_DEPTH, maxIterations: DEFAULT_MAX_ITERATIONS };
  for (var i = 0; i < argv.length; i++) {
    var a = argv[i];
    if (a === '--apply') { out.dryRun = false; continue; }
    if (a === '--dry-run') { out.dryRun = true; continue; }
    if (a === '--lane' && argv[i + 1]) { out.lane = String(argv[++i]).toLowerCase(); continue; }
    if (a === '--max-depth' && argv[i + 1]) { out.maxDepth = Math.max(1, Number(argv[++i]) || MAX_CHAIN_DEPTH); continue; }
    if (a === '--max-iterations' && argv[i + 1]) { out.maxIterations = Math.max(1, Number(argv[++i]) || DEFAULT_MAX_ITERATIONS); continue; }
  }
  return out;
}

function runCli() {
  var args = parseArgs(process.argv.slice(2));
  var engine = new TaskChainEngine({
    dryRun: args.dryRun,
    lane: args.lane,
    maxChainDepth: args.maxDepth,
    maxIterations: args.maxIterations
  });

  var report = engine.run();

  console.log('[task-chain-engine] lane=' + report.lane + ' dry_run=' + report.dry_run);
  console.log('[task-chain-engine] iterations=' + report.stats.iterations + ' processed=' + report.stats.tasks_processed + ' chains_active=' + report.active_chains + ' chains_completed=' + report.completed_chains);
  console.log('[task-chain-engine] followups_generated=' + report.stats.followups_generated + ' depth_exceeded=' + report.stats.chains_depth_exceeded + ' errors=' + report.stats.errors);
}

if (require.main === module) {
  runCli();
}

module.exports = { TaskChainEngine, MAX_CHAIN_DEPTH };
