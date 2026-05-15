#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execSync } = require('child_process');
const { syncAndGuard } = require('./sync-canonical-scripts');
const { LaneDiscovery } = require('./util/lane-discovery');

const AUDIT_VERSION = '4.0.0';
const LEDGER_PATH = process.env.AUTONOMY_LEDGER || path.join(__dirname, '..', 'context-buffer', 'autonomy-ledger.jsonl');
const ROLLUP_PATH = process.env.AUTONOMY_ROLLUP || path.join(__dirname, '..', 'context-buffer', 'headless-autonomy-rollup.json');
const CANONICAL_REGISTRY = path.join(__dirname, 'CANONICAL_SCRIPT_REGISTRY.json');
const RECOMMENDATION_TYPES = [
  'NO_ACTION', 'REVIEW_DRIFT', 'SPAWN_AGENT_RECOMMENDED',
  'OPERATOR_PING_SEEN', 'P0_STALE_TASK', 'TOPOLOGY_ANOMALY',
  'DEPENDENCY_SYNC_REQUIRED', 'CONVERGENCE_REVIEW_DUE', 'CRASH_LOOP_DETECTED'
];
const REC_LIFECYCLE_STATES = ['NEW', 'ONGOING_MONITORED', 'ESCALATED', 'RESOLVED', 'SUPPRESSED'];
const REC_DISPOSITIONS = ['ACCEPT', 'REJECT', 'DEFER', 'QUARANTINE', null];
const REC_LEDGER_PATH = process.env.REC_LEDGER || path.join(__dirname, '..', 'context-buffer', 'recommendation-ledger.jsonl');
const DEDUPE_SUPPRESS_CYCLES = 6;

const SERVICED_LANES = ['archivist', 'kernel', 'swarmmind', 'library'];
const VIRTUAL_LANES = ['authority'];

const EXPECTED_SERVICES = {
  per_lane: ['lane-worker', 'relay-daemon', 'heartbeat', 'executor'],
  system: ['continuous-improvement', 'headless-supervision'],
  deprecated: ['worker', 'relay', 'watcher', 'agent-runner']
};

const REQUIRED_EXECUTOR_FILES = [
  'scripts/node-version-guard.js',
  'scripts/util/lane-discovery.js',
  'scripts/util/atomic-write.js',
  'scripts/util/sanitize-filename.js',
  'scripts/autonomous-executor.js',
  'scripts/blocked-remediator.js',
  'scripts/store-journal.js',
  'scripts/output-provenance.js'
];

const AGENT_ACTIVATION_TRIGGERS = [
  { trigger: 'blocker', description: 'Active blocker requires governance review', priority: 'P0' },
  { trigger: 'canonical_drift', description: 'Canonical drift detected, convergence review needed', priority: 'P1' },
  { trigger: 'service_topology_violation', description: 'Service topology invariant violated', priority: 'P1' },
  { trigger: 'crash_loop', description: 'Service in crash loop, intervention needed', priority: 'P0' },
  { trigger: 'stale_task', description: 'Inbox task older than 1 hour unprocessed', priority: 'P2' },
  { trigger: 'operator_handoff', description: 'Operator session ping received, agent cognition requested', priority: 'P1' },
  { trigger: 'quarantine_event', description: 'Message quarantined, review needed', priority: 'P2' },
  { trigger: 'convergence_review', description: 'Cross-lane convergence sync needed', priority: 'P1' }
];

function getRoots() {
  try {
    const ld = new LaneDiscovery();
    const map = {};
    for (const name of ld.listLanes()) { map[name] = ld.getLocalPath(name); }
    return map;
  } catch (_) {
    const base = path.resolve(__dirname, '..');
    return {
      archivist: base,
      kernel: path.join(base, '..', 'kernel-lane'),
      swarmmind: path.join(base, '..', 'SwarmMind'),
      library: path.join(base, '..', 'self-organizing-library'),
      authority: base
    };
  }
}

const LANE_ROOTS = getRoots();
const ALL_LANES = Object.keys(LANE_ROOTS);

function nowIso() { return new Date().toISOString(); }

