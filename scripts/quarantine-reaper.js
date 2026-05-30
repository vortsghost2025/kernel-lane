#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');

const laneRoot = path.resolve(__dirname, '..');
let lane;
const repoName = path.basename(laneRoot).toLowerCase();
if (repoName.includes('archivist')) lane = 'archivist';
else if (repoName.includes('kernel')) lane = 'kernel';
else if (repoName.includes('library')) lane = 'library';
else if (repoName.includes('swarmmind')) lane = 'swarmmind';
else throw new Error('Cannot determine lane from repo name: ' + repoName);

const inboxDir = path.join(laneRoot, 'lanes', lane, 'inbox');
const quarantineDir = path.join(inboxDir, 'quarantine');
const archiveDir = path.join(quarantineDir, 'archive');
const now = new Date();
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

// Ensure archive dir exists
if (!fs.existsSync(archiveDir)) fs.mkdirSync(archiveDir, { recursive: true });

let stats = { scanned: 0, movedToInbox: 0, archived: 0, errors: 0 };
let logStream;

try {
  const stateDir = path.join(laneRoot, 'lanes', lane, 'state');
  if (!fs.existsSync(stateDir)) fs.mkdirSync(stateDir, { recursive: true });
  const logPath = path.join(stateDir, 'quarantine-reaper.jsonl');
  logStream = fs.createWriteStream(logPath, { flags: 'a' });
} catch (_) {
  // ignore log stream errors
}

function logEntry(entry) {
  if (logStream) logStream.write(JSON.stringify(entry) + '\n');
}

// Scan quarantine
if (!fs.existsSync(quarantineDir)) {
  console.log('Quarantine dir does not exist:', quarantineDir);
  process.exit(0);
}

const files = fs.readdirSync(quarantineDir).filter(f => f.endsWith('.json'));
stats.scanned = files.length;

for (const file of files) {
  const src = path.join(quarantineDir, file);
  try {
    const st = fs.statSync(src);
    const ageMs = now - new Date(st.mtimeMs);
    if (ageMs > THIRTY_DAYS_MS) {
      // Archive: quarantine/archive/YYYY-MM-DD/
      const dateStr = new Date(st.mtimeMs).toISOString().slice(0, 10);
      const dayArchive = path.join(archiveDir, dateStr);
      if (!fs.existsSync(dayArchive)) fs.mkdirSync(dayArchive, { recursive: true });
      const dest = path.join(dayArchive, file);
      fs.renameSync(src, dest);
      stats.archived++;
      logEntry({ timestamp: now.toISOString(), action: 'archived', source: src, destination: dest, age_days: ageMs / (1000*60*60*24) });
    } else {
      // Move back to inbox for reprocessing
      const dest = path.join(inboxDir, file);
      fs.renameSync(src, dest);
      stats.movedToInbox++;
      logEntry({ timestamp: now.toISOString(), action: 'moved_to_inbox', source: src, destination: dest });
    }
  } catch (err) {
    stats.errors++;
    logEntry({ timestamp: now.toISOString(), action: 'error', source: src, error: err.message });
  }
}

logEntry({ timestamp: now.toISOString(), stats });
console.log(`Quarantine reaper (${lane}): scanned=${stats.scanned} moved=${stats.movedToInbox} archived=${stats.archived} errors=${stats.errors}`);
process.exit(stats.errors > 0 ? 1 : 0);