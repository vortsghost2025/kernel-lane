#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..');

function buildStatePackage() {
  const pkg = {
    generated_at: new Date().toISOString(),
    archivist_state: {},
    lane_states: {},
    pending_tasks: [],
    questions_for_copilot: [],
  };

  // Archivist state
  try {
    const ss = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'lanes', 'broadcast', 'system_state.json'), 'utf8'));
    pkg.archivist_state.system_status = ss.system_status;
    pkg.archivist_state.contradictions = ss.active_contradictions?.length || 0;
    pkg.archivist_state.compaction_enabled = ss.compaction_enabled;
  } catch (_) {}

  // Per-lane state
  const lanes = ['kernel', 'library', 'swarmmind'];
  const laneRoots = {
    kernel: 'S:/kernel-lane',
    library: 'S:/self-organizing-library',
    swarmmind: 'S:/SwarmMind',
  };

  for (const lane of lanes) {
    const root = laneRoots[lane];
    pkg.lane_states[lane] = { last_commit: null, processed: 0, quarantine: 0, action_required: 0, outbox: 0 };

    try {
      const log = execSync('git log --oneline -1', { cwd: root, encoding: 'utf8' }).trim();
      pkg.lane_states[lane].last_commit = log;
    } catch (_) {}

    const inboxDir = path.join(root, 'lanes', lane, 'inbox');
    for (const subdir of ['processed', 'quarantine', 'action-required']) {
      const d = path.join(inboxDir, subdir);
      try {
        pkg.lane_states[lane][subdir.replace('-', '_')] = fs.readdirSync(d).filter(f => f.endsWith('.json') && !f.startsWith('heartbeat')).length;
      } catch (_) {}
    }

    const outboxDir = path.join(root, 'lanes', lane, 'outbox');
    try {
      pkg.lane_states[lane].outbox = fs.readdirSync(outboxDir).filter(f => f.endsWith('.json')).length;
    } catch (_) {}
  }

  // Pending outgoing tasks from Archivist outbox
  const outboxDir = path.join(REPO_ROOT, 'lanes', 'archivist', 'outbox');
  try {
    const files = fs.readdirSync(outboxDir).filter(f => f.endsWith('.json'));
    for (const f of files) {
      try {
        const msg = JSON.parse(fs.readFileSync(path.join(outboxDir, f), 'utf8'));
        pkg.pending_tasks.push({
          task_id: msg.task_id,
          to: msg.to,
          subject: msg.subject,
          priority: msg.priority,
          dispatched: msg.timestamp,
        });
      } catch (_) {}
    }
  } catch (_) {}

  pkg.copilot_query = [];

  return pkg;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const queries = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-q' || args[i] === '--query') {
      queries.push(args[++i]);
    }
  }

  const pkg = buildStatePackage();
  pkg.copilot_query = queries;

  const outputDir = path.join(REPO_ROOT, 'context-buffer');
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
  const outPath = path.join(outputDir, 'copilot-state-package.json');
  fs.writeFileSync(outPath, JSON.stringify(pkg, null, 2), 'utf8');
  console.log(JSON.stringify(pkg, null, 2));
  console.error(`\nWritten to: ${outPath}`);
}

module.exports = { buildStatePackage };
