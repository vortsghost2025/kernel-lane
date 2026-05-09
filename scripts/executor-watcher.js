#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { LaneDiscovery } = require('./util/lane-discovery');

const POLL_INTERVAL_MS = 20000;
const DEFAULT_LANE = 'archivist';

var _priorAttempts = [];

function ensureDir(d) {
  try { fs.mkdirSync(d, { recursive: true }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
}

function nowIso() { return new Date().toISOString(); }

function runStoreJournalPreflight(laneRoot, lane, filePaths) {
  var scriptPath = path.join(laneRoot, 'scripts', 'store-journal.js');
  if (!fs.existsSync(scriptPath)) return { ok: true, skipped: true };
  try {
    var { execSync } = require('child_process');
    var pathsArg = filePaths.join(',');
    var result = execSync('node "' + scriptPath + '" preflight --lane ' + lane + ' --paths ' + pathsArg, {
      cwd: laneRoot,
      timeout: 10000,
      encoding: 'utf8'
    });
    var parsed = JSON.parse(result);
    if (parsed.verdict === 'CLEAR') return { ok: true, verdict: 'CLEAR' };
    return { ok: false, verdict: parsed.verdict, details: parsed.details || [] };
  } catch (e) {
    return { ok: true, skipped: true, error: e.message };
  }
}

function appendStoreJournal(laneRoot, lane, event, msg) {
  var scriptPath = path.join(laneRoot, 'scripts', 'store-journal.js');
  if (!fs.existsSync(scriptPath)) return;
  try {
    var { execSync } = require('child_process');
    var agent = process.env.AGENT_INSTANCE_ID || 'executor-watcher';
    var cmd = 'node "' + scriptPath + '" append --lane ' + lane +
      ' --event ' + event +
      ' --agent "' + agent + '"' +
      ' --subject "' + ((msg.subject || msg.task_id || 'unknown').replace(/"/g, '')).slice(0, 80) + '"' +
      ' --task_id "' + ((msg.task_id || 'unknown').replace(/"/g, '')).slice(0, 60) + '"';
    execSync(cmd, { cwd: laneRoot, timeout: 10000 });
  } catch (e) {}
}

function scanActionRequired(laneRoot, lane) {
  var arDir = path.join(laneRoot, 'lanes', lane, 'inbox', 'action-required');
  if (!fs.existsSync(arDir)) return [];
  return fs.readdirSync(arDir)
    .filter(function(f) { return f.endsWith('.json') && !f.toLowerCase().startsWith('heartbeat'); })
    .map(function(name) { return path.join(arDir, name); });
}

function executeTaskWithJournal(laneRoot, lane, msgFile) {
  var content;
  try {
    content = fs.readFileSync(msgFile, 'utf8');
  } catch (e) {
    return { ok: false, error: 'Cannot read: ' + e.message };
  }

  var msg;
  try {
    msg = JSON.parse(content);
  } catch (e) {
    return { ok: false, error: 'Invalid JSON: ' + e.message };
  }

  var preflight = runStoreJournalPreflight(laneRoot, lane, [msgFile]);
  if (!preflight.ok) {
    return { ok: false, error: 'Store-journal preflight BLOCK: ' + JSON.stringify(preflight.details), blocked: true };
  }

  appendStoreJournal(laneRoot, lane, 'work_started', msg);

  var executorPath = path.join(laneRoot, 'scripts', 'generic-task-executor.js');
  if (!fs.existsSync(executorPath)) {
    appendStoreJournal(laneRoot, lane, 'work_failed', msg);
    return { ok: false, error: 'generic-task-executor.js not found' };
  }

  try {
    var { GenericTaskExecutor } = require(executorPath);
    var executor = new GenericTaskExecutor(lane, { dryRun: false });
    var result = executor.run();
    appendStoreJournal(laneRoot, lane, 'work_completed', msg);
    return { ok: true, result: result };
  } catch (e) {
    appendStoreJournal(laneRoot, lane, 'work_failed', msg);

    // v1.4: Build uncertainty packet for failed execution
    var uncertaintyPacket = {
      level: 'high',
      type: ['execution_failure'],
      why: 'Task execution failed: ' + e.message,
      evidence_needed: ['executor_error_log', 'task_input_json'],
      operator_decision_needed: false,
      next_safe_check: new Date(Date.now() + 3600000).toISOString(),
      detected_at: nowIso(),
      detected_by: 'executor-watcher'
    };

    // v1.4: Record as prior attempt
    var priorAttempt = {
      attempt_id: 'exec-' + Date.now(),
      actor: 'executor-watcher',
      action: 'execute_task',
      result: 'failed',
      failed_because: e.message,
      do_not_repeat: 'Retry without fixing the underlying error: ' + e.message.slice(0, 100),
      useful_evidence: [(msg.task_id || 'unknown')],
      timestamp: nowIso()
    };
    _priorAttempts.push(priorAttempt);

    // Try to append uncertainty to store-journal
    try {
      var { execSync } = require('child_process');
      var tmpPath = path.join(laneRoot, '.tmp-uncertainty-' + Date.now() + '.json');
      fs.writeFileSync(tmpPath, JSON.stringify(uncertaintyPacket), 'utf8');
      execSync('node "' + path.join(laneRoot, 'scripts', 'store-journal.js') + '" append --lane ' + lane +
        ' --event uncertainty_detected --agent executor-watcher' +
        ' --uncertainty "' + tmpPath.replace(/"/g, '') + '"', { cwd: laneRoot, timeout: 10000 });
      try { fs.unlinkSync(tmpPath); } catch (_) {}
    } catch (_) {}

    return { ok: false, error: 'Executor error: ' + e.message, uncertainty: uncertaintyPacket, prior_attempt: priorAttempt };
  }
}

function processLane(lane, discovery) {
  var laneRoot = discovery.getLocalPath(lane);
  if (!laneRoot || !fs.existsSync(laneRoot)) {
    return { lane: lane, scanned: 0, executed: 0, errors: [] };
  }

  var arFiles = scanActionRequired(laneRoot, lane);
  if (arFiles.length === 0) {
    return { lane: lane, scanned: 0, executed: 0, errors: [] };
  }

  var executed = 0;
  var errors = [];

  for (var i = 0; i < arFiles.length; i++) {
    var result = executeTaskWithJournal(laneRoot, lane, arFiles[i]);
    if (result.ok) {
      executed++;
    } else {
      var errEntry = { file: path.basename(arFiles[i]), error: result.error };
      if (result.uncertainty) errEntry.uncertainty = result.uncertainty;
      if (result.prior_attempt) errEntry.prior_attempt = result.prior_attempt;
      errors.push(errEntry);
      if (result.blocked) {
        var blockedDir = path.join(laneRoot, 'lanes', lane, 'inbox', 'blocked');
        ensureDir(blockedDir);
        var destPath = path.join(blockedDir, path.basename(arFiles[i]));
        try {
          fs.renameSync(arFiles[i], destPath);
        } catch (e) {}
      }
    }
  }

  return { lane: lane, scanned: arFiles.length, executed: executed, errors: errors };
}

function runOnce(discovery, lanes) {
  var results = [];
  for (var i = 0; i < lanes.length; i++) {
    var result = processLane(lanes[i], discovery);
    results.push(result);
  }
  return results;
}

function watchLoop(discovery, lanes) {
  function tick() {
    var results = runOnce(discovery, lanes);
    var totalExecuted = 0;
    var totalErrors = 0;
    for (var i = 0; i < results.length; i++) {
      totalExecuted += results[i].executed;
      totalErrors += results[i].errors.length;
      if (results[i].scanned > 0 || results[i].executed > 0 || results[i].errors.length > 0) {
        console.log(nowIso() + ' [executor-watcher] lane=' + results[i].lane +
          ' scanned=' + results[i].scanned +
          ' executed=' + results[i].executed +
          ' errors=' + results[i].errors.length);
        for (var j = 0; j < results[i].errors.length; j++) {
          var err = results[i].errors[j];
          console.log(' ERROR: ' + err.file + ': ' + err.error);
          if (err.uncertainty) {
            console.log(' UNCERTAINTY: level=' + err.uncertainty.level + ' why=' + (err.uncertainty.why || '').slice(0, 80));
          }
        }
      }
      }
    }
    if (totalExecuted > 0 || totalErrors > 0) {
      console.log(nowIso() + ' [executor-watcher] total: executed=' + totalExecuted + ' errors=' + totalErrors);
    }
  }

  tick();
  setInterval(tick, POLL_INTERVAL_MS);
}

function main() {
  var discovery = new LaneDiscovery();
  var lanes = ['archivist', 'kernel', 'library', 'swarmmind'];
  var watch = process.argv.includes('--watch');
  var apply = process.argv.includes('--apply');
  var laneArg = '';

  for (var i = 2; i < process.argv.length; i++) {
    if (process.argv[i].startsWith('--lane=')) {
      laneArg = process.argv[i].split('=')[1];
    }
  }

  if (laneArg) {
    lanes = [laneArg];
  }

  if (!apply && !watch) {
    console.log('[executor-watcher] DRY RUN — use --apply to execute tasks');
  }

  if (watch) {
    console.log(nowIso() + ' [executor-watcher] Starting watch loop (interval=' + POLL_INTERVAL_MS + 'ms, lanes=' + lanes.join(',') + ', apply=' + apply + ')');
    if (!apply) {
      console.log('[executor-watcher] WARNING: running in watch mode without --apply — tasks will NOT be executed');
    }
    watchLoop(discovery, lanes);
  } else {
    if (apply) {
      var results = runOnce(discovery, lanes);
      console.log(JSON.stringify(results, null, 2));
    } else {
      for (var i = 0; i < lanes.length; i++) {
        var lane = lanes[i];
        var laneRoot = discovery.getLocalPath(lane);
        if (laneRoot && fs.existsSync(laneRoot)) {
          var arFiles = scanActionRequired(laneRoot, lane);
          console.log('[executor-watcher] lane=' + lane + ' action_required=' + arFiles.length + ' (dry run)');
          for (var j = 0; j < arFiles.length; j++) {
            var content = fs.readFileSync(arFiles[j], 'utf8');
            var msg = JSON.parse(content);
            console.log('  WOULD_EXECUTE: ' + (msg.task_id || 'unknown') + ' "' + ((msg.subject || '')).slice(0, 60) + '"');
          }
        }
      }
    }
  }
}

main();
