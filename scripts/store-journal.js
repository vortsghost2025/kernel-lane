#!/usr/bin/env node
/**
 * STORE JOURNAL v2 — Cross-Lane Real-Time Agent Work Ledger
 * ===========================================================
 * Purpose: Prevent agent-over-agent overwrite. Real-time cross-lane visibility.
 *
 * v2 additions over v1:
 * - status: read all lanes' recent work in one command (cross-lane)
 * - read: read any lane's journal entries
 * - snapshot: write a cross-lane status snapshot for handoff
 * - All journal reads are cross-lane by default using LaneDiscovery roots
 *
 * Each lane has its own journal at:
 * lanes/<lane>/journal/YYYY-MM-DD.jsonl
 *
 * Cross-lane daily summary:
 * lanes/broadcast/journal/DAILY_YYYY-MM-DD.md
 *
 * Cross-lane real-time snapshot:
 * lanes/broadcast/journal/SNAPSHOT.json
 *
 * Commands:
 * append   — Write a journal entry
 * preflight— Check file ownership/conflict before editing
 * daily    — Generate broadcast daily summary
 * active   — Show active ownerships and in-progress sessions
 * status   — Show all lanes' recent work (cross-lane, real-time) [v2]
 * read     — Read any lane's journal for a date [v2]
 * snapshot — Write cross-lane status snapshot JSON [v2]
 * help     — Show usage
 *
 * POLICY (STORE_JOURNAL_POLICY_v2):
 * 1. Every agent session writes work_started.
 * 2. Every file-changing session writes work_completed.
 * 3. Every compact/restart writes compact_restore event.
 * 4. Every sudo command writes sudo_action event.
 * 5. Every test run writes test_result event.
 * 6. Every blocked/quarantine event writes quarantine_event.
 * 7. Before editing, agents must check today's journal for active ownership.
 * 8. If another agent owns the path, do not edit. Create a proposal instead.
 * 9. Journal is append-only. Do not rewrite old entries.
 * 10. Daily summary is generated from JSONL, not hand-edited as truth.
 * 11. [v2] status command reads all lanes — use before starting work.
 * 12. [v2] snapshot is regenerated on every append — always current.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

// ---------------------------------------------------------------------------
// CONFIGURATION
// ---------------------------------------------------------------------------

let LaneDiscovery = null;
let discovery = null;
let LANE_ROOTS = {};
let BROADCAST_DIR = null;

try {
  LaneDiscovery = require('./util/lane-discovery').LaneDiscovery;
  discovery = new LaneDiscovery();
  var lanes = discovery.listLanes ? discovery.listLanes() : (discovery.getLaneNames ? discovery.getLaneNames() : Object.keys(discovery.registry.lanes));
  for (var _i = 0; _i < lanes.length; _i++) {
    var lane = lanes[_i];
    LANE_ROOTS[lane] = path.join(discovery.getLocalPath(lane), 'lanes', lane);
  }
  if (discovery.getBroadcastPath) {
    BROADCAST_DIR = discovery.getBroadcastPath();
  }
} catch (e) {
  var repoRoot = path.resolve(__dirname, '..');
  LANE_ROOTS = {
    library: path.join(repoRoot, 'lanes', 'library'),
    archivist: path.join(repoRoot, 'lanes', 'archivist'),
    swarmmind: path.join(repoRoot, 'lanes', 'swarmmind'),
    kernel: path.join(repoRoot, 'lanes', 'kernel'),
    opencode: path.join(repoRoot, 'lanes', 'opencode'),
  };
}

const KNOWN_LANES = Object.keys(LANE_ROOTS);

// ---------------------------------------------------------------------------
// UTILITY
// ---------------------------------------------------------------------------

function repoRoot() {
  return path.resolve(__dirname, '..');
}

function journalDir(lane) {
  if (!KNOWN_LANES.includes(lane)) {
    throw new Error("Unknown lane: '" + lane + "'. Known: " + KNOWN_LANES.join(', '));
  }
  if (LANE_ROOTS[lane]) {
    return path.join(LANE_ROOTS[lane], 'journal');
  }
  return path.join(repoRoot(), 'lanes', lane, 'journal');
}

function broadcastJournalDir() {
  if (BROADCAST_DIR) {
    return path.join(BROADCAST_DIR, 'journal');
  }
  return path.join(repoRoot(), 'lanes', 'broadcast', 'journal');
}

function journalPath(lane, dateStr) {
  const dir = journalDir(lane);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${dateStr}.jsonl`);
}

function dailySummaryPath(dateStr) {
  const dir = broadcastJournalDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `DAILY_${dateStr}.md`);
}

function generateId() {
  const buf = crypto.randomBytes(16);
  return [buf.slice(0,4), buf.slice(4,6), buf.slice(6,8), buf.slice(8,10), buf.slice(10,16)]
    .map(b => b.toString('hex')).join('-');
}

function todayISO() {
  return new Date().toISOString().split('T')[0];
}

function utcISO() {
  return new Date().toISOString();
}

function hostname() {
  return os.hostname();
}

function getArg(args, flag) {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return null;
  const val = args[idx + 1];
  if (val.startsWith('--')) return null;
  return val;
}

function readJournal(lane, dateStr) {
  let fp;
  if (LANE_ROOTS[lane]) {
    fp = path.join(LANE_ROOTS[lane], 'journal', `${dateStr}.jsonl`);
  } else {
    fp = journalPath(lane, dateStr);
  }
  if (!fs.existsSync(fp)) return [];
  const lines = fs.readFileSync(fp, 'utf8').trim().split('\n');
  const entries = [];
  for (const line of lines) {
    if (line.trim() === '') continue;
    try { entries.push(JSON.parse(line)); } catch (_) { }
  }
  return entries;
}

function readAllLanesForDate(dateStr) {
  const result = {};
  for (const lane of KNOWN_LANES) {
    result[lane] = readJournal(lane, dateStr);
  }
  return result;
}

// ---------------------------------------------------------------------------
// VALIDATION
// ---------------------------------------------------------------------------

function validateEntry(entry) {
  const errors = [];
  const required = ['timestamp', 'agent', 'lane', 'event', 'session_id', 'target', 'intent'];
  for (const field of required) {
    if (!entry[field]) errors.push(`Missing required field: ${field}`);
  }
  if (entry.event === 'work_completed' && !entry.handoff)
    errors.push("Event 'work_completed' requires 'handoff' field");
  if (entry.event === 'file_ownership_claimed' && !entry.active_ownership)
    errors.push("Event 'file_ownership_claimed' requires 'active_ownership' field");
  if (entry.lane && !KNOWN_LANES.includes(entry.lane))
    errors.push(`Invalid lane: '${entry.lane}'`);
  if (entry.timestamp && isNaN(Date.parse(entry.timestamp)))
    errors.push(`Invalid timestamp: '${entry.timestamp}'`);

	// v1.4 protocol extension validation (non-blocking warnings)
	var sv = null;
	try { sv = require('./schema-validator'); } catch (_) { /* schema-validator not available */ }
	if (sv && entry.uncertainty) {
		try {
			var r = sv.validateUncertaintyPacket(entry.uncertainty);
			if (!r.valid) {
				for (var _ue = 0; _ue < r.errors.length; _ue++) errors.push('uncertainty: ' + r.errors[_ue]);
			}
		} catch (_) { /* skip */ }
	}
	if (sv && entry.review) {
		try {
			var r2 = sv.validateReviewRound(entry.review);
			if (!r2.valid) {
				for (var _re = 0; _re < r2.errors.length; _re++) errors.push('review: ' + r2.errors[_re]);
			}
		} catch (_) { /* skip */ }
	}
	if (sv && entry.prior_attempts) {
		try {
			var r3 = sv.validatePriorAttempts(entry.prior_attempts);
			if (!r3.valid) {
				for (var _pe = 0; _pe < r3.errors.length; _pe++) errors.push('prior_attempts: ' + r3.errors[_pe]);
			}
		} catch (_) { /* skip */ }
	}

  return errors;
}

