#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_ROOT = 'S:/Archivist-Agent';
const DEFAULT_STALE_HOURS = 6;

const CLASS_RULES = [
  {
    type: 'lane_summary',
    match: (name) => /^lane-e2e-summary-.*\.json$/i.test(name),
    required: ['timestamp', 'final_status', 'active_blockers']
  },
  {
    type: 'blocker_report',
    match: (name, json) =>
      /blocker|escalation|p0/i.test(name) || json.type === 'escalation',
    required: ['id', 'timestamp', 'priority', 'subject']
  },
  {
    type: 'p0_resolution',
    match: (name, json) =>
      /resolution/i.test(name) || json.type === 'resolution',
    required: ['id', 'timestamp', 'priority', 'resolution']
  },
  {
    type: 'convergence_artifact',
    match: (name, json) =>
      /convergence|aggregation/i.test(name) || json.type === 'aggregation',
    required: ['timestamp']
  }
];

function parseArgs(argv) {
  const args = { root: DEFAULT_ROOT, staleHours: DEFAULT_STALE_HOURS, write: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root' && argv[i + 1]) args.root = argv[++i];
    else if (a === '--stale-hours' && argv[i + 1]) args.staleHours = Number(argv[++i]);
    else if (a === '--write' && argv[i + 1]) args.write = argv[++i];
  }
  return args;
}

