#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const LANE_ROOT = path.resolve(__dirname, '..');
const SCRIPTS_DIR = path.join(LANE_ROOT, 'scripts');
const LANE_ID = 'kernel';

const CROSS_LANE_INDICATORS = [
  // Require statements importing from other lanes (actual code imports)
  /require\s*\(\s*['"]S:\/(archivist|self-organizing-library|SwarmMind)/,
  // Import statements importing from other lanes (actual code imports)
  /import\s+.*\s+from\s+['"]S:\/(archivist|self-organizing-library|SwarmMind)/
];

const COMMENT_PATTERNS = [
  /^\/\//,
  /^\s*\*/,
  /\/\*/,
  /ORIGIN:/,
  /LAST_SYNC:/,
  /LOCAL UTILITY:/,
  /canonical/i,
  // Self-reference allowed
  /(?:'|")S:\/kernel-lane/,
  /(?:'|")S:\\kernel-lane/
];

function isCommentOrAllowed(line) {
  for (const p of COMMENT_PATTERNS) {
    if (p.test(line)) return true;
  }
  return false;
}

function hasCrossLaneIndicator(line) {
  for (const p of CROSS_LANE_INDICATORS) {
    if (p.test(line)) return true;
  }
  return false;
}

function scanFile(filePath) {
  const relativePath = path.relative(LANE_ROOT, filePath);
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n');
  const violations = [];

  let inRequirePathJoin = false;
  let requireLineNum = 0;
  let requireLines = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;
    const trimmed = line.trim();

    if (/require\s*\(\s*path\.join\s*\(/.test(line) && !isCommentOrAllowed(line)) {
      inRequirePathJoin = true;
      requireLineNum = lineNum;
      requireLines = [line];
      continue;
    }

    if (inRequirePathJoin) {
      requireLines.push(line);
      const fullBlock = requireLines.join('\n');
      const opens = (fullBlock.match(/\(/g) || []).length;
      const closes = (fullBlock.match(/\)/g) || []).length;
      if (closes >= opens) {
        if (hasCrossLaneIndicator(fullBlock)) {
          violations.push({
            file: relativePath,
            line: requireLineNum,
            content: requireLines[0].substring(0, 140),
            type: 'cross_lane_require_path_join',
            context: requireLines.length > 1 ? 'multi-line require' : null
          });
        }
        inRequirePathJoin = false;
        requireLines = [];
      }
      continue;
    }

    if (isCommentOrAllowed(line)) continue;

    if (hasCrossLaneIndicator(line)) {
      violations.push({
        file: relativePath,
        line: lineNum,
        content: trimmed.substring(0, 140),
        type: 'cross_lane_import'
      });
    }
  }

  return violations;
}

function scanDirectory(dir, excludedDirs = new Set(['node_modules', '.git', 'processed', 'quarantine', 'expired'])) {
  let violations = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    if (excludedDirs.has(entry.name)) continue;
    // Skip the sovereignty enforcer itself
    if (entry.name === 'sovereignty-enforcer.js') continue;

    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      violations = violations.concat(scanDirectory(fullPath, excludedDirs));
    } else if (entry.name.endsWith('.js') || entry.name.endsWith('.ts')) {
      violations = violations.concat(scanFile(fullPath));
    }
  }

  return violations;
}

function generateReport(violations) {
  const timestamp = new Date().toISOString();
  const reportDir = path.join(LANE_ROOT, 'lanes', 'kernel', 'state');
  if (!fs.existsSync(reportDir)) {
    fs.mkdirSync(reportDir, { recursive: true });
  }

  const report = {
    lane_id: LANE_ID,
    timestamp,
    scan_scope: 'scripts/',
    total_violations: violations.length,
    violations: violations.map(v => ({
      file: v.file,
      line: v.line,
      snippet: v.content,
      type: v.type,
      severity: 'blocking'
    })),
    summary: { blocking: violations.length, warnings: 0, info: 0 },
    enforcement: { pre_commit_hook: true, block_on_violation: true, strict_mode: true },
    recommendations: [
      'Move cross-lane dependencies to local scripts/util/ implementations',
      'Replace absolute paths with relative local imports',
      'Document utility origins with ORIGIN: comments',
      'Run: node scripts/sovereignty-enforcer.js to verify'
    ]
  };

  const safeTime = timestamp.replace(/[:]/g, '-');
  const reportPath = path.join(reportDir, `sovereignty-report-${safeTime}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');

  const latestPath = path.join(reportDir, 'sovereignty-report-latest.json');
  fs.writeFileSync(latestPath, JSON.stringify(report, null, 2), 'utf8');

  return reportPath;
}

function main() {
  console.log(`[${LANE_ID}] Cross-Lane Sovereignty Scanner`);
  console.log(` Scanning: ${SCRIPTS_DIR}`);
  console.log(` Lane Root: ${LANE_ROOT}`);
  console.log('');

  const violations = scanDirectory(SCRIPTS_DIR);
  const reportPath = generateReport(violations);

  if (violations.length === 0) {
    console.log(`[${LANE_ID}] ✅ SOVEREIGNTY CHECK PASSED`);
    console.log(` No cross-lane import violations found in scripts/.`);
    console.log(` Report: ${reportPath}`);
    process.exit(0);
  } else {
    console.log(`[${LANE_ID}] ❌ SOVEREIGNTY CHECK FAILED`);
    console.log(` ${violations.length} violation(s) detected:`);
    console.log('');
    violations.forEach((v, i) => {
      console.log(`  ${i + 1}. ${v.file}:${v.line} ${v.type}`);
      console.log(`     ${v.content}`);
    });
    console.log('');
    console.log(` Report: ${reportPath}`);
    console.log(' REMEDIATION: Fix cross-lane dependencies before committing.');
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { scanFile, scanDirectory };
