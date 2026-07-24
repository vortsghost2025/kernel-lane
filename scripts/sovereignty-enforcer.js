#!/usr/bin/env node
'use strict';

/**
 * SOVEREIGNTY ENFORCEMENT SCANNER (Fine-Tuned)
 * Purpose: Auto-detect and prevent cross-lane require() imports
 * Rule: NO CROSS-LANE require() — only flag actual require() calls, not string literals
 *
 * ORIGIN: S:/SwarmMind/scripts/sovereignty-enforcer.js
 * LOCALIZED: 2026-05-02
 * Key fix: Replaced broad regex-based scanner that flagged path strings in config
 * objects (116 false positives) with require()-only detection.
 */

const fs = require('fs');
const path = require('path');

const { getRoots } = require('./util/lane-discovery');

const LANES = {
  'Archivist': getRoots()['archivist'],
  'Kernel': getRoots()['kernel'],
  'Library': getRoots()['library'],
  'SwarmMind': getRoots()['swarmmind']
};

const CURRENT_LANE = 'Archivist';
const CURRENT_ROOT = LANES[CURRENT_LANE];

if (process.platform !== 'win32') {
  for (const [name, p] of Object.entries(LANES)) {
    if (/^[A-Za-z]:[\\/]/.test(p)) {
      console.error(`[sovereignty] FATAL: Windows path leak on ${process.platform}: ${name}=${p}`);
      process.exit(1);
    }
  }
}

if (process.platform !== 'win32') {
  for (const [name, p] of Object.entries(LANES)) {
    if (/^[A-Za-z]:[\\/]/.test(p)) {
      console.error(`[sovereignty] FATAL: Windows path leak on ${process.platform}: ${name}=${p}`);
      process.exit(1);
    }
  }
}

function checkForCrossLaneViolation(content, filePath) {
  const violations = [];
  const lines = content.split('\n');

  lines.forEach((line, idx) => {
    const lineNum = idx + 1;

    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('/*')) {
      return;
    }

    const requireMatch = line.match(/require\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/);

    if (requireMatch) {
      const importPath = requireMatch[1];

      Object.keys(LANES).forEach(laneName => {
        if (laneName === CURRENT_LANE) return;

        const lanePath = LANES[laneName];

        if (importPath.startsWith(lanePath)) {
          violations.push({
            line: lineNum,
            code: line.trim(),
            violation: `Cross-lane import from ${laneName}`,
            type: 'cross_lane_require'
          });
        }
      });
    }
  });

  return violations;
}

function scanDirectory(dirPath, baseDir, excludedDirs = new Set(['node_modules', '.git', 'processed', 'quarantine', 'expired'])) {
  const violations = [];
  let entries;
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch (e) {
    return violations;
  }

  for (const entry of entries) {
    if (excludedDirs.has(entry.name)) continue;
    if (entry.name === 'sovereignty-enforcer.js') continue;

    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      violations.push(...scanDirectory(fullPath, baseDir, excludedDirs));
    } else if (entry.name.endsWith('.js') || entry.name.endsWith('.ts')) {
      const content = fs.readFileSync(fullPath, 'utf8');
      const fileViolations = checkForCrossLaneViolation(content, fullPath);

      if (fileViolations.length > 0) {
        violations.push({
          file: path.relative(baseDir, fullPath),
          violations: fileViolations
        });
      }
    }
  }

  return violations;
}

function resolveLaneName(input) {
 const lower = input.toLowerCase();
 for (const key of Object.keys(LANES)) {
  if (key.toLowerCase() === lower) return key;
 }
 return input;
}

function scanLane(laneName) {
 const resolvedName = resolveLaneName(laneName);
 console.log(`[archivist] Scanning ${resolvedName} lane scripts...`);

 const scriptsDir = path.join(LANES[resolvedName], 'scripts');

  if (!fs.existsSync(scriptsDir)) {
    console.log(`  No scripts directory in ${laneName}`);
    return [];
  }

  const violations = scanDirectory(scriptsDir, LANES[laneName]);

  if (violations.length === 0) {
    console.log(`  SOVEREIGN - No violations`);
  } else {
    console.log(`  ${violations.length} file(s) with violations:`);
    violations.forEach(v => {
      console.log(`  - ${v.file}`);
      v.violations.forEach(viol => {
        console.log(`    Line ${viol.line}: ${viol.type}`);
        console.log(`    ${viol.code.substring(0, 80)}`);
      });
    });
  }

  console.log('');
  return violations;
}