// ---------------------------------------------------------------------------
// OWNERSHIP STATE TRACKING (shared by preflight and daily)
// ---------------------------------------------------------------------------

/**
 * Build per-path ownership state from a journal entry array.
 * Returns ownershipState map: normalizedPath -> { owner_agent, session_id, reason, expires_at, is_active, lane }
 */
function buildOwnershipState(entries, laneName) {
  const state = {};

  for (const entry of entries) {
    if (!entry.active_ownership || entry.active_ownership.paths === undefined) continue;

    const owner = entry.active_ownership.owner_agent || entry.agent;
    const paths = entry.active_ownership.paths || [];
    const reason = entry.active_ownership.reason || 'unspecified';
    const expiresAt = entry.active_ownership.expires_at || null;

    // Check expiry
    if (expiresAt && new Date(expiresAt).getTime() <= Date.now()) {
      for (const [key, s] of Object.entries(state)) {
        if (s.owner_agent === owner) s.is_active = false;
      }
      continue;
    }

    // Empty paths = release all for this owner
    if (paths.length === 0 && owner) {
      for (const [key, s] of Object.entries(state)) {
        if (s.owner_agent === owner) s.is_active = false;
      }
      continue;
    }

    // Claim — set ownership
    for (const p of paths) {
      const key = p.replace(/\\/g, '/').toLowerCase();
      state[key] = {
        owner_agent: owner,
        session_id: entry.session_id,
        reason: reason,
        expires_at: expiresAt,
        is_active: true,
        claimed_at: entry.timestamp,
        lane: laneName
      };
    }
  }

  return state;
}

// ---------------------------------------------------------------------------
// COMMAND: APPEND
// ---------------------------------------------------------------------------

