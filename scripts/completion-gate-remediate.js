#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const LANES = {
  archivist: { actionRequired: 'S:/Archivist-Agent/lanes/archivist/inbox/action-required' },
  kernel: { actionRequired: 'S:/kernel-lane/lanes/kernel/inbox/action-required' },
  library: { actionRequired: 'S:/self-organizing-library/lanes/library/inbox/action-required' },
  swarmmind: { actionRequired: 'S:/SwarmMind/lanes/swarmmind/inbox/action-required' },
};

function safeReadJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function parseArgs() {
  var args = process.argv.slice(2);
  return {
    apply: args.includes('--apply'),
    lane: (function () {
      var idx = args.indexOf('--lane');
      if (idx >= 0 && args[idx + 1]) return args[idx + 1].toLowerCase();
      return null;
    })(),
  };
}

function remediateLane(laneName, cfg, apply) {
  var result = { lane: laneName, scanned: 0, remediated: 0, skipped: 0, already_ok: 0 };

  if (!fs.existsSync(cfg.actionRequired)) {
    return result;
  }

  var files = fs.readdirSync(cfg.actionRequired).filter(function (f) { return f.endsWith('.json'); });
  result.scanned = files.length;

  for (var i = 0; i < files.length; i++) {
    var src = path.join(cfg.actionRequired, files[i]);
    var msg = safeReadJson(src);
    if (!msg) { result.skipped++; continue; }

    if (msg.terminal_decision) {
      result.already_ok++;
      continue;
    }

    if (apply) {
      msg.terminal_decision = 'retroactive_disposition';
      msg.terminal_decision_at = new Date().toISOString();
      msg.terminal_decision_reason = 'Completion Gate remediation: informational message with non-terminal type stamped as retroactively terminal';
      fs.writeFileSync(src, JSON.stringify(msg, null, 2) + '\n', 'utf8');
      result.remediated++;
    } else {
      result.remediated++;
    }
  }

  return result;
}

(function main() {
  var args = parseArgs();
  var laneNames = args.lane ? [args.lane] : Object.keys(LANES);

  var summary = {
    mode: args.apply ? 'APPLY' : 'DRY_RUN',
    timestamp: new Date().toISOString(),
    lanes: [],
    totals: { scanned: 0, remediated: 0, skipped: 0, already_ok: 0 },
  };

  for (var i = 0; i < laneNames.length; i++) {
    var ln = laneNames[i];
    if (!LANES[ln]) { console.error('Unknown lane: ' + ln); process.exit(2); }
    var r = remediateLane(ln, LANES[ln], args.apply);
    summary.lanes.push(r);
    summary.totals.scanned += r.scanned;
    summary.totals.remediated += r.remediated;
    summary.totals.skipped += r.skipped;
    summary.totals.already_ok += r.already_ok;
  }

  console.log(JSON.stringify(summary, null, 2));
})();