function sha256File(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function runCmd(cmd, opts) {
  try { return execSync(cmd, { encoding: 'utf8', timeout: 10000, ...opts }).trim(); }
  catch (_) { return ''; }
}

// === 1. CANONICAL DRIFT SENTINEL ===
function checkCanonicalDrift() {
  const results = {
    status: 'NO_DRIFT',
    files_checked: 0,
    aligned: 0,
    drift_details: [],
    regression_failures: [],
    missing_canonical: [],
    governance_packet: null
  };

  if (!fs.existsSync(CANONICAL_REGISTRY)) {
    results.status = 'ERROR';
    results.missing_canonical.push('CANONICAL_SCRIPT_REGISTRY.json');
    results.governance_packet = { severity: 'FATAL', action: 'ABORT', reason: 'Registry missing' };
    return results;
  }

  const registry = JSON.parse(fs.readFileSync(CANONICAL_REGISTRY, 'utf8'));
  const sharedScripts = registry.shared_scripts || [];
  const sharedSchemas = registry.shared_schemas || [];
  const sharedUtilModules = registry.shared_util_modules || [];
  const targets = ['kernel', 'swarmmind', 'library'];
  const canonical = LANE_ROOTS.archivist;

  const allFiles = sharedScripts.map(s => ({ name: s, dir: 'scripts' }))
    .concat(sharedSchemas.map(s => ({ name: s, dir: '' })))
    .concat(sharedUtilModules.map(s => ({ name: path.basename(s), dir: path.dirname(s) })));

  results.files_checked = allFiles.length * targets.length;

  for (const file of allFiles) {
    const canonPath = file.dir ? path.join(canonical, file.dir, file.name) : path.join(canonical, file.name);
    if (!fs.existsSync(canonPath)) {
      results.missing_canonical.push(file.name);
      continue;
    }
    const canonSha = sha256File(canonPath);

    for (const lane of targets) {
      const targetPath = file.dir ? path.join(LANE_ROOTS[lane], file.dir, file.name) : path.join(LANE_ROOTS[lane], file.name);
      const targetSha = sha256File(targetPath);

      if (!targetSha) {
        results.drift_details.push({ file: file.name, lane, type: 'MISSING_TARGET' });
        continue;
      }

      if (targetSha === canonSha) {
        results.aligned++;
      } else {
        const targetMod = fs.statSync(targetPath).mtime.toISOString();
        const canonMod = fs.statSync(canonPath).mtime.toISOString();
        const type = canonMod > targetMod ? 'EXPECTED_DRIFT_CANONICAL_CHANGED' : 'UNEXPECTED_TARGET_DRIFT';
        results.drift_details.push({ file: file.name, lane, type, target_mtime: targetMod, canon_mtime: canonMod });
      }
    }
  }

  if (results.drift_details.length > 0) {
    const hasUnexpected = results.drift_details.some(d => d.type === 'UNEXPECTED_TARGET_DRIFT');
    const hasMissing = results.drift_details.some(d => d.type === 'MISSING_TARGET');
    const hasExpectedOnly = results.drift_details.every(d => d.type === 'EXPECTED_DRIFT_CANONICAL_CHANGED');
    results.status = hasUnexpected || hasMissing ? 'SYNC_REQUIRED' : hasExpectedOnly ? 'EXPECTED_DRIFT_CANONICAL_CHANGED' : 'SYNC_REQUIRED';
  }

  try {
    const dryRunResult = syncAndGuard(true);
    results.regression_failures = dryRunResult.regression_failures || [];
  } catch (err) {
    results.regression_failures.push({ error: err.message });
  }

  if (results.regression_failures.length > 0) {
    results.governance_packet = { severity: 'CRITICAL', action: 'BLOCK_SYNC', reason: 'Regression guard triggered' };
  } else if (results.status === 'SYNC_REQUIRED') {
    results.governance_packet = { severity: 'WARNING', action: 'NEEDS_APPROVAL', reason: 'Sync required, auto-apply not yet approved' };
  } else if (results.status === 'EXPECTED_DRIFT_CANONICAL_CHANGED') {
    results.governance_packet = { severity: 'INFO', action: 'NO_ACTION', reason: 'Canonical changed since last sync, expected drift' };
  } else {
    results.governance_packet = { severity: 'OK', action: 'NONE', reason: 'All targets aligned with canonical' };
  }

  return results;
}

// === 2. SERVICE TOPOLOGY INVARIANT GUARD ===
function checkServiceTopology() {
  const perLaneCount = SERVICED_LANES.length * EXPECTED_SERVICES.per_lane.length;
  const systemCount = EXPECTED_SERVICES.system.length;
  const expectedTotal = perLaneCount + systemCount;

  const results = {
    expected_total: expectedTotal,
    serviced_lanes: SERVICED_LANES,
    virtual_lanes: VIRTUAL_LANES,
    active: 0,
    missing: [],
    duplicates: [],
    crash_loops: [],
    orphan_processes: 0,
    per_lane_status: {}
  };

  const xdg = process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid()}`;
  const dbus = `unix:path=${xdg}/bus`;
  const env = { ...process.env, XDG_RUNTIME_DIR: xdg, DBUS_SESSION_BUS_ADDRESS: dbus };

  for (const lane of SERVICED_LANES) {
    results.per_lane_status[lane] = { services: {} };
    for (const svc of EXPECTED_SERVICES.per_lane) {
      const unit = `${lane}-${svc}.service`;
      const subState = runCmd(`systemctl --user show ${unit} -p ActiveState --value 2>/dev/null`, { env });
      const resultState = runCmd(`systemctl --user show ${unit} -p Result --value 2>/dev/null`, { env });

      results.per_lane_status[lane].services[svc] = subState || 'unknown';

      if (subState === 'active') {
        results.active++;
      } else if (resultState === 'exit-code') {
        results.crash_loops.push({ service: unit, state: 'crash-loop', nrestarts: runCmd(`systemctl --user show ${unit} -p NRestarts --value 2>/dev/null`, { env }) || '?' });
      } else {
        results.missing.push({ service: unit, state: subState || 'inactive' });
      }
    }
  }

  for (const svc of EXPECTED_SERVICES.system) {
    const unit = `${svc}.service`;
    const state = runCmd(`systemctl --user show ${unit} -p ActiveState --value 2>/dev/null`, { env });
    if (state === 'active') {
      results.active++;
    } else {
      results.missing.push({ service: unit, state: state || 'inactive' });
    }
  }

  for (const lane of ALL_LANES) {
    for (const dep of EXPECTED_SERVICES.deprecated) {
      const depUnit = `${lane}-${dep}.service`;
      const depState = runCmd(`systemctl --user is-active ${depUnit} 2>/dev/null`, { env });
      if (depState === 'active') {
        results.duplicates.push({ service: depUnit, note: 'deprecated duplicate' });
      }
    }
  }

  for (const dep of EXPECTED_SERVICES.deprecated) {
    const depUnit = `${dep}.service`;
    const depState = runCmd(`systemctl --user is-active ${depUnit} 2>/dev/null`, { env });
    if (depState === 'active') {
      results.duplicates.push({ service: depUnit, note: 'deprecated system service' });
    }
  }

  const nodePids = runCmd('pgrep -u we4free node 2>/dev/null || true', { env });
  const nodeCount = nodePids ? nodePids.split('\n').filter(Boolean).length : 0;
  results.orphan_processes = Math.max(0, nodeCount - results.active);

  results.invariant_ok = results.active === results.expected_total &&
    results.missing.length === 0 &&
    results.duplicates.length === 0 &&
    results.crash_loops.length === 0;

  return results;
}

// === 3. HEADLESS AUTONOMY LEDGER ===
// Implemented in appendLedgerEntry()

// === 4. CONDITIONAL AGENT-ACTIVATION POLICY ===
function checkAgentActivationNeeded(auditResults) {
  const recommendations = [];

  if (auditResults.canonical_drift.status === 'SYNC_REQUIRED') {
    const driftFiles = auditResults.canonical_drift.drift_details
      .filter(d => d.type === 'UNEXPECTED_TARGET_DRIFT' || d.type === 'MISSING_TARGET')
      .map(d => d.file + '->' + d.lane);
    recommendations.push({ trigger: 'canonical_drift', priority: 'P1',
      description: 'Canonical drift: ' + (driftFiles.length > 0 ? driftFiles.join(', ') : 'sync required'),
      action: 'Review and run sync-canonical-scripts.js' });
  }

  if (auditResults.canonical_drift.status === 'EXPECTED_DRIFT_CANONICAL_CHANGED') {
    recommendations.push({ trigger: 'convergence_review', priority: 'P1',
      description: 'Canonical scripts changed, targets need sync',
      action: 'Run sync-canonical-scripts.js to propagate canonical changes' });
  }

  for (const cl of auditResults.service_topology.crash_loops) {
    recommendations.push({ trigger: 'crash_loop', priority: 'P0',
      description: `Service ${cl.service} in crash loop`, action: 'Diagnose and fix crash cause' });
  }

  for (const dup of auditResults.service_topology.duplicates) {
    recommendations.push({ trigger: 'service_topology_violation', priority: 'P1',
      description: `Deprecated service ${dup.service} is active`, action: 'Stop and disable duplicate' });
  }

  if (auditResults.service_topology.missing.length > 0) {
    recommendations.push({ trigger: 'service_topology_violation', priority: 'P1',
      description: `Missing services: ${auditResults.service_topology.missing.map(m => m.service).join(', ')}`,
      action: 'Restart missing services' });
  }

  for (const lane of ALL_LANES) {
    const inboxDir = path.join(LANE_ROOTS[lane], 'lanes', lane, 'inbox');
    if (!fs.existsSync(inboxDir)) continue;
    const now = Date.now();
    for (const f of fs.readdirSync(inboxDir).filter(n => n.endsWith('.json') && !n.startsWith('heartbeat-'))) {
      const fp = path.join(inboxDir, f);
      try {
        const stat = fs.statSync(fp);
        const ageMs = now - stat.mtimeMs;
        if (ageMs > 3600000) {
          const msg = JSON.parse(fs.readFileSync(fp, 'utf8'));
          if (msg.requires_action && msg.priority === 'P0') {
            recommendations.push({ trigger: 'stale_task', priority: 'P0',
              description: `${lane} inbox: ${f} is ${Math.round(ageMs/3600000)}h old, P0 requires_action`,
              action: 'Process or escalate P0 stale task immediately' });
          }
        }
      } catch (_) { /* skip unreadable */ }
    }
  }

  // Check for ACTIVE blocker only (not inactive)
  for (const lane of ALL_LANES) {
    const blockerPath = path.join(LANE_ROOTS[lane], 'lanes', 'broadcast', 'active-blocker.json');
    if (fs.existsSync(blockerPath)) {
      try {
        const blocker = JSON.parse(fs.readFileSync(blockerPath, 'utf8'));
        if (blocker.active === true) {
          recommendations.push({ trigger: 'blocker', priority: 'P0',
            description: `Active blocker in ${lane}/broadcast: ${blocker.reason || 'unspecified'}`,
            action: 'Review blocker and resolve or delegate' });
        }
      } catch (_) { /* skip malformed */ }
    }
    break;
  }

  for (const lane of ALL_LANES) {
    const inboxDir = path.join(LANE_ROOTS[lane], 'lanes', lane, 'inbox');
    if (!fs.existsSync(inboxDir)) continue;
    for (const f of fs.readdirSync(inboxDir).filter(n => n.includes('operator-ping'))) {
      recommendations.push({ trigger: 'operator_handoff', priority: 'P1',
        description: 'Operator session ping detected', action: 'Prioritize interactive responses' });
      break;
    }
    if (recommendations.some(r => r.trigger === 'operator_handoff')) break;
  }

  return recommendations;
}

// === 5. BROADCAST DELIVERY PROOF TEST ===
function testBroadcastDelivery() {
  const results = { passed: false, details: [], delivered_count: 0, expected_count: 0 };

  const testMsg = {
    schema_version: '1.3',
    task_id: 'broadcast-proof-' + Date.now(),
    from: 'archivist',
    to: 'all',
    type: 'test',
    priority: 'P3',
    subject: 'Broadcast delivery proof test',
    body: 'Automated to=all broadcast fan-out verification. Safe to ignore.',
    timestamp: nowIso(),
    requires_action: false,
    _audit_test: true
  };

  const outboxDir = path.join(LANE_ROOTS.archivist, 'lanes', 'archivist', 'outbox');
  const testFileName = `audit-broadcast-proof-${Date.now()}.json`;
  const testFile = path.join(outboxDir, testFileName);

  try {
    if (!fs.existsSync(outboxDir)) fs.mkdirSync(outboxDir, { recursive: true });
    fs.writeFileSync(testFile, JSON.stringify(testMsg, null, 2), 'utf8');

    const relayScript = path.join(LANE_ROOTS.archivist, 'scripts', 'relay-daemon.js');
    if (!fs.existsSync(relayScript)) {
      results.details.push({ error: 'relay-daemon.js not found' });
      if (fs.existsSync(testFile)) try { fs.unlinkSync(testFile); } catch (_) {}
      return results;
    }

    runCmd(`node ${relayScript} --lane archivist --apply --once 2>&1`, { cwd: LANE_ROOTS.archivist, timeout: 30000 });

    const targetLanes = SERVICED_LANES.filter(l => l !== 'archivist');
    results.expected_count = targetLanes.length;
    let delivered = 0;

    for (const lane of targetLanes) {
      const inboxDir = path.join(LANE_ROOTS[lane], 'lanes', lane, 'inbox');
      const targetPath = path.join(inboxDir, testFileName);
      const wasDelivered = fs.existsSync(targetPath);
      results.details.push({ lane, delivered: wasDelivered });
      if (wasDelivered) {
        delivered++;
        try { fs.unlinkSync(targetPath); } catch (_) {}
      }
    }

    const deliveredDir = path.join(outboxDir, 'delivered');
    const deliveredPath = path.join(deliveredDir, testFileName);
    if (fs.existsSync(deliveredPath)) {
      results.archived_to_delivered = true;
      try { fs.unlinkSync(deliveredPath); } catch (_) {}
    }

    if (fs.existsSync(testFile)) {
      try { fs.unlinkSync(testFile); } catch (_) {}
    }

    results.delivered_count = delivered;
    results.passed = delivered === targetLanes.length;
  } catch (err) {
    results.details.push({ error: err.message });
    if (fs.existsSync(testFile)) try { fs.unlinkSync(testFile); } catch (_) {}
  }

  return results;
}

// === 6. RUNTIME DEPENDENCY VALIDATION ===
function checkExecutorDependencies() {
  const results = { ok: true, missing: [], present: [] };

  for (const lane of SERVICED_LANES) {
    const root = LANE_ROOTS[lane];
    for (const relPath of REQUIRED_EXECUTOR_FILES) {
      const fullPath = path.join(root, relPath);
      if (!fs.existsSync(fullPath)) {
        results.missing.push({ lane, file: relPath });
        results.ok = false;
      } else {
        results.present.push({ lane, file: relPath, sha256: sha256File(fullPath) });
      }
    }
  }

  return results;
}

// === LANE HEALTH SNAPSHOT ===
function getLaneHealth() {
  const health = {};
  for (const lane of ALL_LANES) {
    const root = LANE_ROOTS[lane];
    const inboxDir = path.join(root, 'lanes', lane, 'inbox');
    const outboxDir = path.join(root, 'lanes', lane, 'outbox');
    const heartbeatPath = path.join(root, 'lanes', lane, 'inbox', `heartbeat-${lane}.json`);

    let inboxCount = 0, outboxCount = 0, heartbeatAgeMs = null;
    if (fs.existsSync(inboxDir)) {
      inboxCount = fs.readdirSync(inboxDir).filter(f => f.endsWith('.json') && !f.startsWith('heartbeat-')).length;
    }
    if (fs.existsSync(outboxDir)) {
      outboxCount = fs.readdirSync(outboxDir).filter(f => f.endsWith('.json')).length;
    }
    if (fs.existsSync(heartbeatPath)) {
      heartbeatAgeMs = Date.now() - fs.statSync(heartbeatPath).mtimeMs;
    }

    const gitClean = runCmd(`git -C ${root} diff-index --quiet HEAD 2>/dev/null && echo clean || echo dirty`) === 'clean';

    const isVirtual = VIRTUAL_LANES.includes(lane);
    health[lane] = {
      inbox: inboxCount,
      outbox: outboxCount,
      heartbeat_age_ms: heartbeatAgeMs,
      git_clean: gitClean,
      is_virtual: isVirtual,
      services_ok: isVirtual ? null : (results_per_lane => results_per_lane ? Object.values(results_per_lane).every(s => s === 'active') : null)(null)
    };
  }
  return health;
}

// === INBOX/OUTBOX MOVEMENT ===
function getInboxOutboxMovement() {
  const movement = {};
  for (const lane of ALL_LANES) {
    const root = LANE_ROOTS[lane];
    const inboxDir = path.join(root, 'lanes', lane, 'inbox');
    const outboxDir = path.join(root, 'lanes', lane, 'outbox');
    const deliveredDir = path.join(outboxDir, 'delivered');
    const processedDir = path.join(inboxDir, 'processed');

    movement[lane] = {
      inbox_pending: fs.existsSync(inboxDir) ? fs.readdirSync(inboxDir).filter(f => f.endsWith('.json') && !f.startsWith('heartbeat-')).length : 0,
      outbox_pending: fs.existsSync(outboxDir) ? fs.readdirSync(outboxDir).filter(f => f.endsWith('.json')).length : 0,
      outbox_delivered: fs.existsSync(deliveredDir) ? fs.readdirSync(deliveredDir).filter(f => f.endsWith('.json')).length : 0,
      inbox_processed: fs.existsSync(processedDir) ? fs.readdirSync(processedDir).filter(f => f.endsWith('.json')).length : 0
    };
  }
  return movement;
}

// === LEDGER ===
function appendLedgerEntry(auditResults) {
  const entry = {
    v: AUDIT_VERSION,
    ts: nowIso(),
    host: os.hostname(),
    topology: {
      exp: auditResults.service_topology.expected_total,
      act: auditResults.service_topology.active,
      ok: auditResults.service_topology.invariant_ok,
      miss: auditResults.service_topology.missing.length,
      dup: auditResults.service_topology.duplicates.length,
      crash: auditResults.service_topology.crash_loops.length,
      orphan: auditResults.service_topology.orphan_processes
    },
    drift: {
      status: auditResults.canonical_drift.status,
      checked: auditResults.canonical_drift.files_checked,
      aligned: auditResults.canonical_drift.aligned,
      drift_n: auditResults.canonical_drift.drift_details.length,
      regress: auditResults.canonical_drift.regression_failures.length,
      gov: auditResults.canonical_drift.governance_packet ? auditResults.canonical_drift.governance_packet.severity : null
    },
    health: {},
    io: auditResults.inbox_outbox,
    deps: { ok: auditResults.executor_deps.ok, miss: auditResults.executor_deps.missing.length },
    bcast: { passed: auditResults.broadcast_proof.passed, n: auditResults.broadcast_proof.delivered_count },
    cognition: auditResults.agent_activation.length > 0,
    recommendations: auditResults.agent_activation.map(r => `${r.priority}:${r.trigger}`),
    summary: auditResults.summary
  };

  for (const [lane, h] of Object.entries(auditResults.lane_health)) {
    entry.health[lane] = { i: h.inbox, o: h.outbox, hb: h.heartbeat_age_ms, gc: h.git_clean };
  }

  const dir = path.dirname(LEDGER_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(LEDGER_PATH, JSON.stringify(entry) + '\n', 'utf8');
  return entry;
}

// === 7. HEADLESS RECOMMENDATION PACKET ===
function buildRecommendationPackets(auditResults, cycleId) {
  const packets = [];
  const ts = nowIso();

  if (auditResults.agent_activation.length === 0) {
    packets.push({
      id: `rec-${cycleId}-000`,
      generated_at: ts,
      source_cycle_id: cycleId,
      severity: 'INFO',
      recommendation_type: 'NO_ACTION',
      reason: 'All invariants OK, no cognition needed',
      evidence_refs: [`autonomy-ledger.jsonl:${cycleId}`],
      affected_lanes: [],
      requires_agent_cognition: false,
      requires_operator_attention: false,
      next_safe_action: 'None — continue autonomous operation',
      confidence: 1.0
    });
    return packets;
  }

  let idx = 1;
  for (const rec of auditResults.agent_activation) {
    const typeMap = {
      'canonical_drift': rec.trigger === 'convergence_review' ? 'CONVERGENCE_REVIEW_DUE' : 'REVIEW_DRIFT',
      'crash_loop': 'CRASH_LOOP_DETECTED',
      'service_topology_violation': 'TOPOLOGY_ANOMALY',
      'stale_task': 'P0_STALE_TASK',
      'blocker': 'SPAWN_AGENT_RECOMMENDED',
      'operator_handoff': 'OPERATOR_PING_SEEN'
    };
    const recType = typeMap[rec.trigger] || 'NO_ACTION';
    const needsCognition = ['P0', 'P1'].includes(rec.priority);
    const needsOperator = rec.trigger === 'operator_handoff' || rec.trigger === 'blocker';

    packets.push({
      id: `rec-${cycleId}-${String(idx).padStart(3, '0')}`,
      generated_at: ts,
      source_cycle_id: cycleId,
      severity: rec.priority,
      recommendation_type: recType,
      reason: rec.description,
      evidence_refs: [`autonomy-ledger.jsonl:${cycleId}`, `headless-self-audit.js:${rec.trigger}`],
      affected_lanes: extractAffectedLanes(rec.description),
      requires_agent_cognition: needsCognition,
      requires_operator_attention: needsOperator,
      next_safe_action: rec.action,
      confidence: rec.priority === 'P0' ? 0.95 : rec.priority === 'P1' ? 0.8 : 0.6
    });
    idx++;
  }

  return packets;
}

function extractAffectedLanes(description) {
  const lanes = [];
  for (const lane of [...SERVICED_LANES, ...VIRTUAL_LANES]) {
    if (description.includes(lane)) lanes.push(lane);
  }
  return lanes.length > 0 ? lanes : ['all'];
}

// === 8. AUTONOMY LEDGER ROLLUP ===
function buildRollup(ledgerPath, windowHours) {
  windowHours = windowHours || 24;
  const cutoff = Date.now() - (windowHours * 3600000);

  if (!fs.existsSync(ledgerPath)) {
    return { error: 'ledger not found', window_hours: windowHours };
  }

  const lines = fs.readFileSync(ledgerPath, 'utf8').split('\n').filter(Boolean);
  const recent = [];

  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      const entryTime = new Date(entry.ts).getTime();
      if (entryTime >= cutoff) recent.push(entry);
    } catch (_) { /* skip malformed */ }
  }

  if (recent.length === 0) {
    return { window_hours: windowHours, cycle_count: 0, status: 'no_data' };
  }

  const topoOk = recent.filter(e => e.topology && e.topology.ok).length;
  const driftIncidents = recent.filter(e => e.drift && e.drift.status !== 'NO_DRIFT').length;
  const bcastPass = recent.filter(e => e.bcast && e.bcast.passed === true).length;
  const bcastTotal = recent.filter(e => e.bcast && e.bcast.passed !== null).length;
  const depsOk = recent.filter(e => e.deps && e.deps.ok).length;
  const cogNeeded = recent.filter(e => e.cognition === true).length;
const cogHandoffEmitted = recent.filter(e => e.cognition_handoff_emitted === true).length;
const cogHandoffSuppressed = recent.filter(e => e.cognition === true && e.cognition_handoff_emitted === false).length;

  const recTypeCounts = {};
  for (const e of recent) {
    for (const r of (e.recommendations || [])) {
      recTypeCounts[r] = (recTypeCounts[r] || 0) + 1;
    }
  }
  const topRecTypes = Object.entries(recTypeCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([type, count]) => ({ type, count }));

  const lastEntry = recent[recent.length - 1];
  const status = cogNeeded > recent.length * 0.5
    ? 'Degraded — cognition frequently needed'
    : topoOk < recent.length * 0.8
    ? 'Unstable — topology anomalies frequent'
    : driftIncidents > recent.length * 0.5
    ? 'Drifty — canonical sync frequently required'
    : 'Healthy — substrate autonomous and stable';

  const rollup = {
    generated_at: nowIso(),
    window_hours: windowHours,
    cycle_count: recent.length,
    topology_stability_pct: recent.length > 0 ? Math.round(topoOk / recent.length * 100) : 0,
    drift_incidents: driftIncidents,
    broadcast_proof_pass_rate: bcastTotal > 0 ? Math.round(bcastPass / bcastTotal * 100) : null,
    dependency_validation_pass_rate: recent.length > 0 ? Math.round(depsOk / recent.length * 100) : 0,
  cognition_needed_count: cogNeeded,
  cognition_needed_pct: recent.length > 0 ? Math.round(cogNeeded / recent.length * 100) : 0,
  cognition_handoff_emitted_count: cogHandoffEmitted,
  cognition_handoff_emitted_pct: recent.length > 0 ? Math.round(cogHandoffEmitted / recent.length * 100) : 0,
  cognition_handoff_suppressed_count: cogHandoffSuppressed,
  cognition_handoff_suppressed_pct: recent.length > 0 ? Math.round(cogHandoffSuppressed / recent.length * 100) : 0,
    top_recommendation_types: topRecTypes,
    last_cycle_summary: lastEntry ? lastEntry.summary : null,
    substrate_status: status
  };

  const dir = path.dirname(ROLLUP_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(ROLLUP_PATH, JSON.stringify(rollup, null, 2), 'utf8');

  return rollup;
}

// === 9. COGNITION HANDOFF PACKET ===
function emitCognitionHandoff(recommendations, cycleId) {
  const cogRecs = recommendations.filter(r => r.requires_agent_cognition);
  if (cogRecs.length === 0) return null;

  const ts = nowIso().replace(/[+:]/g, '-');
  const packet = {
    schema_version: '1.3',
    task_id: `headless-cognition-recommendation-${cycleId}`,
    from: 'headless-self-audit',
    to: 'archivist',
    timestamp: nowIso(),
    priority: cogRecs.some(r => r.severity === 'P0') ? 'P0' : 'P1',
    type: 'recommendation',
    subject: `Substrate cognition needed: ${cogRecs.length} trigger(s)`,
    body: `The headless self-audit layer recommends attaching agent cognition. Triggers: ${cogRecs.map(r => r.recommendation_type).join(', ')}. Details: ${cogRecs.map(r => r.reason).join('; ')}`,
    requires_action: true,
    audit_cycle_id: cycleId,
    recommendation_packets: cogRecs,
    _source: 'headless-self-audit.js',
    _auto_generated: true
  };

  const inboxDir = path.join(LANE_ROOTS.archivist, 'lanes', 'archivist', 'inbox');
  if (!fs.existsSync(inboxDir)) fs.mkdirSync(inboxDir, { recursive: true });

  const filePath = path.join(inboxDir, `headless-cognition-recommendation-${ts}.json`);
  fs.writeFileSync(filePath, JSON.stringify(packet, null, 2), 'utf8');

  return { delivered: true, path: filePath, packet_id: packet.task_id, trigger_count: cogRecs.length };
}

// === 10. RECOMMENDATION LIFECYCLE LEDGER ===
function buildDedupeKey(rec) {
  const laneKey = (rec.affected_lanes || []).sort().join('+');
  const reasonClass = rec.recommendation_type;
  return `${reasonClass}:${laneKey}`;
}

function getRecLedgerPath() {
  return process.env.REC_LEDGER || path.join(__dirname, '..', 'context-buffer', 'recommendation-ledger.jsonl');
}

function loadRecommendationLedger() {
  const ledgerPath = getRecLedgerPath();
  if (!fs.existsSync(ledgerPath)) return [];
  const lines = fs.readFileSync(ledgerPath, 'utf8').split('\n').filter(Boolean);
  const entries = [];
  for (const line of lines) {
    try { entries.push(JSON.parse(line)); } catch (_) { /* skip malformed */ }
  }
  return entries;
}

function writeRecommendationLedger(entries) {
  const ledgerPath = getRecLedgerPath();
  const dir = path.dirname(ledgerPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(ledgerPath, entries.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf8');
}

function updateRecommendationLedger(newPackets, cycleId) {
  const existing = loadRecommendationLedger();
  const now = nowIso();
  const existingByKey = {};
  for (const e of existing) { existingByKey[e.dedupe_key] = e; }

  const results = { new_count: 0, ongoing_count: 0, escalated_count: 0, suppressed_count: 0, resolved_count: 0 };
  const activeKeys = new Set();

  for (const packet of newPackets) {
    if (packet.recommendation_type === 'NO_ACTION') continue;
    const key = buildDedupeKey(packet);
    activeKeys.add(key);
    const prev = existingByKey[key];

    if (!prev) {
      const entry = {
        recommendation_id: packet.id,
        dedupe_key: key,
        recommendation_type: packet.recommendation_type,
        first_seen_at: now,
        last_seen_at: now,
        occurrence_count: 1,
        current_state: 'NEW',
        severity: packet.severity,
        affected_lanes: packet.affected_lanes,
        reason: packet.reason,
        cycles_since_first: 0,
        cycles_since_last_escalation: 0,
        disposition: null,
        disposition_at: null,
        resolution_evidence_refs: [],
        false_positive: null,
        cognition_handoff_emitted: true
      };
      existing.push(entry);
      existingByKey[key] = entry;
      results.new_count++;
    } else {
      prev.occurrence_count++;
      prev.last_seen_at = now;
      prev.cycles_since_first++;
      prev.cycles_since_last_escalation++;

      const severityEscalated = ['P0', 'P1', 'P2', 'P3'].indexOf(packet.severity) < ['P0', 'P1', 'P2', 'P3'].indexOf(prev.severity);
      const scopeExpanded = packet.affected_lanes.length > prev.affected_lanes.length;

      if (severityEscalated || scopeExpanded) {
        prev.current_state = 'ESCALATED';
        prev.severity = packet.severity;
        prev.affected_lanes = packet.affected_lanes;
        prev.cycles_since_last_escalation = 0;
        prev.cognition_handoff_emitted = true;
        results.escalated_count++;
      } else if (prev.cycles_since_first >= DEDUPE_SUPPRESS_CYCLES && prev.disposition !== 'ACCEPT') {
        prev.current_state = 'ONGOING_MONITORED';
        prev.cognition_handoff_emitted = false;
        results.ongoing_count++;
      } else {
        prev.current_state = 'ONGOING_MONITORED';
        if (prev.occurrence_count <= 2) {
          prev.cognition_handoff_emitted = true;
        } else {
          prev.cognition_handoff_emitted = false;
          results.suppressed_count++;
        }
        results.ongoing_count++;
      }
    }
  }

  for (const entry of existing) {
    if (!activeKeys.has(entry.dedupe_key) && entry.current_state !== 'RESOLVED') {
      entry.current_state = 'RESOLVED';
      entry.resolved_at = now;
      results.resolved_count++;
    }
  }

  writeRecommendationLedger(existing);
  return { ...results, total_active: existing.filter(e => e.current_state !== 'RESOLVED').length };
}

// === 11. DISPOSITION CAPTURE ===
function recordDisposition(dedupeKey, disposition, evidenceRefs, isFalsePositive) {
  const existing = loadRecommendationLedger();
  const entry = existing.find(e => e.dedupe_key === dedupeKey);
  if (!entry) return { error: 'not_found' };

  entry.disposition = disposition;
  entry.disposition_at = nowIso();
  if (evidenceRefs) entry.resolution_evidence_refs = evidenceRefs;
  if (isFalsePositive !== undefined) entry.false_positive = isFalsePositive;
  if (disposition === 'REJECT') entry.false_positive = true;

  writeRecommendationLedger(existing);
  return { updated: true, dedupe_key: dedupeKey, disposition };
}

// === 12.5 LEDGER POST-DEDUPE PATCH ===
function patchLedgerCognitionHandoff(entryTs, handoffEmitted, recSummary) {
  const lines = fs.readFileSync(LEDGER_PATH, 'utf8').split('\n').filter(Boolean);
  const lastIdx = lines.length - 1;
  if (lastIdx < 0) return;
  try {
    const entry = JSON.parse(lines[lastIdx]);
    if (entry.ts === entryTs) {
      entry.cognition_handoff_emitted = handoffEmitted;
      entry.rec_ledger_summary = recSummary;
      lines[lastIdx] = JSON.stringify(entry);
      fs.writeFileSync(LEDGER_PATH, lines.join('\n') + '\n', 'utf8');
    }
  } catch (_) { /* non-fatal */ }
}

// === 12. ROLLUP ENHANCEMENTS ===
function buildEnhancedRollup(ledgerPath, recLedgerPath, windowHours) {
  windowHours = windowHours || 24;
  const cutoff = Date.now() - (windowHours * 3600000);

  const base = buildRollup(ledgerPath, windowHours);

  const recEntries = loadRecommendationLedger();
  const activeRecs = recEntries.filter(e => e.current_state !== 'RESOLVED');
  const newRecs = recEntries.filter(e => {
    const t = new Date(e.first_seen_at).getTime();
    return t >= cutoff;
  });
  const resolvedRecs = recEntries.filter(e => e.current_state === 'RESOLVED' && e.resolved_at && new Date(e.resolved_at).getTime() >= cutoff);
  const acceptedRecs = recEntries.filter(e => e.disposition === 'ACCEPT');
  const rejectedRecs = recEntries.filter(e => e.disposition === 'REJECT' || e.false_positive === true);
  const suppressedRecs = recEntries.filter(e => e.cognition_handoff_emitted === false && e.occurrence_count > 1);
  const totalAdjudicated = acceptedRecs.length + rejectedRecs.length;

  base.recommendation_metrics = {
    new_24h: newRecs.length,
    resolved_24h: resolvedRecs.length,
    active_unresolved: activeRecs.length,
    total_suppressed: suppressedRecs.length,
    recommendation_precision: totalAdjudicated > 0 ? Math.round(acceptedRecs.length / totalAdjudicated * 100) : null,
    false_positive_rate: totalAdjudicated > 0 ? Math.round(rejectedRecs.length / totalAdjudicated * 100) : null,
    operator_attention_required: activeRecs.filter(e => e.requires_operator_attention || e.severity === 'P0').length,
    archivist_action_yield: totalAdjudicated > 0 ? Math.round(acceptedRecs.length / totalAdjudicated * 100) : null,
    top_unresolved: activeRecs.slice(0, 5).map(e => ({ type: e.recommendation_type, lanes: e.affected_lanes, state: e.current_state, count: e.occurrence_count }))
  };

  base.verdict = buildVerdict(base);

  const dir = path.dirname(ROLLUP_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(ROLLUP_PATH, JSON.stringify(base, null, 2), 'utf8');

  return base;
}

function buildVerdict(rollup) {
  const rm = rollup.recommendation_metrics || {};
  const cogPct = rollup.cognition_needed_pct || 0;
  const cogEmitPct = rollup.cognition_handoff_emitted_pct || 0;
  const topoPct = rollup.topology_stability_pct || 0;
  const bcastRate = rollup.broadcast_proof_pass_rate;

  if (rm.active_unresolved > 0 && rm.active_unresolved <= 2 && cogEmitPct < 30) {
    return 'Substrate stable — minor issues monitored, no cognition pressure';
  }
  if (cogEmitPct > 60 && rm.recommendation_precision !== null && rm.recommendation_precision < 50) {
    return 'Noisy — many cognition requests but low yield, calibration needed';
  }
  if (rm.active_unresolved === 0 && topoPct >= 95) {
    return 'Substrate stable — all invariants green, autonomous operation normal';
  }
  if (bcastRate !== null && bcastRate < 50) {
    return 'Degraded — broadcast reliability below threshold, investigate';
  }
  if (rm.operator_attention_required > 0) {
    return 'Attention required — P0 or operator-targeted issues unresolved';
  }
  if (cogEmitPct > 40) {
    return 'Under pressure — cognition frequently requested, review escalation policy';
  }
  if (cogPct > 50 && cogEmitPct < 10) {
    return 'Conditions detected but suppression effective — substrate managing autonomously';
  }
  return 'Substrate operational — monitoring continues';
}

// === MAIN AUDIT ===
function runFullAudit(opts) {
  opts = opts || {};

  const serviceTopology = checkServiceTopology();
  const canonicalDrift = checkCanonicalDrift();
  const laneHealth = getLaneHealth();
  const inboxOutbox = getInboxOutboxMovement();
  const executorDeps = checkExecutorDependencies();
  const broadcastProof = opts.skipBroadcastTest
    ? { passed: null, skipped: true, details: [], delivered_count: 0, expected_count: 0 }
    : testBroadcastDelivery();

  const auditResults = {
    service_topology: serviceTopology,
    canonical_drift: canonicalDrift,
    lane_health: laneHealth,
    inbox_outbox: inboxOutbox,
    executor_deps: executorDeps,
    broadcast_proof: broadcastProof
  };

  auditResults.agent_activation = checkAgentActivationNeeded(auditResults);

  const issues = [];
  if (!serviceTopology.invariant_ok) {
    issues.push(`topology: ${serviceTopology.active}/${serviceTopology.expected_total} active, ${serviceTopology.missing.length} missing, ${serviceTopology.crash_loops.length} crash`);
  }
  if (canonicalDrift.status !== 'NO_DRIFT') issues.push(`drift: ${canonicalDrift.status}`);
  if (!executorDeps.ok) issues.push(`deps: ${executorDeps.missing.length} missing files`);
  if (broadcastProof.passed === false) issues.push(`broadcast: FAILED (${broadcastProof.delivered_count}/${broadcastProof.expected_count} delivered)`);
  if (serviceTopology.crash_loops.length > 0) issues.push(`crash: ${serviceTopology.crash_loops.length} loops`);
  if (serviceTopology.duplicates.length > 0) issues.push(`dupes: ${serviceTopology.duplicates.length} deprecated active`);
  if (auditResults.agent_activation.length > 0) issues.push(`cognition: ${auditResults.agent_activation.length} triggers`);

  auditResults.summary = issues.length === 0
    ? 'All invariants OK. Substrate healthy, no agent cognition needed.'
    : issues.join('; ') + '.';

const entry = appendLedgerEntry(auditResults);

const cycleId = entry.ts.replace(/[.:]/g, '-');
auditResults.recommendation_packets = buildRecommendationPackets(auditResults, cycleId);

const recLedgerResult = updateRecommendationLedger(auditResults.recommendation_packets, cycleId);
auditResults.rec_ledger_summary = recLedgerResult;

const unsuppressedRecs = auditResults.recommendation_packets.filter(p => {
  if (p.recommendation_type === 'NO_ACTION') return false;
  const key = buildDedupeKey(p);
  const recEntries = loadRecommendationLedger();
  const entry = recEntries.find(e => e.dedupe_key === key);
  return entry && entry.cognition_handoff_emitted;
});
auditResults.cognition_handoff = emitCognitionHandoff(unsuppressedRecs, cycleId);

// Patch ledger entry with post-dedupe cognition handoff state
const cognitionActuallyEmitted = !!(auditResults.cognition_handoff && auditResults.cognition_handoff.delivered);
patchLedgerCognitionHandoff(entry.ts, cognitionActuallyEmitted, recLedgerResult);

auditResults.rollup = buildEnhancedRollup(LEDGER_PATH, getRecLedgerPath(), 24);

  if (!opts.quiet) {
    if (opts.json) {
      console.log(JSON.stringify(entry));
    } else {
      console.log(JSON.stringify(entry, null, 2));
    }
  }

  return entry;
}

// === CLI ===
if (require.main === module) {
  const args = process.argv.slice(2);
  const opts = {
    skipBroadcastTest: args.includes('--skip-broadcast-test'),
    quiet: args.includes('--quiet'),
    once: args.includes('--once'),
    watch: args.includes('--watch'),
    json: args.includes('--json')
  };

  if (args.includes('--help') || args.includes('-h')) {
    console.log(`headless-self-audit.js v${AUDIT_VERSION} — Self-auditing headless substrate

Usage: node headless-self-audit.js [options]

Options:
  --once                  Run single audit cycle and exit
  --watch                 Run continuous audit (60s interval)
  --skip-broadcast-test   Skip broadcast delivery proof test
  --quiet                 Only write ledger, suppress stdout
  --json                  Output compact JSON (no pretty-print)
  --help                  Show this help

Components:
  1. Canonical Drift Sentinel     — detects NO_DRIFT / EXPECTED / UNEXPECTED / SYNC_REQUIRED
  2. Service Topology Guard       — asserts 4×(worker+relay+heartbeat+executor) + 2 system = 18
  3. Autonomy Ledger              — compact JSONL cycle records for Pulse/CatchMeUp
  4. Agent-Activation Policy      — advisory: when to recommend attaching model cognition
  5. Broadcast Delivery Proof     — verifies to=all fan-out delivery to all lanes
  6. Dependency Validation        — ensures executor utility files exist on all lanes

Drift classification:
  NO_DRIFT                       — all targets match canonical
  EXPECTED_DRIFT_CANONICAL_CHANGED — canonical newer than targets (needs sync)
  UNEXPECTED_TARGET_DRIFT        — target modified independently (investigate)
  SYNC_REQUIRED                  — missing targets or unexpected drift (action needed)

Ledger: ${LEDGER_PATH}`);
    process.exit(0);
  }

  if (opts.once || (!opts.watch && !process.stdin.isTTY)) {
    const result = runFullAudit(opts);
    if (!opts.json && !opts.quiet) {
      console.log(`\n[AUDIT] ${result.summary}`);
    }
    process.exit(result.cognition ? 1 : 0);
  }

  if (opts.watch) {
    console.log(`[AUDIT] v${AUDIT_VERSION} watching (60s interval)...`);
    runFullAudit(opts);
    setInterval(() => {
      const result = runFullAudit({ ...opts, quiet: true });
      console.log(`[AUDIT] ${result.ts} ${result.summary}`);
    }, 60000);
  }
}

module.exports = {
  runFullAudit, checkCanonicalDrift, checkServiceTopology,
  checkAgentActivationNeeded, testBroadcastDelivery, checkExecutorDependencies,
  buildRecommendationPackets, buildRollup, buildEnhancedRollup,
  emitCognitionHandoff, buildDedupeKey, updateRecommendationLedger,
  recordDisposition, loadRecommendationLedger, getRecLedgerPath,
  SERVICED_LANES, VIRTUAL_LANES, REQUIRED_EXECUTOR_FILES,
  RECOMMENDATION_TYPES, REC_LIFECYCLE_STATES, REC_DISPOSITIONS,
  REC_LEDGER_PATH, DEDUPE_SUPPRESS_CYCLES, AUDIT_VERSION
};