function cmdAppend(args) {
  const laneIdx = args.indexOf('--lane');
  if (laneIdx === -1) {
    console.error('ERROR: --lane is required');
    process.exit(1);
  }
  const lane = args[laneIdx + 1];
  if (!KNOWN_LANES.includes(lane)) {
    console.error(`ERROR: Unknown lane '${lane}'`);
    process.exit(1);
  }

  const eventIdx = args.indexOf('--event');
  if (eventIdx === -1) {
    console.error('ERROR: --event is required');
    process.exit(1);
  }
  const event = args[eventIdx + 1];
  const validEvents = [
    'work_started', 'work_completed', 'file_ownership_claimed',
    'file_ownership_released', 'test_result', 'compact_restore',
    'sudo_action', 'provider_call', 'quarantine_event', 'handoff'
  ];
  if (!validEvents.includes(event)) {
    console.error(`ERROR: Invalid event '${event}'`);
    process.exit(1);
  }

  let entry = {};
  const dataIdx = args.indexOf('--data');
  if (dataIdx !== -1) {
    try { entry = JSON.parse(args[dataIdx + 1]); }
    catch (e) { console.error(`ERROR: Invalid JSON: ${e.message}`); process.exit(1); }
  }

  entry.timestamp = entry.timestamp || utcISO();
  entry.agent = entry.agent || getArg(args, '--agent') || process.env.AGENT_NAME || 'unknown-agent';
  entry.lane = lane;
  entry.host = entry.host || hostname();
  entry.session_id = entry.session_id || getArg(args, '--session-id') || `${Date.now()}-${lane}`;
  entry.event = event;
  entry.target = entry.target || getArg(args, '--target') || 'unspecified';
  entry.intent = entry.intent || getArg(args, '--intent') || 'unspecified';
  entry._journal_id = generateId();

  const filesArg = getArg(args, '--files');
  if (filesArg && !entry.files_changed) {
    entry.files_changed = filesArg.split(',').map(f => f.trim()).filter(Boolean);
  }

  const testsArg = getArg(args, '--tests');
  if (testsArg && !entry.tests_run) {
    try { entry.tests_run = JSON.parse(testsArg); }
    catch (e) { console.error(`ERROR: Invalid --tests JSON: ${e.message}`); process.exit(1); }
  }

  if (entry.forbidden_paths_touched === undefined) entry.forbidden_paths_touched = false;

const uncertaintyArg = getArg(args, '--uncertainty');
if (uncertaintyArg && !entry.uncertainty) {
  try { entry.uncertainty = JSON.parse(uncertaintyArg); }
  catch (e) { console.error('ERROR: Invalid --uncertainty JSON: ' + e.message); process.exit(1); }
}

const reviewArg = getArg(args, '--review');
if (reviewArg && !entry.review) {
  try { entry.review = JSON.parse(reviewArg); }
  catch (e) { console.error('ERROR: Invalid --review JSON: ' + e.message); process.exit(1); }
}

const priorAttemptsArg = getArg(args, '--prior-attempts');
if (priorAttemptsArg && !entry.prior_attempts) {
  try { entry.prior_attempts = JSON.parse(priorAttemptsArg); }
  catch (e) { console.error('ERROR: Invalid --prior-attempts JSON: ' + e.message); process.exit(1); }
}

  const errors = validateEntry(entry);
  if (errors.length > 0) {
    console.error('VALIDATION ERRORS:');
    for (const err of errors) console.error(`  - ${err}`);
    process.exit(1);
  }

  const dateStr = todayISO();
  const fp = journalPath(lane, dateStr);
  fs.appendFileSync(fp, JSON.stringify(entry) + '\n', 'utf8');

  console.log(JSON.stringify({
    status: 'appended',
    _journal_id: entry._journal_id,
    lane, event, path: fp, timestamp: entry.timestamp
  }, null, 2));

  // Regenerate daily summary and snapshot
  try { cmdDaily([dateStr]); } catch (_) { /* non-blocking */ }
  try { cmdSnapshot([]); } catch (_) { /* non-blocking */ }
}

// ---------------------------------------------------------------------------
// COMMAND: PREFLIGHT
// ---------------------------------------------------------------------------

function cmdPreflight(args) {
  const laneIdx = args.indexOf('--lane');
  if (laneIdx === -1) { console.error('ERROR: --lane is required'); process.exit(1); }
  const lane = args[laneIdx + 1];
  if (!KNOWN_LANES.includes(lane)) {
    console.error(`ERROR: Unknown lane '${lane}'`);
    process.exit(1);
  }

  const pathsIdx = args.indexOf('--paths');
  if (pathsIdx === -1) { console.error('ERROR: --paths is required'); process.exit(1); }
  const pathsArg = args[pathsIdx + 1];
  const targetPaths = pathsArg.split(',').map(p => p.trim()).filter(Boolean);
  if (targetPaths.length === 0) { console.error('ERROR: At least one path required'); process.exit(1); }

  const dateStr = todayISO();
  const journalEntries = readJournal(lane, dateStr);

  const results = {
    lane, date: dateStr, checked_paths: targetPaths,
    verdict: 'CLEAR', details: [], active_owners: []
  };

  // Build ownership state
  const ownershipState = buildOwnershipState(journalEntries, lane);

  // Track files_changed today for WARN
  const filesChangedToday = new Map();
  for (const entry of journalEntries) {
    for (const cf of (entry.files_changed || [])) {
      const key = cf.replace(/\\/g, '/').toLowerCase();
      if (!filesChangedToday.has(key)) {
        filesChangedToday.set(key, { agent: entry.agent, session_id: entry.session_id, timestamp: entry.timestamp });
      }
    }
  }

  // Evaluate each target path
  for (const tp of targetPaths) {
    const norm = tp.replace(/\\/g, '/').toLowerCase();
    let blocked = false;

    // Check BLOCK (active ownership)
    for (const [ownedKey, state] of Object.entries(ownershipState)) {
      if (!state.is_active) continue;
      if (norm.includes(ownedKey) || ownedKey.includes(norm)) {
        blocked = true;
        results.details.push({
          path: tp, status: 'BLOCK',
          message: `Path is actively owned by ${state.owner_agent} (session: ${state.session_id})`,
          reason: state.reason, owner_agent: state.owner_agent, expires_at: state.expires_at
        });
        results.active_owners.push({
          path: tp, owner_agent: state.owner_agent, session_id: state.session_id,
          reason: state.reason, expires_at: state.expires_at
        });
      }
    }

    // Check WARN (file changed today)
    if (!blocked) {
      for (const [changedKey, info] of filesChangedToday.entries()) {
        if (norm.includes(changedKey) || changedKey.includes(norm)) {
          results.details.push({
            path: tp, status: 'WARN',
            message: `File was modified today by ${info.agent} (session: ${info.session_id})`,
            changed_by: info.agent, session_id: info.session_id
          });
        }
      }
    }

    // No issues
    if (!results.details.some(d => d.path === tp)) {
      results.details.push({ path: tp, status: 'CLEAR', message: 'No active ownership or today edits found for this path' });
    }
  }

  const blocks = results.details.filter(d => d.status === 'BLOCK');
  const warns = results.details.filter(d => d.status === 'WARN');
  results.verdict = blocks.length > 0 ? 'BLOCK' : (warns.length > 0 ? 'WARN' : 'CLEAR');

  console.log(JSON.stringify(results, null, 2));
  if (results.verdict === 'BLOCK') process.exit(1);
}

