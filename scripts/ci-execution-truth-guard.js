#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const ACTIONABLE_TYPES = new Set(['task', 'escalation', 'request']);
const LANE_ROOTS = {
  archivist: 'S:/Archivist-Agent',
  kernel: 'S:/kernel-lane',
  library: 'S:/self-organizing-library',
  swarmmind: 'S:/SwarmMind',
};

function parseArgs(argv) {
  const out = { allLanes: false, lane: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--all-lanes') out.allLanes = true;
    if (a === '--lane' && argv[i + 1]) {
      out.lane = String(argv[i + 1]).toLowerCase();
      i += 1;
    }
  }
  return out;
}

function guessLane(repoRoot) {
  const lower = String(repoRoot || '').toLowerCase();
  if (lower.includes('archivist-agent')) return 'archivist';
  if (lower.includes('kernel-lane')) return 'kernel';
  if (lower.includes('self-organizing-library')) return 'library';
  if (lower.includes('swarmmind')) return 'swarmmind';
  return 'archivist';
}

function safeReadJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return null;
  }
}

function isActionable(msg) {
  const type = String(msg && msg.type ? msg.type : '').toLowerCase();
  return !!(
    (msg && msg.requires_action === true) ||
    (msg && msg.priority_action === true) ||
    ACTIONABLE_TYPES.has(type)
  );
}

function collectViolationsForLane(lane) {
  const root = LANE_ROOTS[lane];
  const processedDir = path.join(root, 'lanes', lane, 'inbox', 'processed');
  const laneResult = {
    lane,
    processed_dir: processedDir,
    scanned: 0,
    violations: [],
  };

  if (!fs.existsSync(processedDir)) {
    laneResult.violations.push({
      code: 'PROCESSED_DIR_MISSING',
      path: processedDir,
      message: 'Processed directory missing',
    });
    return laneResult;
  }

  const files = fs.readdirSync(processedDir).filter((f) => f.endsWith('.json'));
  laneResult.scanned = files.length;

  for (const filename of files) {
    const fullPath = path.join(processedDir, filename);
    const msg = safeReadJson(fullPath);
    if (!msg) {
      laneResult.violations.push({
        code: 'INVALID_JSON',
        path: fullPath,
        message: 'Invalid JSON in processed/',
      });
      continue;
    }

    // Rule 1: fail if any processed message has execution_verified=false
    if (msg.execution_verified === false) {
      laneResult.violations.push({
        code: 'EXECUTION_FALSE_IN_PROCESSED',
        path: fullPath,
        message: 'Processed message has execution_verified=false',
      });
    }

    // Rule 2: fail if processed actionable message lacks execution_verification
    if (isActionable(msg) && (!msg.execution_verification || typeof msg.execution_verification !== 'object')) {
      laneResult.violations.push({
        code: 'ACTIONABLE_MISSING_EXECUTION_VERIFICATION',
        path: fullPath,
        message: 'Processed actionable message missing execution_verification',
      });
    }

    // Rule 3: fail if DRY_RUN_SKIP_REF_CHECK reason appears in processed
    const reason = String(
      (msg.execution_verification && msg.execution_verification.reason) ||
      (msg._lane_worker && msg._lane_worker.detail) ||
      msg.reason ||
      ''
    );
    if (reason.includes('DRY_RUN_SKIP_REF_CHECK')) {
      laneResult.violations.push({
        code: 'DRY_RUN_REF_REASON_IN_PROCESSED',
        path: fullPath,
        message: 'Processed message includes DRY_RUN_SKIP_REF_CHECK reason',
      });
    }
  }

  return laneResult;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = path.resolve(__dirname, '..');
  const inferredLane = guessLane(repoRoot);

  let lanes = [];
  if (args.allLanes) {
    lanes = ['archivist', 'kernel', 'library', 'swarmmind'];
  } else if (args.lane) {
    lanes = [args.lane];
  } else {
    lanes = [inferredLane];
  }

  const summary = {
    timestamp: new Date().toISOString(),
    lanes: [],
    totals: {
      scanned: 0,
      violations: 0,
    },
  };

  for (const lane of lanes) {
    if (!LANE_ROOTS[lane]) {
      console.error(`Unknown lane: ${lane}`);
      process.exit(2);
    }
    const laneResult = collectViolationsForLane(lane);
    summary.lanes.push(laneResult);
    summary.totals.scanned += laneResult.scanned;
    summary.totals.violations += laneResult.violations.length;
  }

  console.log(JSON.stringify(summary, null, 2));
  if (summary.totals.violations > 0) {
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

