#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');

const LANES = [
  { name: 'archivist', dir: 'S:/Archivist-Agent' },
  { name: 'kernel', dir: 'S:/kernel-lane' },
  { name: 'library', dir: 'S:/self-organizing-library' },
  { name: 'swarmmind', dir: 'S:/SwarmMind' }
];

const SUBDIRS_TO_REMOVE = [
  'processed', 'expired', 'quarantine', 'invalid-schema',
  'pending', 'duplicates', 'unsigned', 'unsigned-archive',
  'blocked',           // NFM-020: nack-nack cascade accumulates here
  'archive',           // NFM-020: summary broadcast spam accumulates here
  'stale-foreign',     // NFM-020: stale-foreign cleanup
];

const ARCHIVE_SUFFIX = '.bak';  // NFM-020: handle renamed .bak files

for (const lane of LANES) {
  for (const box of ['inbox', 'outbox']) {
    const boxDir = path.join(lane.dir, 'lanes', lane.name, box);
    if (!fs.existsSync(boxDir)) continue;

    // Remove all subdirs
    for (const sub of SUBDIRS_TO_REMOVE) {
      const subDir = path.join(boxDir, sub);
      if (fs.existsSync(subDir)) {
        fs.rmSync(subDir, { recursive: true, force: true });
      }
    }

    // Remove .json files AND .bak-* files from inbox/outbox root
    const rootFiles = fs.readdirSync(boxDir).filter(f => {
      return f.endsWith('.json') || f.includes(ARCHIVE_SUFFIX);
    });
    for (const f of rootFiles) {
      fs.unlinkSync(path.join(boxDir, f));
    }

    // Recreate empty processed/ and quarantine/ dirs (lane-worker expects them)
    const procDir = path.join(boxDir, 'processed');
    const quarDir = path.join(boxDir, 'quarantine');
    if (!fs.existsSync(procDir)) fs.mkdirSync(procDir, { recursive: true });
    if (!fs.existsSync(quarDir)) fs.mkdirSync(quarDir, { recursive: true });

    const remaining = fs.readdirSync(boxDir);
    console.log(lane.name + '/' + box + ': cleared. remaining: ' + remaining.join(', '));
  }
}

console.log('\nAll lanes cleared. Empty inbox/outbox with processed/ and quarantine/ dirs ready.');