function readJsonSafe(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return { ok: true, value: JSON.parse(raw) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function isObj(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

function normalizeBlockerList(v) {
  if (v == null) return [];
  if (Array.isArray(v)) {
    return v
      .map(x => String(x).trim())
      .filter(Boolean)
      .filter(x => x.toLowerCase() !== 'none');
  }
  const s = String(v).trim();
  if (!s || s.toLowerCase() === 'none') return [];
  return [s];
}

function classifyArtifact(fileName, json) {
  for (const rule of CLASS_RULES) {
    if (rule.match(fileName, json)) return rule;
  }
  return null;
}

function parseIso(ts) {
  if (typeof ts !== 'string') return null;
  const t = Date.parse(ts);
  return Number.isFinite(t) ? t : null;
}

function blockersFromArtifact(json) {
  const blockers = new Set();

  for (const b of normalizeBlockerList(json.active_blockers)) blockers.add(b);
  for (const b of normalizeBlockerList(json.active_blocker)) blockers.add(b);
  for (const b of normalizeBlockerList(json.resolved_blockers)) blockers.add(b);

  if (isObj(json.blockers)) {
    for (const [k, v] of Object.entries(json.blockers)) {
      const key = String(k).trim();
      if (!key) continue;
      blockers.add(key);
      const val = String(v || '').toLowerCase();
      if (val.includes('resolved')) blockers.add(`${key}#RESOLVED_HINT`);
    }
  }

  if (typeof json.id === 'string' && /p0-escalation-/i.test(json.id)) {
    const suffix = json.id.replace(/^p0-escalation-/i, '').trim();
    if (suffix) blockers.add(suffix);
  }
  if (typeof json.id === 'string' && /resolution/i.test(json.id)) {
    const suffix = json.id.replace(/-?resolution/i, '').trim();
    if (suffix) blockers.add(suffix);
  }

  return Array.from(blockers).filter(b => !b.endsWith('#RESOLVED_HINT'));
}

function statusClaims(json) {
  const claims = [];

  const blockers = blockersFromArtifact(json);
  const active = normalizeBlockerList(json.active_blockers).concat(normalizeBlockerList(json.active_blocker));
  const resolved = normalizeBlockerList(json.resolved_blockers);

  const finalStatus = String(json.final_status || json.status || json.system_status || '').toUpperCase();

  for (const b of active) claims.push({ blocker: b, status: 'NOT_RESOLVED' });
  for (const b of resolved) claims.push({ blocker: b, status: 'RESOLVED' });

  if (json.blocker_resolved === true && blockers.length) {
    for (const b of blockers) claims.push({ blocker: b, status: 'RESOLVED' });
  }

  if (isObj(json.resolution)) {
    const decision = String(json.resolution.status || json.resolution.decision || '').toUpperCase();
    if (decision.includes('RESOLVED') || decision.includes('CONVERGED')) {
      for (const b of blockers) claims.push({ blocker: b, status: 'RESOLVED' });
    }
  }

  if ((finalStatus === 'FAIL' || finalStatus === 'NOT_RESOLVED') && blockers.length) {
    for (const b of blockers) claims.push({ blocker: b, status: 'NOT_RESOLVED' });
  }

  return claims;
}

function collectArtifacts(root) {
  const dirs = [
    path.join(root, 'lanes', 'archivist', 'inbox'),
    path.join(root, 'lanes', 'archivist', 'outbox')
  ];

  const artifacts = [];
  const parseErrors = [];
  const candidateName = /lane-e2e-summary-|blocker|escalation|p0|resolution|convergence|aggregation/i;

  for (const d of dirs) {
    if (!fs.existsSync(d)) continue;
    for (const name of fs.readdirSync(d)) {
      if (!name.endsWith('.json')) continue;
      if (!candidateName.test(name)) continue;
      if (name === 'convergence-contradiction-report.json') continue;
      const p = path.join(d, name);
      const parsed = readJsonSafe(p);
      if (!parsed.ok) {
        parseErrors.push({
          severity: 'P1',
          kind: 'json_parse_error',
          file: p,
          message: parsed.error
        });
        continue;
      }
      artifacts.push({ file: p, fileName: name, json: parsed.value });
    }
  }

  return { artifacts, parseErrors };
}

function runCheck(root, staleHours) {
  const nowMs = Date.now();
  const staleMs = staleHours * 60 * 60 * 1000;
  const { artifacts, parseErrors } = collectArtifacts(root);

  const findings = [...parseErrors];
  const indexedClaims = new Map();

  for (const a of artifacts) {
    const rule = classifyArtifact(a.fileName, a.json);
    if (!rule) continue;

    for (const f of rule.required) {
      if (!(f in a.json)) {
        findings.push({
          severity: 'P1',
          kind: 'missing_required_field',
          file: a.file,
          artifact_type: rule.type,
          field: f
        });
      }
    }

    const ts = parseIso(a.json.timestamp);
    if (!ts) {
      findings.push({
        severity: 'P1',
        kind: 'invalid_timestamp',
        file: a.file,
        value: a.json.timestamp || null
      });
    } else if (nowMs - ts > staleMs) {
      findings.push({
        severity: 'P2',
        kind: 'stale_timestamp',
        file: a.file,
        timestamp: a.json.timestamp,
        age_hours: Number(((nowMs - ts) / (60 * 60 * 1000)).toFixed(2)),
        stale_threshold_hours: staleHours
      });
    }

    const finalStatus = String(a.json.final_status || a.json.status || a.json.system_status || '').toUpperCase();
    const active = normalizeBlockerList(a.json.active_blockers).concat(normalizeBlockerList(a.json.active_blocker));
    if ((finalStatus === 'PASS' || finalStatus === 'PASS-WARN' || finalStatus === 'RESOLVED') && active.length > 0) {
      findings.push({
        severity: 'P0',
        kind: 'unresolved_blocker_marked_resolved',
        file: a.file,
        final_status: finalStatus,
        active_blockers: active
      });
    }

    for (const c of statusClaims(a.json)) {
      if (!indexedClaims.has(c.blocker)) indexedClaims.set(c.blocker, []);
      indexedClaims.get(c.blocker).push({
        ...c,
        file: a.file,
        timestamp: a.json.timestamp || null
      });
    }
  }

  for (const [blocker, claims] of indexedClaims.entries()) {
    const statuses = new Set(claims.map(c => c.status));
    if (statuses.has('RESOLVED') && statuses.has('NOT_RESOLVED')) {
      findings.push({
        severity: 'P0',
        kind: 'contradictory_blocker_status',
        blocker,
        claims
      });
    }
  }

  const severityCounts = findings.reduce(
    (acc, f) => {
      acc[f.severity] = (acc[f.severity] || 0) + 1;
      return acc;
    },
    { P0: 0, P1: 0, P2: 0 }
  );

  const contradicts = [];
  const activeBlockers = new Set();

  for (const f of findings) {
    if (f.kind === 'unresolved_blocker_marked_resolved') {
      const actualList = Array.isArray(f.active_blockers) ? f.active_blockers : [];
      for (const b of actualList) activeBlockers.add(String(b));
      contradicts.push({
        artifact: f.file,
        field: 'final_status_vs_active_blockers',
        expected: 'PASS/PASS-WARN/RESOLVED requires no active blockers',
        actual: `final_status=${f.final_status}; active_blockers=${actualList.join(' | ')}`
      });
    } else if (f.kind === 'contradictory_blocker_status') {
      activeBlockers.add(String(f.blocker));
      const actualStatuses = (f.claims || []).map(c => `${c.status}@${c.file}`).join(' | ');
      contradicts.push({
        artifact: f.blocker,
        field: 'blocker_status',
        expected: 'single consistent status',
        actual: actualStatuses
      });
    }
  }

  const findingsDigest = crypto
    .createHash('sha256')
    .update(JSON.stringify(findings))
    .digest('hex');

  const status =
    severityCounts.P0 > 0
      ? 'BLOCKED'
      : severityCounts.P1 > 0 || severityCounts.P2 > 0
        ? 'PASS-WARN'
        : 'PASS';

  return {
    artifact_type: 'contradiction-report',
    lane: 'archivist',
    generated_at: new Date().toISOString(),
    status,
    p0_findings: severityCounts.P0,
    p1_findings: severityCounts.P1,
    p2_findings: severityCounts.P2,
    active_blockers: Array.from(activeBlockers).sort(),
    contradicts,
    evidence: {
      file: __filename,
      line: 1,
      hash: `sha256:${findingsDigest}`
    },
    root,
    stale_threshold_hours: staleHours,
    scanned_artifacts: artifacts.length,
    findings_count: findings.length,
    severity_counts: severityCounts,
    findings
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const report = runCheck(args.root, args.staleHours);

  if (args.write) {
    fs.writeFileSync(args.write, JSON.stringify(report, null, 2), 'utf8');
    console.log(`Wrote report: ${args.write}`);
  }

  console.log(JSON.stringify(report, null, 2));

  // Hard fail only on contradiction-grade issues.
  process.exit(report.severity_counts.P0 > 0 ? 1 : 0);
}

if (require.main === module) {
  main();
}

module.exports = { runCheck };
