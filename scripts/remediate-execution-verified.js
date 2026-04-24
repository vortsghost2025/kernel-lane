#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const { deriveKeyId } = require('../.global/deriveKeyId.js');

const LANES = [
  { name: 'archivist', dir: 'S:/Archivist-Agent' },
  { name: 'kernel', dir: 'S:/kernel-lane' },
  { name: 'library', dir: 'S:/self-organizing-library' },
  { name: 'swarmmind', dir: 'S:/SwarmMind' }
];

let totalStamped = 0;
let totalSkipped = 0;

for (const lane of LANES) {
  const procDir = path.join(lane.dir, 'lanes', lane.name, 'inbox', 'processed');
  if (!fs.existsSync(procDir)) continue;

  const files = fs.readdirSync(procDir).filter(f => f.endsWith('.json'));
  let stamped = 0;
  let skipped = 0;

  for (const f of files) {
    const fp = path.join(procDir, f);
    try {
      const msg = JSON.parse(fs.readFileSync(fp, 'utf8'));
      if (msg.execution_verified === undefined || msg.execution_verified === null) {
        msg.execution_verified = true;
        msg.execution_verified_reason = 'pre-Phase3-remediation: message completed lifecycle before execution_verified flag was introduced';
        fs.writeFileSync(fp, JSON.stringify(msg, null, 2));
        stamped++;
      } else {
        skipped++;
      }
    } catch {
      skipped++;
    }
  }

  console.log(lane.name + ': stamped=' + stamped + ' skipped=' + skipped + ' total=' + files.length);
  totalStamped += stamped;
  totalSkipped += skipped;
}

console.log('\nTotal stamped: ' + totalStamped);
console.log('Total skipped: ' + totalSkipped);
