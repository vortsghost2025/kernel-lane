#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const LANE_ROOT = path.resolve(__dirname, '..');
const SCRIPTS_DIR = path.join(LANE_ROOT, 'scripts');

const CROSS_LANE_PATTERNS = [
  /require\s*\(\s*['"]S:\/(Archivist-Agent|kernel-lane|self-organizing-library|SwarmMind)/,
  /require\s*\(\s*['"]S:\\\\(Archivist-Agent|kernel-lane|self-organizing-library|SwarmMind)/,
  /require\s*\(\s*path\.join\s*\(\s*['"]S:/,
  /import\s+.*\s+from\s+['"]S:\/(Archivist-Agent|kernel-lane|self-organizing-library|SwarmMind)/
];

const ALLOWED_CROSS_LANE_PATTERNS = [
  /ORIGIN:/,
  /LAST_SYNC:/,
  /LOCAL UTILITY:/,
  /canonical delivery path/i,
  /inbox.*path.*=/i,
  /outbox.*path.*=/i,
  /local_path.*=/i,
  /mailboxes/i
];

function scanFile(filePath) {
  const relativePath = path.relative(LANE_ROOT, filePath);
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n');
  const violations = [];

  lines.forEach((line, idx) => {
    const lineNum = idx + 1;
    const trimmed = line.trim();

    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) {
      const isAllowed = ALLOWED_CROSS_LANE_PATTERNS.some(p => p.test(trimmed));
      if (isAllowed) return;
    }

    for (const pattern of CROSS_LANE_PATTERNS) {
      if (pattern.test(line)) {
        const isComment = ALLOWED_CROSS_LANE_PATTERNS.some(p => p.test(line));
        if (!isComment) {
          violations.push({
            file: relativePath,
            line: lineNum,
            content: trimmed.substring(0, 120),
            type: 'cross_lane_require'
          });
        }
      }
    }
  });

  return violations;
}

function scanDirectory(dir) {
  let violations = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'processed') continue;

    if (entry.isDirectory()) {
      violations = violations.concat(scanDirectory(fullPath));
    } else if (entry.name.endsWith('.js') || entry.name.endsWith('.ts')) {
      violations = violations.concat(scanFile(fullPath));
    }
  }

  return violations;
}

function main() {
  const strict = process.argv.includes('--strict');
  const scriptsOnly = !process.argv.includes('--full');

  const scanDir = scriptsOnly ? SCRIPTS_DIR : LANE_ROOT;
  const violations = scanDirectory(scanDir);

  if (violations.length === 0) {
    console.log('SOVEREIGNTY CHECK: PASS - No cross-lane code import violations found.');
    if (scriptsOnly) console.log('Scanned: scripts/ only. Use --full for complete scan.');
    process.exit(0);
  }

  console.log(`SOVEREIGNTY CHECK: FAIL - ${violations.length} violation(s) found.`);
  console.log('');
  for (const v of violations) {
    console.log(`  ${v.file}:${v.line} [${v.type}] ${v.content}`);
  }
  console.log('');
  console.log('Remediation: Localize dependencies to scripts/util/ per SYSTEM_CONSTRAINTS.md');

  if (strict) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

if (require.main === module) {
  main();
}

module.exports = { scanFile, scanDirectory };
