#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');

const lane = process.argv[2];
if (!lane) {
  console.error('Usage: replay-events.js <lane>');
  process.exit(1);
}
const repoRoot = path.resolve(__dirname, '..');
const eventsFile = path.join(repoRoot, 'lanes', lane, 'state', 'events.log');
if (!fs.existsSync(eventsFile)) {
  console.error(`Events log not found: ${eventsFile}`);
  process.exit(1);
}
const stream = fs.createReadStream(eventsFile, { encoding: 'utf8' });
let lineBuffer = '';
let eventCount = 0;
let latestByType = {};
stream.on('data', chunk => {
  lineBuffer += chunk;
  const lines = lineBuffer.split('\n');
  lineBuffer = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      eventCount++;
      const type = event.event_type || 'unknown';
      latestByType[type] = event.event_timestamp;
    } catch (e) {}
  }
});
stream.on('end', () => {
  console.log(`Replay complete: ${eventCount} events processed`);
  console.log('Latest event timestamps by type:');
  for (const [type, ts] of Object.entries(latestByType)) {
    console.log(`  ${type}: ${ts}`);
  }
});
