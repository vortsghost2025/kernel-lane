#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { createSignedMessage } = require('./create-signed-message');
const { createMessage, deliverMessage, getCanonicalPath } = require('../src/lane/SchemaValidator');

const REVIEW_ID = `full-lane-review-${Date.now()}`;
const REPORT_DIR = 'S:/Archivist-Agent/lanes/archivist/outbox';

function runNodeJson(scriptPath, args = []) {
  const res = spawnSync('node', [scriptPath, ...args], { encoding: 'utf8' });
  const stdout = (res.stdout || '').trim();
  if (!stdout) {
    return { ok: res.status === 0, status: res.status, json: null, stderr: (res.stderr || '').trim() };
  }
  try {
    return { ok: res.status === 0, status: res.status, json: JSON.parse(stdout), stderr: (res.stderr || '').trim() };
  } catch (_) {
    return { ok: res.status === 0, status: res.status, json: null, stdout, stderr: (res.stderr || '').trim() };
  }
}

function getGitStatus(repo) {
  const res = spawnSync('git', ['-C', repo, 'status', '--short'], { encoding: 'utf8' });
  const lines = (res.stdout || '').split(/\r?\n/).filter(Boolean);
  const summary = { modified: 0, added: 0, deleted: 0, untracked: 0, total: lines.length };
  for (const l of lines) {
    if (l.startsWith('??')) summary.untracked += 1;
    if (l.includes('M')) summary.modified += 1;
    if (l.includes('D')) summary.deleted += 1;
    if (l.includes('A')) summary.added += 1;
  }
  return { lines, summary };
}

function readJsonIfExists(file) {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return null;
  }
}

function buildEvidence() {
  const syncGate = runNodeJson('S:/self-organizing-library/scripts/sync-gate-verify.js');

  // post-compact writes to file; run and then read the artifact
  spawnSync('node', ['S:/Archivist-Agent/scripts/post-compact-audit.js'], { encoding: 'utf8' });
  const compactAudit = readJsonIfExists('S:/Archivist-Agent/.compact-audit/POST_COMPACT_AUDIT.json');

  const recovery = runNodeJson('S:/Archivist-Agent/scripts/recover-action-required-from-processed.js');

  const repos = {
    archivist: 'S:/Archivist-Agent',
    library: 'S:/self-organizing-library',
    kernel: 'S:/kernel-lane',
    swarmmind: 'S:/SwarmMind',
  };

  const git = {};
  for (const [lane, repo] of Object.entries(repos)) {
    git[lane] = getGitStatus(repo);
  }

  return { syncGate, compactAudit, recovery, git };
}

function buildLaneTasks(evidence) {
  const tasks = {
    archivist: [],
    library: [],
    kernel: [],
    swarmmind: [],
  };

  const rec = evidence.recovery && evidence.recovery.json ? evidence.recovery.json : null;
  if (rec && Array.isArray(rec.lanes)) {
    for (const laneEntry of rec.lanes) {
      if (laneEntry.actionableFound > 0 && tasks[laneEntry.lane]) {
        tasks[laneEntry.lane].push(`Recover ${laneEntry.actionableFound} action-required messages from processed/ using recover-action-required-from-processed.js --lane ${laneEntry.lane} --apply, then triage action-required/ with completion evidence.`);
      }
    }
  }

  const sg = evidence.syncGate && evidence.syncGate.json ? evidence.syncGate.json : null;
  if (sg && sg.status !== 'PASS') {
    tasks.library.push('Repair malformed SwarmMind public_key_pem in lanes/broadcast/trust-store.json (DER parse currently failing) using kernel canonical trust-store as source, then re-run sync-gate verification.');
    tasks.kernel.push('Publish canonical trust-store snapshot across all lanes and verify all 4 key_id derivations are valid (4/4) in each lane copy.');
    tasks.swarmmind.push('Validate .identity/public.pem and trust-store entry consistency; provide signed proof that public_key_pem parses and derives key_id 60afaa026a3d969d.');
  }

  const ca = evidence.compactAudit;
  if (ca && String(ca.status || '').toLowerCase() !== 'stable') {
    const contradictions = ca.contradictions || 0;
    tasks.archivist.push(`Resolve post-compact audit drifted state (contradictions=${contradictions}) and produce fresh audit artifact with status stable/proven.`);
  }

  if ((evidence.git.kernel.summary.deleted || 0) > 0) {
    tasks.kernel.push('Review and reconcile mass deleted inbox reply artifacts (D entries in git status) to ensure no completion evidence was lost.');
  }

  tasks.archivist.push('Run cross-lane review heartbeat after remediation and publish consolidated closure report to all lanes with proven vs assumed sections.');
  tasks.library.push('Commit and ship watcher fail-closed guard changes; verify action-required messages never auto-move to processed.');
  tasks.kernel.push('Commit and ship watcher fail-closed guard changes; verify action-required messages never auto-move to processed.');
  tasks.swarmmind.push('Commit and ship watcher fail-closed guard changes; verify action-required messages never auto-move to processed.');

  return tasks;
}