function generateReport(allViolations) {
  const timestamp = new Date().toISOString();
  const report = {
    lane_id: 'archivist',
    timestamp,
    scanner: 'sovereignty-enforcer-fine-tuned',
    rule: 'NO_CROSS_LANE_REQUIRE',
    total_violations: allViolations.reduce((sum, v) => sum + v.violations.length, 0),
    violations: allViolations,
    summary: {},
    enforcement: {
      pre_commit_hook: true,
      block_on_violation: true,
      strict_mode: true
    },
    recommendations: [
      'Move cross-lane dependencies to local scripts/util/ implementations',
      'Replace absolute paths with relative local imports',
      'Document utility origins with ORIGIN: comments',
      'Run: node scripts/sovereignty-enforcer.js --lane Archivist --strict'
    ]
  };

  const reportDir = path.join(LANES['Archivist'], 'lanes', 'archivist', 'state');
  if (!fs.existsSync(reportDir)) {
    fs.mkdirSync(reportDir, { recursive: true });
  }

  const safeTime = timestamp.replace(/[:]/g, '-');
  const reportPath = path.join(reportDir, `sovereignty-report-${safeTime}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');

  const latestPath = path.join(reportDir, 'sovereignty-report-latest.json');
  fs.writeFileSync(latestPath, JSON.stringify(report, null, 2), 'utf8');

  return reportPath;
}

const args = process.argv.slice(2);
const targetLane = args.includes('--lane') ? args[args.indexOf('--lane') + 1] : null;
const shouldExitOnError = args.includes('--strict');

console.log('═══════════════════════════════════════════════════════════════');
console.log(' ARCHIVIST SOVEREIGNTY ENFORCEMENT SCANNER (Fine-Tuned)');
console.log(' Rule: NO CROSS-LANE require() — string literals allowed');
console.log('═══════════════════════════════════════════════════════════════\n');

const allViolations = [];

const lanesToScan = targetLane ? [resolveLaneName(targetLane)] : ['Archivist'];
lanesToScan.forEach(lane => {
 const violations = scanLane(lane);
 allViolations.push(...violations.map(v => ({
  lane,
  file: path.join(LANES[resolveLaneName(lane)], 'scripts', v.file),
    violations: v.violations
  })));
});

const reportPath = generateReport(allViolations);

console.log('═══════════════════════════════════════════════════════════════');
console.log(' RESULTS');
console.log('═══════════════════════════════════════════════════════════════\n');

const totalViolations = allViolations.reduce((sum, v) => sum + v.violations.length, 0);

if (totalViolations === 0) {
  console.log('[archivist] SOVEREIGNTY CHECK PASSED');
  console.log(`  No cross-lane require() violations found.`);
  console.log(`  Report: ${reportPath}`);
  process.exit(0);
} else {
  console.log(`[archivist] SOVEREIGNTY CHECK FAILED`);
  console.log(`  ${totalViolations} violation(s) detected:`);
  console.log('');
  allViolations.forEach(v => {
    v.violations.forEach(viol => {
      console.log(`  ${v.file}:${viol.line} ${viol.type}`);
      console.log(`    ${viol.code.substring(0, 100)}`);
    });
  });
  console.log('');
  console.log(`  Report: ${reportPath}`);
  console.log('');
  console.log('  REMEDIATION:');
  console.log('    1. Replace cross-lane require() with local util/ implementations');
  console.log('    2. Do NOT commit until all violations are resolved');
  console.log('    3. See SYSTEM_CONSTRAINTS.md for sovereignty rules');
}

console.log('\n═══════════════════════════════════════════════════════════════\n');

if (shouldExitOnError) {
  process.exit(totalViolations > 0 ? 1 : 0);
}
