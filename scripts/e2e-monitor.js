#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const ARCHIVIST_INBOX = 'S:/Archivist-Agent/lanes/archivist/inbox';
const TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const CHECK_INTERVAL_MS = 30 * 1000; // 30 seconds

const EXPECTED_SUMMARIES = [
  'lane-e2e-summary-archivist.json',
  'lane-e2e-summary-library.json',
  'lane-e2e-summary-kernel.json',
  'lane-e2e-summary-swarmmind.json'
];

function checkSummaries() {
  const files = fs.readdirSync(ARCHIVIST_INBOX).filter(f => f.startsWith('lane-e2e-summary'));
  const found = EXPECTED_SUMMARIES.filter(s => files.includes(s));
  const missing = EXPECTED_SUMMARIES.filter(s => !files.includes(s));
  return { found, missing, files };
}

function createReminder(lane) {
  const msg = {
    schema_version: '1.0',
    task_id: 'full-test-reminder',
    idempotency_key: `full-test-reminder-${lane}-${new Date().toISOString().replace(/[:.]/g, '-')}`,
    body: `Reminder: please run the full test suite and deliver lane-e2e-summary-${lane}.json to the Archivist inbox.`
  };
  const targetInbox = path.join('S:/Archivist-Agent/lanes', lane, 'inbox', msg.idempotency_key + '.json');
  fs.writeFileSync(targetInbox, JSON.stringify(msg, null, 2));
  console.log(`[REMINDER] Sent to ${lane}`);
}

async function runMonitor() {
  console.log('[MONITOR] Starting E2E summary monitoring...');
  const startTime = Date.now();
  
  while (Date.now() - startTime < TIMEOUT_MS) {
    const { found, missing } = checkSummaries();
    console.log(`[CHECK] Found: ${found.length}/${EXPECTED_SUMMARIES.length} - Missing: ${missing.join(', ')}`);
    
    if (found.length === EXPECTED_SUMMARIES.length) {
      console.log('[MONITOR] All summaries received!');
      aggregateSummaries();
      return;
    }
    
    await new Promise(r => setTimeout(r, CHECK_INTERVAL_MS));
  }
  
  // Timeout - send reminders
  const { missing } = checkSummaries();
  console.log('[MONITOR] Timeout - sending reminders to:', missing);
  
  for (const s of missing) {
    const lane = s.replace('lane-e2e-summary-', '').replace('.json', '');
    createReminder(lane);
  }
}

function aggregateSummaries() {
  const inboxFiles = fs.readdirSync(ARCHIVIST_INBOX);
  const summaries = inboxFiles.filter(f => f.startsWith('lane-e2e-summary'));
  
  let passCount = 0;
  let failCount = 0;
  const results = [];
  
  for (const s of summaries) {
    try {
      const content = JSON.parse(fs.readFileSync(path.join(ARCHIVIST_INBOX, s), 'utf8'));
      const status = content.final_status || 'UNKNOWN';
      if (status === 'PASS') passCount++;
      else if (status === 'FAIL') failCount++;
      results.push({ file: s, status });
    } catch(e) {
      results.push({ file: s, error: e.message });
    }
  }
  
  const report = {
    aggregation_timestamp: new Date().toISOString(),
    total_summaries: summaries.length,
    pass_count: passCount,
    fail_count: failCount,
    results
  };
  
  const outPath = 'S:/Archivist-Agent/lanes/archivist/outbox/e2e-summary-aggregation.json';
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`[AGGREGATION] Written to ${outPath}`);
  return report;
}

// CLI
const args = process.argv.slice(2);
if (args[0] === 'check') {
  const { found, missing } = checkSummaries();
  console.log(JSON.stringify({ found, missing }, null, 2));
} else if (args[0] === 'aggregate') {
  aggregateSummaries();
} else if (args[0] === 'monitor') {
  runMonitor().catch(console.error);
} else {
  console.log('Usage: node e2e-monitor.js <check|aggregate|monitor>');
}

module.exports = { checkSummaries, aggregateSummaries };