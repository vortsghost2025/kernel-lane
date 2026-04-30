/**
 * Daily Productivity Report Generator
 * Runs per-lane, broadcasts needs/requests to all lanes daily
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const LANE = process.env.LANE || 'swarmmind';

const LANE_ROOTS = {
  swarmmind: 'S:/SwarmMind',
  archivist: 'S:/Archivist-Agent',
  kernel: 'S:/kernel-lane',
  library: 'S:/self-organizing-library'
};

const LANE_ROOT = LANE_ROOTS[LANE];
const INBOX_DIR = path.join(LANE_ROOT, 'lanes', LANE, 'inbox');
const STATE_DIR = path.join(LANE_ROOT, 'lanes', LANE, 'state');
const OUTBOX_DIR = path.join(LANE_ROOT, 'lanes', LANE, 'outbox');
const EVIDENCE_BASE = path.join(LANE_ROOT, 'evidence', 'productivity-reports');

fs.mkdirSync(STATE_DIR, { recursive: true });
fs.mkdirSync(OUTBOX_DIR, { recursive: true });
fs.mkdirSync(EVIDENCE_BASE, { recursive: true });

// ============ Helpers ============

function countFiles(dir, subfolder = '') {
  try {
    const fullDir = subfolder ? path.join(dir, subfolder) : dir;
    return fs.readdirSync(fullDir).filter(f => fs.statSync(path.join(fullDir, f)).isFile()).length;
  } catch { return 0; }
}

function getInboxStats() {
  return {
    blocked: countFiles(INBOX_DIR, 'blocked'),
    quarantine: countFiles(INBOX_DIR, 'quarantine'),
    action_required: countFiles(INBOX_DIR, 'action-required'),
    processed: countFiles(INBOX_DIR, 'processed'),
    stale_foreign: countFiles(INBOX_DIR, 'stale-foreign')
  };
}

function getWorkerAuditStats() {
  const logPath = path.join(STATE_DIR, 'worker-audit.log');
  let total = 0, schemaFail = 0, sigFail = 0;
  try {
    const lines = fs.readFileSync(logPath, 'utf8').split('\n');
    lines.forEach(line => {
      if (!line.trim()) return;
      total++;
      try {
        const entry = JSON.parse(line);
        if (entry.schema_valid === false) schemaFail++;
        if (entry.signature_valid === false) sigFail++;
      } catch(e) {}
    });
  } catch {}
  return { total, schemaFail, sigFail };
}

function loadWatcherMode() {
  try {
    return JSON.parse(fs.readFileSync(path.join(STATE_DIR, 'watcher-mode.json'), 'utf8'));
  } catch { return { mode: 'unknown' }; }
}

function loadTracker() {
  const REPORT_TRACKER = path.join(STATE_DIR, 'productivity-report-tracker.json');
  if (fs.existsSync(REPORT_TRACKER)) {
    return JSON.parse(fs.readFileSync(REPORT_TRACKER, 'utf8'));
  }
  return { previous_requests: [], last_report_date: null, report_cycle: 0 };
}

function saveTracker(tracker) {
  const REPORT_TRACKER = path.join(STATE_DIR, 'productivity-report-tracker.json');
  fs.writeFileSync(REPORT_TRACKER, JSON.stringify(tracker, null, 2));
}

// ============ Analysis ============

function analyzeBlockers(stats, audit) {
  const blockers = [];

  // Inbox accumulation
  if (stats.blocked > 0 || stats.quarantine > 0) {
    blockers.push({
      category: 'incoming_messages',
      description: `${stats.blocked} blocked, ${stats.quarantine} quarantined files need attention`,
      impact: stats.blocked > 5 ? 'high' : 'medium',
      count_last_24h: stats.blocked + stats.quarantine,
      actionable: true,
      request_to_other_lanes: 'All lanes: please ensure all outgoing messages use RS256 signatures and schema v1.3 with non-null evidence_exchange.artifact_path.'
    });
  }

  // Schema/sig failure rate
  if (audit.total > 0 && (audit.schemaFail + audit.sigFail) / audit.total > 0.1) {
    blockers.push({
      category: 'schema_failures',
      description: `${audit.schemaFail} schema invalid, ${audit.sigFail} signature invalid in worker-audit`,
      impact: 'high',
      count_last_24h: audit.schemaFail + audit.sigFail,
      actionable: true,
      request_to_other_lanes: 'All lanes: integrate pre-send-validator.js into send pipeline before writing to inboxes.'
    });
  }

  // Watcher mode
  const watcherMode = loadWatcherMode();
  if (watcherMode.mode === 'agent-assist' || watcherMode.mode === 'manual') {
    blockers.push({
      category: 'resource_constraints',
      description: `Watcher in ${watcherMode.mode} mode — auto-processing disabled while agent is active`,
      impact: 'low',
      count_last_24h: 0,
      actionable: false,
      request_to_other_lanes: 'This is expected during active agent sessions; no action needed.'
    });
  }

  // Lane-specific knowledge gaps (only for lanes that need something from Archivist)
  if (LANE === 'swarmmind') {
    blockers.push({
      category: 'knowledge_gaps',
      description: 'Awaiting CONTRADICTS edge evidence for 5 nodes (SwarmMind-assigned contradiction nodes)',
      impact: 'medium',
      count_last_24h: 0,
      actionable: true,
      request_to_other_lanes: 'Archivist: please supply explicit CONTRADICTS edge artifacts (source/target IDs, artifact paths, DERIVES lineage) for nodes: e2d590843468dbe7, f536c15cc2486eea, 3023460d99160a03, fb8212e128adc1c5, 1bda9962fbd5ca75'
    });
  }

  if (LANE === 'kernel') {
    blockers.push({
      category: 'knowledge_gaps',
      description: 'Need CONTRADICTS edge evidence for 3 Archivist-origin nodes (a88504c97e8f2e4f, b6a19d32a8604205, 044d760a04bbfa30)',
      impact: 'medium',
      count_last_24h: 0,
      actionable: true,
      request_to_other_lanes: 'Archivist: provide CONTRADICTS edge chains with provenance for these artifacts'
    });
  }

  if (LANE === 'library') {
    blockers.push({
      category: 'knowledge_gaps',
      description: 'Need CONTRADICTS edge evidence for 2 nodes (45d50e60309ef11c, 8f11fb5f4a3a5efc)',
      impact: 'medium',
      count_last_24h: 0,
      actionable: true,
      request_to_other_lanes: 'Archivist: supply CONTRADICTS edge artifacts with lineage for Library-assigned contradiction nodes'
    });
  }

  return blockers;
}

function calculateProductivityScore(stats, audit) {
  let score = 100;
  if (stats.blocked > 0) score -= stats.blocked * 5;
  if (stats.quarantine > 0) score -= stats.quarantine * 3;
  if (audit.schemaFail > 0) score -= audit.schemaFail * 2;
  if (audit.sigFail > 0) score -= audit.sigFail * 2;
  return Math.max(0, Math.min(100, Math.round(score)));
}

function inferResourceNeeds(stats) {
  const needs = [];
  if (stats.blocked + stats.quarantine > 100) {
    needs.push({
      what: 'inbox_cleanup',
      why: `High inbox clutter (${stats.blocked} blocked + ${stats.quarantine} quarantined)`,
      urgency: 'medium'
    });
  }
  return needs;
}

function suggestImprovements(lane, stats, blockers) {
  const suggestions = [];
  if (blockers.some(b => b.category === 'schema_failures')) {
    suggestions.push('Enforce pre-send-validator.js in all outbound message pipelines to reduce SCHEMA_INVALID rejections.');
  }
  if (stats.action_required === 0 && stats.processed === 0 && stats.blocked === 0) {
    suggestions.push('Inbox idle — consider reviewing assignment scope or requesting additional task streams from Archivist.');
  }
  if (stats.stale_foreign > 0) {
    suggestions.push('Stale-foreign items detected — verify cross-lane message routing correctness.');
  }
  return suggestions;
}

function trackPreviousRequests(tracker, currentBlockers) {
  const actionable = currentBlockers.filter(b => b.actionable);
  const now = new Date().toISOString();

  // Mark resolved
  tracker.previous_requests.forEach(req => {
    if (req.status === 'pending' && !actionable.some(a => a.description === req.description)) {
      req.status = 'resolved';
      req.resolved_at = now;
    }
  });

  // Add new
  actionable.forEach(blocker => {
    const exists = tracker.previous_requests.some(r => r.description === blocker.description);
    if (!exists) {
      tracker.previous_requests.push({
        request_id: crypto.randomUUID(),
        description: blocker.description,
        category: blocker.category,
        impact: blocker.impact,
        requested_at: now,
        status: 'pending',
        lane: LANE
      });
    }
  });

  tracker.last_report_date = now;
  tracker.report_cycle++;
  return tracker;
}

// ============ Generate Report ============

const stats = getInboxStats();
const audit = getWorkerAuditStats();
const blockers = analyzeBlockers(stats, audit);
const tracker = loadTracker();
const updatedTracker = trackPreviousRequests(tracker, blockers);

const reportBody = {
  lane: LANE,
  timestamp: new Date().toISOString(),
  cycle: 'daily',
  productivity_score: calculateProductivityScore(stats, audit),
  blockers,
  resource_needs: inferResourceNeeds(stats),
  knowledge_gaps: blockers.filter(b => b.category === 'knowledge_gaps').map(b => ({
    topic: b.description,
    impact: b.impact,
    request: b.request_to_other_lanes
  })),
  suggested_improvements: suggestImprovements(LANE, stats, blockers),
  previous_requests_status: updatedTracker.previous_requests.slice(-5)
};

const report = {
  schema_version: '1.3',
  task_id: `productivity-report-${LANE}-${new Date().toISOString().slice(0,10)}`,
  idempotency_key: `prod-report-${LANE}-${crypto.randomUUID()}`,
  from: LANE,
  to: 'all',
  type: 'notification',
  task_kind: 'report',
  priority: 'P2',
  subject: `[Productivity Report] ${LANE.toUpperCase()} — Daily Needs & Blockers`,
  body: JSON.stringify(reportBody, null, 2),
  timestamp: new Date().toISOString(),
  requires_action: true,
  payload: { mode: 'inline', compression: 'none' },
  execution: { mode: 'automatic', engine: 'node', actor: 'agent' },
  lease: { owner: LANE, acquired_at: new Date().toISOString(), expires_at: null, renewal_count: 0, max_renewals: 3 },
  retry: { attempt: 1, max_attempts: 3, last_error: null, last_attempt_at: null },
  evidence: { required: false, verified: false },
  evidence_exchange: { artifact_type: 'report', artifact_path: 'inline', delivered_at: new Date().toISOString() },
  heartbeat: { interval_seconds: 86400, last_heartbeat_at: new Date().toISOString(), timeout_seconds: 3600, status: 'done' },
  convergence_gate: {
    claim: `${LANE} daily productivity report generated`,
    evidence: EVIDENCE_BASE,
    verified_by: LANE,
    contradictions: [],
    status: 'proven'
  }
};

saveTracker(updatedTracker);

// Save evidence copy
const evidenceFile = path.join(EVIDENCE_BASE, `daily-report-${new Date().toISOString().slice(0,10)}.json`);
fs.writeFileSync(evidenceFile, JSON.stringify(report, null, 2));

// Write to outbox (picked up by relay-daemon)
const outboxFile = path.join(OUTBOX_DIR, `productivity-report-${LANE}-${new Date().toISOString().slice(0,10)}.json`);
fs.writeFileSync(outboxFile, JSON.stringify(report, null, 2));

console.log(`[${LANE}] Productivity report generated`);
console.log(`  Score: ${reportBody.productivity_score}/100`);
console.log(`  Blockers: ${blockers.length}`);
console.log(`  Evidence: ${evidenceFile}`);
console.log(`  Outbox: ${outboxFile}`);
