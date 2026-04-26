#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const LANES = {
  archivist: 'S:/Archivist-Agent',
  kernel: 'S:/kernel-lane',
  library: 'S:/self-organizing-library',
  swarmmind: 'S:/SwarmMind-Self-Optimizing-Multi-Agent-AI-System'
};

function checkLane(name, root) {
  const trustPath = path.join(root, 'lanes/broadcast/trust-store.json');
  try {
    const trust = JSON.parse(fs.readFileSync(trustPath, 'utf8'));
    return {
      name,
      status: 'OK',
      archivist: trust.archivist?.key_id?.substring(0, 8) || 'MISSING',
      library: trust.library?.key_id?.substring(0, 8) || 'MISSING',
      swarmmind: trust.swarmmind?.key_id?.substring(0, 8) || 'MISSING',
      kernel: trust.kernel?.key_id?.substring(0, 8) || 'MISSING'
    };
  } catch (e) {
    return { name, status: 'ERROR', error: e.message };
  }
}

console.log('=== 4-Lane System Status ===\n');
console.log('Lane       | Archivist | Library  | SwarmMind | Kernel   ');
console.log('-----------|-----------|----------|-----------|----------');

const results = Object.entries(LANES).map(([name, root]) => checkLane(name, root));

results.forEach(r => {
  if (r.status === 'OK') {
    console.log(`${r.name.padEnd(10)} | ${r.archivist}   | ${r.library}  | ${r.swarmmind}  | ${r.kernel}`);
  } else {
    console.log(`${r.name}: ERROR - ${r.error}`);
  }
});

console.log('\n=== Convergence Check ===');
const first = results[0];
if (first.status === 'OK') {
  const allMatch = results.every(r => 
    r.archivist === first.archivist &&
    r.library === first.library &&
    r.swarmmind === first.swarmmind &&
    r.kernel === first.kernel
  );
  console.log(allMatch ? '✅ All lanes synchronized' : '❌ DIVERGENCE DETECTED');
}