// ---------------------------------------------------------------------------
// COMMAND: DAILY
// ---------------------------------------------------------------------------

function cmdDaily(args) {
  const dateStr = args[0] || todayISO();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    console.error(`ERROR: Invalid date '${dateStr}'. Use YYYY-MM-DD.`);
    process.exit(1);
  }

  const allLanes = readAllLanesForDate(dateStr);
  const summaryPath = dailySummaryPath(dateStr);

  let md = `# Daily Store Journal Summary — ${dateStr}\n`;
  md += `> Generated: ${utcISO()}\n`;
  md += `> Host: ${hostname()}\n`;
  md += `> **IMPORTANT:** Generated from JSONL append-only journals. DO NOT HAND-EDIT.\n\n---\n\n`;

  let totalEntries = 0, totalTestsPass = 0, totalTestsFail = 0, totalFilesChanged = 0;
  const totalSessions = new Set();
  let allForbiddenPathsTouched = false;
  const allActiveOwners = [];

  for (const [lane, entries] of Object.entries(allLanes)) {
    totalEntries += entries.length;

    // Build per-lane ownership state
    const laneOwnershipState = buildOwnershipState(entries, lane);

    for (const entry of entries) {
      totalSessions.add(entry.session_id);
      if (entry.tests_run) {
        for (const t of entry.tests_run) {
          if (t.result === 'PASS') totalTestsPass++;
          if (t.result === 'FAIL' || t.result === 'ERROR') totalTestsFail++;
        }
      }
      if (entry.files_changed) totalFilesChanged += entry.files_changed.length;
      if (entry.forbidden_paths_touched) allForbiddenPathsTouched = true;
    }

    // Collect active ownerships from state
    for (const [key, state] of Object.entries(laneOwnershipState)) {
      if (state.is_active) {
        if (!allActiveOwners.some(a => a.lane === lane && a.session_id === state.session_id && a.paths.includes(key))) {
          allActiveOwners.push({
            lane, agent: state.owner_agent, paths: [key],
            reason: state.reason, expires_at: state.expires_at, session_id: state.session_id
          });
        }
      }
    }
  }

  md += `## Overview\n\n| Metric | Value |\n|--------|-------|\n`;
  md += `| Total journal entries | ${totalEntries} |\n`;
  md += `| Active sessions | ${totalSessions.size} |\n`;
  md += `| Tests passed | ${totalTestsPass} |\n`;
  md += `| Tests failed | ${totalTestsFail} |\n`;
  md += `| Files changed | ${totalFilesChanged} |\n`;
  md += `| Forbidden paths touched | ${allForbiddenPathsTouched ? '⚠️ YES' : '✅ No'} |\n\n`;

  md += `## Per-Lane Breakdown\n\n`;
  const laneOrder = ['library', 'archivist', 'swarmmind', 'kernel', 'broadcast', 'opencode'];

  for (const lane of laneOrder) {
    const entries = allLanes[lane] || [];
    if (entries.length === 0) {
      md += `### 🟦 ${lane} (idle)\n\n_No journal entries for ${dateStr}._\n\n`;
      continue;
    }
    md += `### 🟢 ${lane} (${entries.length} entries)\n\n`;

    const sessions = {};
    for (const entry of entries) {
      if (!sessions[entry.session_id]) sessions[entry.session_id] = [];
      sessions[entry.session_id].push(entry);
    }

    for (const [sid, sessionEntries] of Object.entries(sessions)) {
      const first = sessionEntries[0], last = sessionEntries[sessionEntries.length - 1];
      const events = [...new Set(sessionEntries.map(e => e.event))];
      const fileChanges = [...new Set(sessionEntries.flatMap(e => e.files_changed || []))];
      const workTypes = [...new Set(sessionEntries.filter(e => e.work_type).map(e => e.work_type))];

      md += `#### Session: ${first.agent} (${sid.slice(0, 16)}...)\n\n`;
      md += `- **Agent:** ${first.agent}\n`;
      md += `- **Target:** ${first.target}\n`;
      md += `- **Intent:** ${first.intent}\n`;
      md += `- **Work types:** ${workTypes.join(', ') || 'unspecified'}\n`;
      md += `- **Events:** ${events.join(', ')}\n`;
      md += `- **Files changed:** ${fileChanges.length ? fileChanges.map(f => '`' + f + '`').join(', ') : 'none'}\n`;

      const completed = sessionEntries.find(e => e.event === 'work_completed');
      if (completed && completed.handoff) {
        md += `- **Handoff status:** ${completed.handoff.status}\n`;
        if (completed.handoff.next_action) md += `- **Next action:** ${completed.handoff.next_action}\n`;
        if (completed.handoff.do_not_overwrite && completed.handoff.do_not_overwrite.length) {
          md += `- **⚠️ Do not overwrite:** ${completed.handoff.do_not_overwrite.map(f => '`' + f + '`').join(', ')}\n`;
        }
        if (completed.handoff.human_required) md += `- **👤 Human intervention REQUIRED**\n`;
      }

      const tests = sessionEntries.flatMap(e => e.tests_run || []);
      if (tests.length) {
        const pass = tests.filter(t => t.result === 'PASS').length;
        const fail = tests.filter(t => t.result === 'FAIL' || t.result === 'ERROR').length;
        md += `- **Tests:** ${fail > 0 ? '❌' : '✅'} ${pass} pass, ${fail} fail\n`;
      }

      // v1.4: Surface uncertainty and review state
      const uncertaintyEntries = sessionEntries.filter(e => e.uncertainty);
      if (uncertaintyEntries.length > 0) {
        const highUncertainty = uncertaintyEntries.filter(e => e.uncertainty.level === 'high');
        const operatorNeeded = uncertaintyEntries.filter(e => e.uncertainty.operator_decision_needed);
        md += `- **Uncertainty:** ${uncertaintyEntries.length} item(s)`;
        if (highUncertainty.length > 0) md += ` — ⚠️ ${highUncertainty.length} HIGH`;
        if (operatorNeeded.length > 0) md += ` — 👤 ${operatorNeeded.length} NEEDS OPERATOR`;
        md += `\n`;
        for (const ue of uncertaintyEntries) {
          const u = ue.uncertainty;
          md += `  - [${u.level}] ${u.why}`;
          if (u.operator_decision_needed) md += ' **(OPERATOR DECISION NEEDED)**';
          md += `\n`;
        }
      }

      const reviewEntries = sessionEntries.filter(e => e.review);
      if (reviewEntries.length > 0) {
        const lastReview = reviewEntries[reviewEntries.length - 1].review;
        md += `- **Review:** round ${lastReview.round}/${lastReview.max_rounds} — ${lastReview.status}\n`;
        if (lastReview.feedback && lastReview.feedback.length > 0) {
          for (const fb of lastReview.feedback) {
            md += `  - Issue: ${fb.issue} → Fix: ${fb.required_fix}\n`;
          }
        }
      }

      md += `\n| Timestamp | Event | Details |\n|-----------|-------|--------|\n`;
      for (const entry of sessionEntries) {
        md += `| ${entry.timestamp} | ${entry.event} | ${entry.files_changed ? 'Changed: ' + entry.files_changed.length + ' file(s)' : ''} |\n`;
      }
      md += `\n`;
    }
    md += `---\n\n`;
  }

  if (allActiveOwners.length > 0) {
    md += `## ⚠️ Active File Ownership\n\n> **DO NOT EDIT** these files while ownership is active.\n\n`;
    md += `| Lane | Agent | Paths | Reason | Expires | Session |\n`;
    md += `|------|-------|-------|--------|---------|--------|\n`;
    for (const o of allActiveOwners) {
      md += `| ${o.lane} | ${o.agent} | ${o.paths.map(p => '`' + p + '`').join(', ')} | ${o.reason} | ${o.expires_at || 'indefinite'} | ${o.session_id.slice(0, 16)}... |\n`;
    }
    md += `\n### Do Not Overwrite\n\n`;
    for (const o of allActiveOwners) {
      for (const p of o.paths) {
        md += `- \`${p}\` (owned by ${o.agent}/${o.lane}, reason: ${o.reason})\n`;
      }
    }
    md += `\n`;
  }

  if (allForbiddenPathsTouched) {
    md += `## 🚨 WARNING: Forbidden Paths Touched\n\n> One or more agents touched forbidden paths today. Review immediately.\n\n`;
  }

  md += `---\n\n_Auto-generated by store-journal.js. Source: lanes/*/journal/${dateStr}.jsonl_\n`;

  const dir = broadcastJournalDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(summaryPath, md, 'utf8');
  console.log(md);
}

