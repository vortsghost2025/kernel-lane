const fs = require('fs');
const f = '/home/we4free/agent/repos/SwarmMind/scripts/inbox-watcher.js';
let c = fs.readFileSync(f, 'utf8');

// Replace LaneDiscovery import with SwarmMind's own exports
c = c.replace(
  "const { LaneDiscovery } = require('./util/lane-discovery');",
  "const { sToLocal, getLane, getLaneNames } = require('./util/lane-discovery');"
);

// Replace the broken canonicalPaths IIFE with sToLocal-based version
// The IIFE uses new LaneDiscovery() which doesn't exist in SwarmMind's lane-discovery
const iifeStart = c.indexOf('canonicalPaths: (() => {');
if (iifeStart !== -1) {
  const iifeEnd = c.indexOf('})()', iifeStart) + 4;
  const replacement = "canonicalPaths: { archivist: sToLocal('S:/Archivist-Agent/lanes/archivist/inbox/'), library: sToLocal('S:/self-organizing-library/lanes/library/inbox/'), swarmmind: sToLocal('S:/SwarmMind/lanes/swarmmind/inbox/'), kernel: sToLocal('S:/kernel-lane/lanes/kernel/inbox/') }";
  c = c.substring(0, iifeStart) + replacement + c.substring(iifeEnd);
}

fs.writeFileSync(f, c);
console.log('PATCHED SwarmMind inbox-watcher');

// Also fix SwarmMind identity-enforcer.js - replace LaneDiscovery with sToLocal
const ieF = '/home/we4free/agent/repos/SwarmMind/scripts/identity-enforcer.js';
let ieC = fs.readFileSync(ieF, 'utf8');

// Remove LaneDiscovery import if present
ieC = ieC.replace(/const \{ LaneDiscovery \} = require\('\.\/util\/lane-discovery'\);?\n?/g, '');

// Add sToLocal import if not present
if (!ieC.includes("require('./util/lane-discovery')")) {
  ieC = ieC.replace(
    "const path = require('path');",
    "const path = require('path');\nconst { sToLocal } = require('./util/lane-discovery');"
  );
}

// Replace any LaneDiscovery().getLocalPath() calls with sToLocal()
ieC = ieC.replace(
  /new LaneDiscovery\(\)\.getLocalPath\('archivist'\)[^+]*\+[^,]*trust-store\.json'/g,
  "sToLocal('S:/Archivist-Agent/lanes/broadcast/trust-store.json')"
);
ieC = ieC.replace(
  /new LaneDiscovery\(\)\.getLocalPath\('kernel'\)[^+]*\+[^,]*trust-store\.json'/g,
  "sToLocal('S:/kernel-lane/lanes/broadcast/trust-store.json')"
);
ieC = ieC.replace(
  /new LaneDiscovery\(\)\.getLocalPath\('library'\)[^+]*\+[^,]*trust-store\.json'/g,
  "sToLocal('S:/self-organizing-library/lanes/broadcast/trust-store.json')"
);
ieC = ieC.replace(
  /new LaneDiscovery\(\)\.getLocalPath\('swarmmind'\)[^+]*\+[^,]*trust-store\.json'/g,
  "sToLocal('S:/SwarmMind/lanes/broadcast/trust-store.json')"
);

// Fix attestation paths similarly
ieC = ieC.replace(
  /path\.join\(new LaneDiscovery\(\)\.getLocalPath\('swarmmind'\)[^)]*\)/g,
  "sToLocal('S:/SwarmMind/src/attestation')"
);
ieC = ieC.replace(
  /path\.join\(new LaneDiscovery\(\)\.getLocalPath\('library'\)[^)]*\)/g,
  "sToLocal('S:/self-organizing-library/src/attestation')"
);
ieC = ieC.replace(
  /path\.join\(new LaneDiscovery\(\)\.getLocalPath\('kernel'\)[^)]*\)/g,
  "sToLocal('S:/kernel-lane/src/attestation')"
);

fs.writeFileSync(ieF, ieC);
console.log('PATCHED SwarmMind identity-enforcer');
