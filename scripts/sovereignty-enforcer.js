/**
 * SOVEREIGNTY ENFORCEMENT SCANNER — Kernel Lane
 * Purpose: Auto-detect and prevent cross-lane imports
 * Rule: NO CROSS-LANE require() OR hardcoded paths
 *
 * ORIGIN: S:/SwarmMind/scripts/sovereignty-enforcer.js (fine-tuned version)
 * ADAPTED_FOR: Kernel lane (CURRENT_LANE = 'Kernel')
 * Last Updated: 2026-05-02
 */

const fs = require('fs');
const path = require('path');

const { LaneDiscovery } = require('./util/lane-discovery');
const _discovery = new LaneDiscovery();

const LANE_ID_MAP = {
  'Archivist': 'archivist',
  'Kernel': 'kernel',
  'Library': 'library',
  'SwarmMind': 'swarmmind'
};

const LANES = {};
for (const [pascalKey, laneId] of Object.entries(LANE_ID_MAP)) {
  LANES[pascalKey] = _discovery.getLocalPath(laneId);
}

const CURRENT_LANE = 'Kernel';
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

const ALLOWED_PATTERNS = [
  /^\.\.?\//,
  /^node_modules\//,
  /^\//,
  /^util\//,
  /^\.global\//
];

function isLocalPath(importPath) {
  return ALLOWED_PATTERNS.some(pattern => pattern.test(importPath));
}

function isInCommentOrString(line, index) {
  let inString = null;
  let inBlockComment = false;

  for (let i = 0; i < line.length; i++) {
    if (inBlockComment) {
      if (i + 1 < line.length && line[i] === '*' && line[i + 1] === '/') {
        inBlockComment = false;
        i++;
      }
      continue;
    }

    if (i + 1 < line.length && line[i] === '/' && line[i + 1] === '*') {
      inBlockComment = true;
      i++;
      continue;
    }

    if (i + 1 < line.length && line[i] === '/' && line[i + 1] === '/') {
      return { isComment: true, isString: false };
    }

    if ((line[i] === '"' || line[i] === "'" || line[i] === '`') &&
        (i === 0 || line[i - 1] !== '\\')) {
      if (inString === null) {
        inString = line[i];
      } else if (inString === line[i]) {
        inString = null;
      }
    }
  }

  return { isComment: false, isString: inString !== null };
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

function scanDirectory(dirPath, baseDir) {
  const violations = [];
  const files = fs.readdirSync(dirPath);

  files.forEach(file => {
    const fullPath = path.join(dirPath, file);
    const stat = fs.statSync(fullPath);

    if (stat.isDirectory()) {
      if (file !== 'node_modules' && !file.startsWith('.') && file !== '.git') {
        violations.push(...scanDirectory(fullPath, baseDir));
      }
    } else if (file.endsWith('.js')) {
      const content = fs.readFileSync(fullPath, 'utf8');
      const fileViolations = checkForCrossLaneViolation(content, fullPath);

      if (fileViolations.length > 0) {
        violations.push({
          file: path.relative(baseDir, fullPath),
          violations: fileViolations
        });
      }
    }
  });

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
 console.log(`🔍 Scanning ${resolvedName} lane...`);

 const scriptsDir = path.join(LANES[resolvedName], 'scripts');

  if (!fs.existsSync(scriptsDir)) {
    console.log(` ❌ No scripts directory in ${laneName}\n`);
    return [];
  }

  const violations = scanDirectory(scriptsDir, LANES[laneName]);

  if (violations.length === 0) {
    console.log(` ✅ SOVEREIGN - No violations`);
  } else {
    console.log(` ⚠️ ${violations.length} file(s) with violations:`);
    violations.forEach(v => {
      console.log(` - ${v.file}`);
      v.violations.forEach(viol => {
        console.log(` Line ${viol.line}: ${viol.type}`);
        console.log(` ${viol.code.substring(0, 80)}...`);
      });
    });
  }

  console.log('');
  return violations;
}

function generateReport(allViolations) {
  const report = {
    timestamp: new Date().toISOString(),
    scanner: 'sovereignty-enforcer',
    rule: 'NO_CROSS_LANE_REQUIRE',
    total_violations: allViolations.reduce((sum, v) => sum + v.violations.length, 0),
    lanes_scanned: Object.keys(LANES).length,
    violations: allViolations,
    summary: {}
  };

  Object.keys(LANES).forEach(lane => {
    const laneViolations = allViolations.filter(v =>
      v.file.includes(lane.toLowerCase()) ||
      path.join(LANES[lane], 'scripts') === path.dirname(v.file)
    );
    report.summary[lane] = laneViolations.length;
  });

  return report;
}

const args = process.argv.slice(2);
const targetLane = args.includes('--lane') ? args[args.indexOf('--lane') + 1] : null;
const shouldExitOnError = args.includes('--strict');

console.log('═══════════════════════════════════════════════════════════════');
console.log(' SOVEREIGNTY ENFORCEMENT SCANNER');
console.log(' Rule: NO CROSS-LANE require() OR hardcoded paths');
console.log('═══════════════════════════════════════════════════════════════\n');

const allViolations = [];

const lanesToScan = targetLane ? [resolveLaneName(targetLane)] : Object.keys(LANES);
lanesToScan.forEach(lane => {
 const violations = scanLane(lane);
 allViolations.push(...violations.map(v => ({
  lane,
  file: path.join(LANES[resolveLaneName(lane)], 'scripts', v.file),
    violations: v.violations
  })));
});

const report = generateReport(allViolations);

console.log('═══════════════════════════════════════════════════════════════');
console.log(' RESULTS');
console.log('═══════════════════════════════════════════════════════════════\n');

if (report.total_violations === 0) {
  console.log('✅ ALL LANES SOVEREIGN - NO VIOLATIONS FOUND');
} else {
  console.log(`⚠️ ${report.total_violations} VIOLATION(S) FOUND\n`);
  console.log('By lane:');
  Object.keys(report.summary).forEach(lane => {
    console.log(` ${lane}: ${report.summary[lane]}`);
  });
}

console.log('\n═══════════════════════════════════════════════════════════════\n');

const reportDir = path.join(CURRENT_ROOT, 'lanes', 'kernel', 'state');
if (!fs.existsSync(reportDir)) {
  fs.mkdirSync(reportDir, { recursive: true });
}
const reportPath = path.join(reportDir, 'sovereignty-report-latest.json');
fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
console.log(`📄 Report saved: ${reportPath}\n`);

if (shouldExitOnError) {
  process.exit(report.total_violations > 0 ? 1 : 0);
}

module.exports = { scanLane, checkForCrossLaneViolation, generateReport };
