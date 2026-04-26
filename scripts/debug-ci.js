#!/usr/bin/env node
'use strict';

const { execSync } = require('child_process');
const fs = require('fs');

const lanes = ['archivist', 'kernel', 'library', 'swarmmind'];
const results = {};

for (const lane of lanes) {
  try {
    const out = execSync(`node scripts/ci-integration-check.js ${lane}`, {
      cwd: 'S:/Archivist-Agent',
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    });
    const data = JSON.parse(out);
    results[lane] = data.lanes[lane] || { ok: false, error: 'NO_DATA' };
  } catch (e) {
    results[lane] = { ok: false, error: e.message };
  }
}

console.log(JSON.stringify(results, null, 2));

const allOk = Object.values(results).every(r => r.ok);
console.log('\nOverall OK:', allOk);
if (!allOk) {
  console.log('Failing lanes:');
  for (const [lane, r] of Object.entries(results)) {
    if (!r.ok) {
      console.log(`  ${lane}: ${JSON.stringify(r.checks?.filter(c => !c.ok))}`);
    }
  }
}