// ---------------------------------------------------------------------------
// COMMAND: ACTIVE
// ---------------------------------------------------------------------------

function cmdActive(args) {
  const specificLane = getArg(args, '--lane');
  const lanes = specificLane ? [specificLane] : KNOWN_LANES;
  const dateStr = todayISO();

  const allActive = [];

  for (const lane of lanes) {
    if (!KNOWN_LANES.includes(lane)) { console.error(`WARNING: Unknown lane '${lane}', skipping.`); continue; }
    const entries = readJournal(lane, dateStr);
    const ownershipState = buildOwnershipState(entries, lane);

    // Active ownerships
    for (const [key, state] of Object.entries(ownershipState)) {
      if (state.is_active) {
        allActive.push({
          lane, agent: state.owner_agent, session_id: state.session_id,
          paths: [key], reason: state.reason,
          expires_at: state.expires_at, claimed_at: state.claimed_at
        });
      }
    }

    // In-progress sessions (work_started without work_completed)
    const completedSessionIds = new Set(
      entries.filter(e => e.event === 'work_completed').map(e => e.session_id)
    );
    for (const entry of entries.filter(e => e.event === 'work_started')) {
      if (!completedSessionIds.has(entry.session_id)) {
        if (!allActive.some(a => a.session_id === entry.session_id)) {
          allActive.push({
            lane, agent: entry.agent, session_id: entry.session_id,
            paths: entry.files_changed || [],
            reason: 'Session in progress (no work_completed)',
            expires_at: null, claimed_at: entry.timestamp, status: 'in_progress'
          });
        }
      }
    }
  }

  const output = { date: dateStr, active_count: allActive.length, active: allActive };
  if (allActive.length === 0) output.message = 'No active ownerships or in-progress sessions found.';
  console.log(JSON.stringify(output, null, 2));
}