function formatLaneBody(lane, evidence, tasks) {
  const sg = evidence.syncGate && evidence.syncGate.json ? evidence.syncGate.json : null;
  const ca = evidence.compactAudit || null;
  const g = evidence.git[lane] ? evidence.git[lane].summary : { total: 0 };

  const lines = [];
  lines.push(`# Cross-Lane Review Dispatch (${REVIEW_ID})`);
  lines.push('');
  lines.push('Proven findings:');
  lines.push(`- sync-gate status: ${sg ? sg.status : 'unknown'}`);
  if (sg && sg.issues) lines.push(`- sync-gate issues: ${sg.issues.length}`);
  if (ca) lines.push(`- post-compact status: ${ca.status || 'unknown'} (contradictions=${ca.contradictions || 0})`);
  lines.push(`- git drift (${lane}): total=${g.total}, modified=${g.modified || 0}, deleted=${g.deleted || 0}, untracked=${g.untracked || 0}`);
  lines.push('');
  lines.push('Required tasks:');
  tasks.forEach((t, i) => lines.push(`${i + 1}. ${t}`));
  lines.push('');
  lines.push('Response contract: send signed completion response with exact evidence paths and command outputs.');
  return lines.join('\n');
}

function sendSignedTask(toLane, subject, body, priority = 'P0') {
  const base = createMessage({
    from: 'archivist',
    to: toLane,
    type: 'task',
    task_kind: 'review',
    priority,
    subject,
    body,
    requires_action: true,
    payload: {
      mode: 'inline',
      compression: 'none',
      path: null,
      chunk: { index: 0, count: 1, group_id: null },
    },
    execution: {
      mode: 'manual',
      engine: 'kilo',
      actor: 'lane',
      session_id: null,
      parent_id: null,
    },
    evidence: {
      required: false,
      evidence_path: null,
      verified: false,
      verified_by: null,
      verified_at: null,
    },
    review_id: REVIEW_ID,
    generated_by: 'full-lane-review-and-dispatch.js',
  });

  if (base.delivery_verification) {
    base.delivery_verification = {
      verified: false,
      verified_at: null,
      retries: 0,
    };
  }

  const signed = createSignedMessage(base, 'archivist');
  const canonicalPath = getCanonicalPath(toLane);
  const delivery = deliverMessage(signed, canonicalPath);

  return {
    lane: toLane,
    task_id: signed.task_id,
    idempotency_key: signed.idempotency_key,
    path: delivery.path,
    delivered: delivery.delivered,
    verified: delivery.verified,
  };
}

