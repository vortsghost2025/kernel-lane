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

try {
  LaneDiscovery = require('./util/lane-discovery').LaneDiscovery;
  discovery = new LaneDiscovery();
  const lanes = discovery.getLaneNames();
  for (const lane of lanes) {
    LANE_ROOTS[lane] = discovery.getLocalPath(lane);
  }
} catch (e) {
  const repoRoot = path.resolve(__dirname, '..');
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
    throw new Error(`Unknown lane: '${lane}'. Known: ${KNOWN_LANES.join(', ')}`);
  }
  return path.join(repoRoot(), 'lanes', lane, 'journal');
}

function broadcastJournalDir() {
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
  const dateStr = todayISO();
  const allLanes = readAllLanesForDate(dateStr);
  const hoursBack = parseInt(getArg(args, '--hours') || '24', 10);
  const cutoff = new Date(Date.now() - hoursBack * 3600000).toISOString();

  const status = {
    generated_at: utcISO(),
    date: dateStr,
    hours_back: hoursBack,
    lanes: {}
  };

  for (const [lane, entries] of Object.entries(allLanes)) {
    const recent = entries.filter(e => e.timestamp >= cutoff);
    const completedIds = new Set(recent.filter(e => e.event === 'work_completed').map(e => e.session_id));
    const inProgress = recent.filter(e => e.event === 'work_started' && !completedIds.has(e.session_id));
    const ownershipState = buildOwnershipState(recent, lane);
    const activeOwners = Object.entries(ownershipState).filter(([, s]) => s.is_active).map(([key, s]) => ({ path: key, owner: s.owner_agent, reason: s.reason, expires_at: s.expires_at }));
    const filesChanged = [...new Set(recent.flatMap(e => e.files_changed || []))];
    const lastEntry = recent.length > 0 ? recent[recent.length - 1] : null;

    status.lanes[lane] = {
      entries_today: recent.length,
      in_progress_sessions: inProgress.map(e => ({ agent: e.agent, session_id: e.session_id, target: e.target, started_at: e.timestamp })),
      active_ownerships: activeOwners,
      files_changed: filesChanged,
      last_activity: lastEntry ? lastEntry.timestamp : null,
      last_event: lastEntry ? lastEntry.event : null,
      last_agent: lastEntry ? lastEntry.agent : null
    };
  }

  console.log(JSON.stringify(status, null, 2));
}

// ---------------------------------------------------------------------------
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
      last_activity: lastEntry ? { timestamp: lastEntry.timestamp, event: lastEntry.event, agent: lastEntry.agent } : null
    };
  }

  const dir = broadcastJournalDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const fp = path.join(dir, 'SNAPSHOT.json');
  fs.writeFileSync(fp, JSON.stringify(snapshot, null, 2), 'utf8');
  console.log(JSON.stringify({ status: 'written', path: fp, generated_at: snapshot.generated_at }, null, 2));
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