// ---------------------------------------------------------------------------
// COMMAND: STATUS (v2 — cross-lane real-time view)
// ---------------------------------------------------------------------------

function cmdStatus(args) {
  var dateStr = todayISO();
  var hoursBack = parseInt(getArg(args, '--hours') || '24', 10);
  var cutoff = new Date(Date.now() - hoursBack * 3600000).toISOString();

  var allLanes = {};
  var datesNeeded = [];
  for (var d = 0; d <= Math.ceil(hoursBack / 24); d++) {
    var dt = new Date(Date.now() - d * 86400000);
    datesNeeded.push(dt.toISOString().slice(0, 10));
  }
  for (var _ln = 0; _ln < KNOWN_LANES.length; _ln++) {
    var ln = KNOWN_LANES[_ln];
    allLanes[ln] = [];
    for (var _d = 0; _d < datesNeeded.length; _d++) {
      var dayEntries = readJournal(ln, datesNeeded[_d]);
      for (var _de = 0; _de < dayEntries.length; _de++) {
        allLanes[ln].push(dayEntries[_de]);
      }
    }
  }

  var status = {
    generated_at: utcISO(),
    date: dateStr,
    hours_back: hoursBack,
    lanes: {}
  };

  for (var _lane2 = 0; _lane2 < KNOWN_LANES.length; _lane2++) {
    var lane = KNOWN_LANES[_lane2];
    var entries = allLanes[lane] || [];
    var recent = entries.filter(function(e) { return e.timestamp >= cutoff; });
    var completedIds = {};
    for (var _r = 0; _r < recent.length; _r++) {
      if (recent[_r].event === 'work_completed') completedIds[recent[_r].session_id] = true;
    }
    var inProgress = recent.filter(function(e) { return e.event === 'work_started' && !completedIds[e.session_id]; });
    var ownershipState = buildOwnershipState(recent, lane);
    var activeOwners = [];
    for (var key in ownershipState) {
      if (ownershipState[key].is_active) {
        activeOwners.push({ path: key, owner: ownershipState[key].owner_agent, reason: ownershipState[key].reason, expires_at: ownershipState[key].expires_at });
      }
    }
    var filesChanged = [];
    var seen = {};
    for (var _f = 0; _f < recent.length; _f++) {
      var fc = recent[_f].files_changed || [];
      for (var _fc = 0; _fc < fc.length; _fc++) {
        if (!seen[fc[_fc]]) { seen[fc[_fc]] = true; filesChanged.push(fc[_fc]); }
      }
    }
    var lastEntry = recent.length > 0 ? recent[recent.length - 1] : null;

  status.lanes[lane] = {
  entries_today: recent.length,
  in_progress_sessions: inProgress.map(function(e) { return { agent: e.agent, session_id: e.session_id, target: e.target, started_at: e.timestamp }; }),
  active_ownerships: activeOwners,
  files_changed: filesChanged,
  last_activity: lastEntry ? lastEntry.timestamp : null,
  last_event: lastEntry ? lastEntry.event : null,
  last_agent: lastEntry ? lastEntry.agent : null,
  uncertainty_summary: (function() {
    var items = recent.filter(function(e) { return e.uncertainty; });
    if (items.length === 0) return null;
    var high = items.filter(function(e) { return e.uncertainty.level === 'high'; });
    var operatorNeeded = items.filter(function(e) { return e.uncertainty.operator_decision_needed; });
    return {
      total: items.length,
      high: high.length,
      operator_decision_needed: operatorNeeded.length,
      latest: high.length > 0 ? high[high.length - 1].uncertainty : (items.length > 0 ? items[items.length - 1].uncertainty : null)
    };
  })(),
  review_summary: (function() {
    var items = recent.filter(function(e) { return e.review; });
    if (items.length === 0) return null;
    var last = items[items.length - 1].review;
    return { round: last.round, max_rounds: last.max_rounds, status: last.status };
  })()
  };
  }

  console.log(JSON.stringify(status, null, 2));
}
// COMMAND: READ (v2 — read any lane's journal)
// ---------------------------------------------------------------------------

function cmdRead(args) {
  const lane = getArg(args, '--lane');
  const dateStr = getArg(args, '--date') || todayISO();
  const lastN = parseInt(getArg(args, '--last') || '20', 10);

  if (!lane) { console.error('ERROR: --lane is required'); process.exit(1); }
  if (!KNOWN_LANES.includes(lane)) { console.error(`ERROR: Unknown lane '${lane}'`); process.exit(1); }

  const entries = readJournal(lane, dateStr);
  const recent = entries.slice(-lastN);

  console.log(JSON.stringify({ lane, date: dateStr, total: entries.length, showing: recent.length, entries: recent }, null, 2));
}

// ---------------------------------------------------------------------------
// COMMAND: SNAPSHOT (v2 — write cross-lane snapshot for handoff)
// ---------------------------------------------------------------------------