function sendArchivistSummary(evidence, dispatchResults, tasks) {
  const subject = `System review summary ${REVIEW_ID}`;
  const lines = [];
  lines.push(`# Master Summary (${REVIEW_ID})`);
  lines.push('');
  lines.push('Proven:');
  if (evidence.syncGate && evidence.syncGate.json) {
    const sg = evidence.syncGate.json;
    lines.push(`- sync-gate: ${sg.status}`);
    lines.push(`- sync-gate issues: ${(sg.issues || []).length}, mismatches: ${(sg.mismatches || []).length}`);
  }
  if (evidence.compactAudit) {
    lines.push(`- post-compact: ${evidence.compactAudit.status} (contradictions=${evidence.compactAudit.contradictions || 0})`);
  }
  if (evidence.recovery && evidence.recovery.json) {
    lines.push(`- recovery dry-run actionableFound: ${evidence.recovery.json.totals?.actionableFound || 0}`);
  }
  lines.push('');
  lines.push('Lane task counts:');
  for (const lane of ['archivist', 'library', 'kernel', 'swarmmind']) {
    lines.push(`- ${lane}: ${tasks[lane].length}`);
  }
  lines.push('');
  lines.push('Dispatch results:');
  for (const r of dispatchResults) {
    lines.push(`- ${r.lane}: delivered=${r.delivered} verified=${r.verified} path=${r.path}`);
  }

  const msg = createMessage({
    from: 'archivist',
    to: 'archivist',
    type: 'ack',
    task_kind: 'review',
    priority: 'P0',
    subject,
    body: lines.join('\n'),
    requires_action: false,
    payload: {
      mode: 'inline',
      compression: 'none',
      path: null,
      chunk: { index: 0, count: 1, group_id: null },
    },
    execution: {
      mode: 'manual',
      engine: 'kilo',
      actor: 'lane',
      session_id: null,
      parent_id: null,
    },
    evidence: {
      required: false,
      evidence_path: null,
      verified: false,
      verified_by: null,
      verified_at: null,
    },
    review_id: REVIEW_ID,
    generated_by: 'full-lane-review-and-dispatch.js',
    dispatch_count: dispatchResults.length,
  });

  const signed = createSignedMessage(msg, 'archivist');
  const pathToArchivist = getCanonicalPath('archivist');
  const delivery = deliverMessage(signed, pathToArchivist);
  return {
    task_id: signed.task_id,
    path: delivery.path,
    delivered: delivery.delivered,
    verified: delivery.verified,
  };
}

function ensureReportDir() {
  if (!fs.existsSync(REPORT_DIR)) {
    fs.mkdirSync(REPORT_DIR, { recursive: true });
  }
}

function writeReport(report) {
  ensureReportDir();
  const fp = path.join(REPORT_DIR, `${REVIEW_ID}-dispatch-report.json`);
  fs.writeFileSync(fp, JSON.stringify(report, null, 2), 'utf8');
  return fp;
}

(function main() {
  const evidence = buildEvidence();
  const tasks = buildLaneTasks(evidence);

  const dispatchResults = [];
  for (const lane of ['library', 'kernel', 'swarmmind']) {
    const body = formatLaneBody(lane, evidence, tasks[lane]);
    const subject = `Required remediation tasks (${REVIEW_ID})`;
    dispatchResults.push(sendSignedTask(lane, subject, body, 'P0'));
  }

  const archivistSummary = sendArchivistSummary(evidence, dispatchResults, tasks);

  const report = {
    review_id: REVIEW_ID,
    timestamp: new Date().toISOString(),
    evidence_overview: {
      sync_gate_status: evidence.syncGate && evidence.syncGate.json ? evidence.syncGate.json.status : 'unknown',
      compact_audit_status: evidence.compactAudit ? evidence.compactAudit.status : 'unknown',
      recovery_actionable_found: evidence.recovery && evidence.recovery.json && evidence.recovery.json.totals
        ? evidence.recovery.json.totals.actionableFound
        : null,
    },
    git_summary: {
      archivist: evidence.git.archivist.summary,
      library: evidence.git.library.summary,
      kernel: evidence.git.kernel.summary,
      swarmmind: evidence.git.swarmmind.summary,
    },
    tasks,
    dispatch_results: dispatchResults,
    archivist_summary: archivistSummary,
  };

  const reportPath = writeReport(report);
  console.log(JSON.stringify({ ok: true, review_id: REVIEW_ID, report_path: reportPath, dispatch_results: dispatchResults, archivist_summary: archivistSummary }, null, 2));
})();
