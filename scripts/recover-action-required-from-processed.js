#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const ACTION_REQUIRED_TYPES = new Set(['task', 'escalation', 'request']);

function isActionRequiredMessage(msg) {
  const type = String(msg && msg.type ? msg.type : '').toLowerCase();
  return !!(
    (msg && msg.requires_action === true) ||
    (msg && msg.priority_action === true) ||
    ACTION_REQUIRED_TYPES.has(type)
  );
}

const LANES = {
  archivist: {
    processed: 'S:/Archivist-Agent/lanes/archivist/inbox/processed',
    actionRequired: 'S:/Archivist-Agent/lanes/archivist/inbox/action-required',
  },
  library: {
    processed: 'S:/self-organizing-library/lanes/library/inbox/processed',
    actionRequired: 'S:/self-organizing-library/lanes/library/inbox/action-required',
  },
  kernel: {
    processed: 'S:/kernel-lane/lanes/kernel/inbox/processed',
    actionRequired: 'S:/kernel-lane/lanes/kernel/inbox/action-required',
  },
  swarmmind: {
    processed: 'S:/SwarmMind/lanes/swarmmind/inbox/processed',
    actionRequired: 'S:/SwarmMind/lanes/swarmmind/inbox/action-required',
  },
};

function parseArgs() {
  const args = process.argv.slice(2);
  return {
    apply: args.includes('--apply'),
    lane: (() => {
      const idx = args.indexOf('--lane');
      if (idx >= 0 && args[idx + 1]) return args[idx + 1].toLowerCase();
      return null;
    })(),
  };
}

function safeReadJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function uniqueTargetPath(basePath) {
  if (!fs.existsSync(basePath)) return basePath;
  const dir = path.dirname(basePath);
  const ext = path.extname(basePath);
  const base = path.basename(basePath, ext);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(dir, `${base}.recovered-${stamp}${ext}`);
}

function recoverLane(laneName, cfg, apply) {
  const result = {
    lane: laneName,
    processedPath: cfg.processed,
    actionRequiredPath: cfg.actionRequired,
    scanned: 0,
    actionableFound: 0,
    moved: 0,
    files: [],
  };

  if (!fs.existsSync(cfg.processed)) {
    return result;
  }

  const files = fs.readdirSync(cfg.processed).filter((f) => f.endsWith('.json'));
  result.scanned = files.length;

  for (const filename of files) {
    const src = path.join(cfg.processed, filename);
    const msg = safeReadJson(src);
    if (!msg) continue;

    if (!isActionRequiredMessage(msg)) continue;

    result.actionableFound += 1;
    const entry = {
      file: filename,
      id: msg.id || msg.task_id || null,
      type: msg.type || null,
      priority: msg.priority || null,
      requires_action: msg.requires_action === true,
      priority_action: msg.priority_action === true,
      from: msg.from || msg.from_lane || null,
    };

    if (apply) {
      if (!fs.existsSync(cfg.actionRequired)) {
        fs.mkdirSync(cfg.actionRequired, { recursive: true });
      }
      const dest = uniqueTargetPath(path.join(cfg.actionRequired, filename));
      fs.renameSync(src, dest);
      result.moved += 1;
      entry.moved_to = dest;
    }

    result.files.push(entry);
  }

  return result;
}

(function main() {
  const { apply, lane } = parseArgs();

  const laneNames = lane ? [lane] : Object.keys(LANES);
  for (const ln of laneNames) {
    if (!LANES[ln]) {
      console.error(`Unknown lane: ${ln}`);
      process.exit(2);
    }
  }

  const summary = {
    mode: apply ? 'APPLY' : 'DRY_RUN',
    timestamp: new Date().toISOString(),
    lanes: [],
    totals: {
      scanned: 0,
      actionableFound: 0,
      moved: 0,
    },
  };

  for (const ln of laneNames) {
    const r = recoverLane(ln, LANES[ln], apply);
    summary.lanes.push(r);
    summary.totals.scanned += r.scanned;
    summary.totals.actionableFound += r.actionableFound;
    summary.totals.moved += r.moved;
  }

  console.log(JSON.stringify(summary, null, 2));

  if (!apply && summary.totals.actionableFound > 0) {
    process.exit(10);
  }
})();