function cmdSnapshot(args) {
  const dateStr = todayISO();
  const allLanes = readAllLanesForDate(dateStr);

  const snapshot = {
    schema: 'store-journal-snapshot-v2',
    generated_at: utcISO(),
    host: hostname(),
    date: dateStr,
    lanes: {}
  };

  for (const [lane, entries] of Object.entries(allLanes)) {
    const completedIds = new Set(entries.filter(e => e.event === 'work_completed').map(e => e.session_id));
    const inProgress = entries.filter(e => e.event === 'work_started' && !completedIds.has(e.session_id));
    const ownershipState = buildOwnershipState(entries, lane);
    const activeOwners = Object.entries(ownershipState).filter(([, s]) => s.is_active).map(([key, s]) => ({ path: key, owner: s.owner_agent, reason: s.reason }));
    const filesChanged = [...new Set(entries.flatMap(e => e.files_changed || []))];
    const lastEntry = entries.length > 0 ? entries[entries.length - 1] : null;

snapshot.lanes[lane] = {
total_entries: entries.length,
in_progress: inProgress.map(e => ({ agent: e.agent, session_id: e.session_id, target: e.target, started_at: e.timestamp })),
active_ownerships: activeOwners,
files_changed_today: filesChanged,
last_activity: lastEntry ? { timestamp: lastEntry.timestamp, event: lastEntry.event, agent: lastEntry.agent } : null,
uncertainty_summary: (function() {
  var items = entries.filter(e => e.uncertainty);
  if (items.length === 0) return null;
  var high = items.filter(e => e.uncertainty.level === 'high');
  var operatorNeeded = items.filter(e => e.uncertainty.operator_decision_needed);
  return {
  total: items.length,
  high: high.length,
  operator_decision_needed: operatorNeeded.length,
  latest: high.length > 0 ? high[high.length - 1].uncertainty : (items.length > 0 ? items[items.length - 1].uncertainty : null)
  };
})(),
review_summary: (function() {
  var items = entries.filter(e => e.review);
  if (items.length === 0) return null;
  var last = items[items.length - 1].review;
  return { round: last.round, max_rounds: last.max_rounds, status: last.status };
})()
};
  }

  const dir = broadcastJournalDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const fp = path.join(dir, 'SNAPSHOT.json');
  fs.writeFileSync(fp, JSON.stringify(snapshot, null, 2), 'utf8');
  console.log(JSON.stringify({ status: 'written', path: fp, generated_at: snapshot.generated_at }, null, 2));
}

// ---------------------------------------------------------------------------
// COMMAND: AUTOFIX (v3 — orphan session completion + stale owner cleanup)
// ---------------------------------------------------------------------------

function cmdAutofix(args) {
  var dryRun = !args.includes('--apply');
  var orphanTTL = 2 * 3600000;
  var ownerTTL = 4 * 3600000;
  var report = { generated_at: utcISO(), host: hostname(), dry_run: dryRun, orphan_sessions: [], stale_owners: [], actions_taken: [] };

  var dateStr = todayISO();
  var allLanes = readAllLanesForDate(dateStr);
  var yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  var yesterdayLanes = readAllLanesForDate(yesterday);

  for (var _lane = 0; _lane < KNOWN_LANES.length; _lane++) {
    var lane = KNOWN_LANES[_lane];
    var entries = (allLanes[lane] || []).concat(yesterdayLanes[lane] || []);
    var completedIds = {};
    var startedMap = {};
    for (var _e = 0; _e < entries.length; _e++) {
      var e = entries[_e];
      if (e.event === 'work_completed') completedIds[e.session_id] = true;
      if (e.event === 'work_started' && !startedMap[e.session_id]) startedMap[e.session_id] = e;
    }

    var sessionIds = Object.keys(startedMap);
    for (var _s = 0; _s < sessionIds.length; _s++) {
      var sid = sessionIds[_s];
      if (completedIds[sid]) continue;
      var startEntry = startedMap[sid];
      var age = Date.now() - new Date(startEntry.timestamp).getTime();
      if (age < orphanTTL) continue;
      var isTestSession = (startEntry.session_id || '').indexOf('smoke-test') >= 0 ||
                          (startEntry.session_id || '').indexOf('test-') >= 0 ||
                          (startEntry.agent || '').indexOf('test') >= 0 ||
                          (startEntry.agent || '').indexOf('smoke') >= 0;
      var orphan = {
        session_id: sid,
        lane: lane,
        agent: startEntry.agent,
        target: startEntry.target,
        started_at: startEntry.timestamp,
        age_hours: (age / 3600000).toFixed(1),
        is_test_session: isTestSession
      };
      orphan.proposed_completion = {
        event: 'work_completed',
        session_id: sid,
        agent: startEntry.agent || 'unknown',
        lane: lane,
        target: startEntry.target || 'orphaned',
        intent: 'auto-completed: orphaned session (TTL expired)',
        handoff: { status: 'orphaned', auto_completed: true, original_started_at: startEntry.timestamp },
        timestamp: utcISO()
      };
      report.orphan_sessions.push(orphan);

      if (!dryRun) {
        var entry = orphan.proposed_completion;
        entry._journal_id = generateId();
        entry.host = hostname();
        entry.forbidden_paths_touched = false;
        var jp = journalPath(lane, dateStr);
        fs.appendFileSync(jp, JSON.stringify(entry) + '\n', 'utf8');
        report.actions_taken.push('appended orphan completion: ' + sid + ' lane=' + lane);
      }
    }
  }

  var repoRt = repoRoot();
  for (var _l2 = 0; _l2 < KNOWN_LANES.length; _l2++) {
    var ln = KNOWN_LANES[_l2];
    var ownerPath = path.join(LANE_ROOTS[ln] ? LANE_ROOTS[ln] : path.join(repoRt, 'lanes', ln), 'state', 'active-owner.json');
    if (!fs.existsSync(ownerPath)) continue;
    try {
      var ownerData = JSON.parse(fs.readFileSync(ownerPath, 'utf8'));
      var ownerAge = Date.now() - new Date(ownerData.claimed_at || ownerData.timestamp || 0).getTime();
      var pidAlive = false;
      if (ownerData.pid) {
        try {
          process.kill(ownerData.pid, 0);
          pidAlive = true;
        } catch (_) {
          pidAlive = false;
        }
      }
      var isStale = ownerAge > ownerTTL && !pidAlive;
      report.stale_owners.push({
        path: ownerPath,
        lane: ln,
        owner: ownerData.owner_agent || ownerData.agent,
        pid: ownerData.pid,
        pid_alive: pidAlive,
        claimed_at: ownerData.claimed_at || ownerData.timestamp,
        age_hours: (ownerAge / 3600000).toFixed(1),
        is_stale: isStale
      });
      if (!dryRun && isStale) {
        fs.unlinkSync(ownerPath);
        report.actions_taken.push('deleted stale active-owner: ' + ownerPath + ' lane=' + ln);
      }
    } catch (__) {}
  }

  console.log(JSON.stringify(report, null, 2));
}

