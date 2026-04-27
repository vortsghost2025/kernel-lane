#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TRUTH_CRITICAL_FILES = [
  'scripts/lane-worker.js',
  'scripts/verification-domain-gate.js',
  'scripts/validate-responses.js',
  'scripts/completion-proof.js',
];

function getCodeVersionHash(repoRoot) {
  const root = repoRoot || path.resolve(__dirname, '..');
  const hash = crypto.createHash('sha256');
  for (const rel of TRUTH_CRITICAL_FILES) {
    const full = path.join(root, rel);
    if (!fs.existsSync(full)) continue;
    hash.update(rel);
    hash.update('\n');
    hash.update(fs.readFileSync(full));
    hash.update('\n');
  }
  return `sha256:${hash.digest('hex')}`;
}

module.exports = { getCodeVersionHash, TRUTH_CRITICAL_FILES };

if (require.main === module) {
  console.log(getCodeVersionHash(path.resolve(__dirname, '..')));
}

