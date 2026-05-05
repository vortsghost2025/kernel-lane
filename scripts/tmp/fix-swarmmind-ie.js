const fs = require('fs');

// Fix SwarmMind identity-enforcer.js - replace remaining LaneDiscovery references
const f = '/home/we4free/agent/repos/SwarmMind/scripts/identity-enforcer.js';
let c = fs.readFileSync(f, 'utf8');

// Replace TRUST_STORE_SEARCH_PATHS block entirely
const oldBlock = /const TRUST_STORE_SEARCH_PATHS = \[[\s\S]*?\];/;
const newBlock = `const TRUST_STORE_SEARCH_PATHS = [
  LOCAL_TRUST_STORE,
  sToLocal('S:/Archivist-Agent/lanes/broadcast/trust-store.json'),
  sToLocal('S:/kernel-lane/lanes/broadcast/trust-store.json'),
  sToLocal('S:/self-organizing-library/lanes/broadcast/trust-store.json'),
  sToLocal('S:/SwarmMind/lanes/broadcast/trust-store.json'),
];`;

c = c.replace(oldBlock, newBlock);

fs.writeFileSync(f, c);
console.log('PATCHED SwarmMind identity-enforcer');
