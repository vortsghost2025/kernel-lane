#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { sanitizeFilename } = require('./util/sanitize-filename');

const STALE_THRESHOLD_HOURS = 24;
const DRY_RUN = !process.argv.includes('--apply');
const LANE_ARG = (process.argv.find(function(a) { return a.startsWith('--lane='); }) || '').replace('--lane=', '') || 'archivist';

const REMEDIATION_RULES = [
  {
    name: 'duplicate-lane-worker-retry',
    match: function(filename) {
      return /\.lane-worker-\d{4}-\d{2}-\d{2}T/.test(filename);
    },
    action: 'deduplicate',
    description: 'Duplicate lane-worker retry delivery — keep newest per base message'
  },
  {
    name: 'e2e-test-artifact',
    match: function(filename) {
      return /e2e-test|signed-pipe-test|test-pipe|pipe-test/.test(filename);
    },
    action: 'archive',
    description: 'E2E test artifact older than threshold'
  },
  {
    name: 'expired-lease',
    match: function(filename, content) {
      try {
        var msg = JSON.parse(content);
        var lease = msg.lease || {};
        var expires = lease.expires_at;
        if (expires && new Date(expires).getTime() < Date.now()) {
          return true;
        }
      } catch (e) {}
      return false;
    },
    action: 'expire',
    description: 'Message with expired lease'
  },
  {
    name: 'orphaned-delivery-log',
    match: function(filename) {
      return /delivery-log|delivery-log-/.test(filename);
    },
    action: 'archive',
    description: 'Orphaned delivery log (no corresponding outbox message)'
  },
  {
    name: 'contradicts-edge',
    match: function(filename, content) {
      try {
        var msg = JSON.parse(content);
        var edgeType = String((msg.edge_type || msg.type || '')).toLowerCase();
        return edgeType === 'contradicts' || edgeType === 'contradiction';
      } catch (e) {}
      return false;
    },
    action: 'skip',
    description: 'CONTRADICTS edge — must not auto-resolve per playbook'
  },
  {
    name: 'unsigned-placeholder-signature',
    match: function(filename, content) {
      try {
        var msg = JSON.parse(content);
        var sig = String(msg.signature || '');
        return sig.indexOf('placeholder-') !== -1 || sig.indexOf('placeholder') !== -1;
      } catch (e) {}
      return false;
    },
    action: 'archive',
    description: 'Unsigned placeholder-signature message — cannot verify authenticity'
  },
  {
    name: 'legacy-schema-artifact',
    match: function(filename, content) {
      try {
        var msg = JSON.parse(content);
        var ver = String(msg.schema_version || '1.3');
        var parts = ver.split('.');
        if (parts.length >= 2) {
          var major = parseInt(parts[0], 10) || 1;
          var minor = parseInt(parts[1], 10) || 0;
          if (major < 1 || (major === 1 && minor < 3)) return true;
        }
      } catch (e) {}
      return false;
    },
    action: 'archive',
    description: 'Legacy schema version (<1.3) artifact — auto-archive to prevent processing errors'
  },
  {
    name: 'missing-artifact-path',
    match: function(filename, content) {
      try {
        var msg = JSON.parse(content);
        if (msg.requires_action === true) {
          var evidence = msg.evidence || {};
          if (!evidence.artifact_path || evidence.artifact_path === null) {
            return true;
          }
        }
      } catch (e) {}
      return false;
    },
    action: 'archive',
    description: 'Requires-action message with null artifact_path — cannot complete, archive for manual review'
  },
  {
    name: 'stale-default',
    match: function() { return true; },
    action: 'archive',
    description: 'Stale message (default — archive after threshold)'
  }
];

function ensureDir(dirPath) {
  try {
    fs.mkdirSync(dirPath, { recursive: true });
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
  }
}

function getFileAgeHours(filePath) {
  try {
    var stat = fs.statSync(filePath);
    return (Date.now() - stat.mtimeMs) / (1000 * 60 * 60);
  } catch (e) {
    return 0;
  }
}

function readJsonSafe(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    return null;
  }
}

function findMatchingRule(filename, content) {
  for (var i = 0; i < REMEDIATION_RULES.length; i++) {
    var rule = REMEDIATION_RULES[i];
    if (rule.match(filename, content)) {
      return rule;
    }
  }
  return null;
}

function getBaseMessageId(filename) {
  return filename.replace(/\.lane-worker-\d{4}-\d{2}-\d{2}T[^.]+/, '');
}

function scanDirectory(dirPath) {
  if (!fs.existsSync(dirPath)) return [];
  var entries;
  try {
    entries = fs.readdirSync(dirPath).filter(function(f) { return f.endsWith('.json'); });
  } catch (e) {
    return [];
  }
  return entries.map(function(name) {
    var fullPath = path.join(dirPath, name);
    var content = readJsonSafe(fullPath);
    var rule = findMatchingRule(name, content || '');
    var ageHours = getFileAgeHours(fullPath);
    return {
      filename: name,
      fullPath: fullPath,
      ageHours: ageHours,
      isStale: ageHours >= STALE_THRESHOLD_HOURS,
      rule: rule,
      content: content
    };
  });
}

function deduplicateLaneWorkerRetries(items) {
  var groups = {};
  items.forEach(function(item) {
    if (!(item.rule && item.rule.action === 'deduplicate')) return;
    var baseId = getBaseMessageId(item.filename);
    if (!groups[baseId]) groups[baseId] = [];
    groups[baseId].push(item);
  });
  var toRemove = [];
  Object.keys(groups).forEach(function(baseId) {
    var group = groups[baseId];
    if (group.length <= 1) return;
    group.sort(function(a, b) { return b.ageHours - a.ageHours; });
    var keepNewest = group[0];
    group.slice(1).forEach(function(item) {
      toRemove.push(item);
    });
  });
  return toRemove;
}