// ---------------------------------------------------------------------------
// HELP
// ---------------------------------------------------------------------------

function cmdHelp() {
  console.log(`STORE JOURNAL v2 — Cross-Lane Real-Time Agent Work Ledger
===========================================================

Usage: node scripts/store-journal.js <command> [options]

Commands:
  append    Append a journal entry to today's lane journal
  preflight Check if files are safe to edit (ownership/conflict)
  daily     Generate daily summary for broadcast
  active    Show active ownerships and in-progress sessions
  status    Show all lanes' recent work (cross-lane, real-time) [v2]
  read      Read any lane's journal for a date [v2]
  snapshot  Write cross-lane status snapshot JSON [v2]
  help      Show this help

APPEND:
  node scripts/store-journal.js append \\
    --lane <lane> --event <event> [--agent <name>] [--session-id <id>] \\
    [--target <description>] [--intent <description>] \\
    [--files <path1,path2,...>] [--tests '<json-array>'] [--data '<json>']

  Events: work_started, work_completed, file_ownership_claimed,
  file_ownership_released, test_result, compact_restore,
  sudo_action, provider_call, quarantine_event, handoff

PREFLIGHT:
  node scripts/store-journal.js preflight --lane <lane> --paths <path1,path2,...>
  Exit codes: 0 = CLEAR/WARN, 1 = BLOCK

DAILY:
  node scripts/store-journal.js daily [YYYY-MM-DD]
  Output: lanes/broadcast/journal/DAILY_YYYY-MM-DD.md

ACTIVE:
  node scripts/store-journal.js active [--lane <lane>]
  Shows active ownerships and in-progress sessions for today.

STATUS (v2):
  node scripts/store-journal.js status [--hours <N>]
  Reads all lanes' journals, shows in-progress sessions,
  active ownerships, files changed, last activity.
  Use BEFORE starting work to see what's happening.

READ (v2):
  node scripts/store-journal.js read --lane <lane> [--date YYYY-MM-DD] [--last N]
  Read a specific lane's journal entries.

  SNAPSHOT (v2):
  node scripts/store-journal.js snapshot
  Writes lanes/broadcast/journal/SNAPSHOT.json with cross-lane state.
  Safe for other agents to read as handoff reference.

  AUTOFIX (v3):
  node scripts/store-journal.js autofix [--apply]
  Detects orphaned sessions (work_started with no work_completed after 2h)
  and stale active-owner.json files (dead PID + older than 4h).
  Default: dry-run (report only). Add --apply to execute fixes.

  POLICY (STORE_JOURNAL_POLICY_v2):
  1. Every agent session writes work_started.
  2. Every file-changing session writes work_completed.
  3. Every compact/restart writes compact_restore event.
  4. Every sudo command writes sudo_action event.
  5. Every test run writes test_result event.
  6. Every blocked/quarantine event writes quarantine_event.
  7. Before editing, check today's journal for active ownership.
  8. If another agent owns the path, do not edit. Create a proposal.
  9. Journal is append-only. Do not rewrite old entries.
  10. Daily summary is generated from JSONL, not hand-edited.
  11. [v2] status command reads all lanes — use before starting work.
  12. [v2] snapshot is regenerated on every append — always current.`);
}

// ---------------------------------------------------------------------------
// MAIN
// ---------------------------------------------------------------------------

if (require.main === module) {
  const args = process.argv.slice(2);
  const cmd = args[0];
  if (!cmd || cmd === 'help') { cmdHelp(); process.exit(0); }
  const cmdArgs = args.slice(1);
  switch (cmd) {
    case 'append': cmdAppend(cmdArgs); break;
    case 'preflight': cmdPreflight(cmdArgs); break;
    case 'daily': cmdDaily(cmdArgs); break;
    case 'active': cmdActive(cmdArgs); break;
    case 'status': cmdStatus(cmdArgs); break;
    case 'read': cmdRead(cmdArgs); break;
    case 'snapshot': cmdSnapshot(cmdArgs); break;
    case 'autofix': cmdAutofix(cmdArgs); break;
    default:
      console.error(`ERROR: Unknown command '${cmd}'. Available: append, preflight, daily, active, help`);
      process.exit(1);
  }
}

module.exports = {
  readJournal, readAllLanesForDate, journalPath, journalDir,
  broadcastJournalDir, dailySummaryPath, validateEntry, generateId,
  buildOwnershipState, cmdStatus, cmdRead, cmdSnapshot
};