function remediate(laneRoot, options) {
  var laneName = options.lane || LANE_ARG;
  var inboxBase = path.join(laneRoot, 'lanes', laneName, 'inbox');
  var blockedDir = path.join(inboxBase, 'blocked');
  var quarantineDir = path.join(inboxBase, 'quarantine');
  var processedDir = path.join(inboxBase, 'processed');
  var expiredDir = path.join(inboxBase, 'expired');
  var archiveDir = path.join(inboxBase, 'archive');

  var report = {
    timestamp: new Date().toISOString(),
    lane: laneName,
    dry_run: DRY_RUN,
    before: { blocked: 0, quarantine: 0 },
    after: { blocked: 0, quarantine: 0, archived: 0, expired: 0, deduplicated: 0, skipped_contradicts: 0 },
    report_cleanup: null,
    actions: []
  };

  var blockedItems = scanDirectory(blockedDir);
  var quarantineItems = scanDirectory(quarantineDir);
  report.before.blocked = blockedItems.length;
  report.before.quarantine = quarantineItems.length;

  var allItems = blockedItems.concat(quarantineItems);
  var toDeduplicate = deduplicateLaneWorkerRetries(allItems);
  var dedupePaths = {};
  toDeduplicate.forEach(function(item) { dedupePaths[item.fullPath] = true; });

  allItems.forEach(function(item) {
    if (!item.isStale && !(dedupePaths[item.fullPath])) return;
    if (!(item.rule)) return;

    var action = item.rule.action;
    if (dedupePaths[item.fullPath]) {
      action = 'deduplicate';
    }

    if (action === 'skip') {
      report.after.skipped_contradicts++;
      report.actions.push({
        file: item.filename,
        rule: item.rule.name,
        action: 'skipped',
        reason: 'CONTRADICTS edge — manual review required'
      });
      return;
    }

    var destDir;
    if (action === 'deduplicate' || action === 'archive') {
      destDir = archiveDir;
    } else if (action === 'expire') {
      destDir = expiredDir;
    } else {
      destDir = processedDir;
    }

    var actionRecord = {
      file: item.filename,
      rule: item.rule.name,
      action: action,
      reason: item.rule.description,
      age_hours: Math.round(item.ageHours * 10) / 10,
      destination: path.basename(destDir)
    };

    if (!DRY_RUN) {
      ensureDir(destDir);
      var destPath = path.join(destDir, item.filename);
      var counter = 0;
      while (fs.existsSync(destPath) && counter < 100) {
        counter++;
        destPath = path.join(destDir, item.filename.replace('.json', '-' + counter + '.json'));
      }
      try {
        fs.renameSync(item.fullPath, destPath);
      } catch (e) {
        actionRecord.error = e.message;
      }
    }

    if (action === 'deduplicate') report.after.deduplicated++;
    else if (action === 'expire') report.after.expired++;
    else report.after.archived++;

    report.actions.push(actionRecord);
  });

  var remainingBlocked = scanDirectory(blockedDir);
  var remainingQuarantine = scanDirectory(quarantineDir);
  report.after.blocked = remainingBlocked.length;
  report.after.quarantine = remainingQuarantine.length;

  return report;
}

function cleanupOldReports(repoRoot, maxAgeHours) {
  if (typeof maxAgeHours === 'undefined') maxAgeHours = 168; // 7 days default
  var reportDir = path.join(repoRoot, 'context-buffer');
  if (!fs.existsSync(reportDir)) return { cleaned: 0, kept: 0 };

  var now = Date.now();
  var cleaned = 0;
  var kept = 0;
  try {
    var files = fs.readdirSync(reportDir).filter(function(f) {
      return f.startsWith('blocked-remediation-report-') && f.endsWith('.json');
    });
    for (var i = 0; i < files.length; i++) {
      var fullPath = path.join(reportDir, files[i]);
      try {
        var stat = fs.statSync(fullPath);
        var ageHours = (now - stat.mtimeMs) / (1000 * 60 * 60);
        if (ageHours >= maxAgeHours) {
          if (!DRY_RUN) {
            fs.unlinkSync(fullPath);
          }
          cleaned++;
        } else {
          kept++;
        }
      } catch (e) {}
    }
  } catch (e) {}

  return { cleaned: cleaned, kept: kept, max_age_hours: maxAgeHours };
}

function main() {
   var repoRoot = path.resolve(__dirname, '..');
   var laneDiscoveryPath = path.join(repoRoot, '.global', 'lane-discovery.js');
   var laneRoot = repoRoot;

   if (fs.existsSync(laneDiscoveryPath)) {
     try {
       var LaneDiscovery = require(laneDiscoveryPath).LaneDiscovery;
       var discovery = new LaneDiscovery();
       laneRoot = discovery.getLocalPath(LANE_ARG) || repoRoot;
     } catch (e) {}
   }

   var report = remediate(laneRoot, { lane: LANE_ARG });

   console.log(JSON.stringify(report, null, 2));

   if (!DRY_RUN) {
     // Cleanup old remediation reports (default: older than 7 days)
     var cleanupResult = cleanupOldReports(repoRoot);
     report.report_cleanup = cleanupResult;

     var reportDir = path.join(repoRoot, 'context-buffer');
     ensureDir(reportDir);
     var reportPath = path.join(reportDir, 'blocked-remediation-report-' + sanitizeFilename(new Date().toISOString()) + '.json');
     fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
     console.error('[blocked-remediator] Report written to: ' + reportPath);
   }
}

main();
