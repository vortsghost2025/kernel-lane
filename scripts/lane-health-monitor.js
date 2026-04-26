#!/usr/bin/env node
// lane-health-monitor.js
// Read-only health check for all lanes

const fs = require('fs');
const path = require('path');

const LANES = [
  { name: 'library', path: 'S:/self-organizing-library' },
  { name: 'swarmmind', path: 'S:/SwarmMind' }
];

const THRESHOLDS = {
  P0: 900,    // 15 min
  P1: 3600,  // 1 hour
  P2: 86400, // 24 hours
  P3: 604800 // 7 days
};

function checkHealth() {
  console.log('\n=== LANE HEALTH MONITOR ===\n');
  
  const results = {
    staleHeartbeats: [],
    duplicates: [],
    oldMessages: [],
    laneActivity: []
  };
  
  // Check each lane
  for (const lane of LANES) {
    checkLaneActivity(lane, results);
    checkInbox(path.join(lane.path, 'lanes', lane.name, 'inbox'), results);
  }
  
  // Print results
  printSection('Stale Heartbeats', results.staleHeartbeats);
  printSection('Duplicate Keys', results.duplicates);
  printSection('Old Messages', results.oldMessages);
  printSection('Lane Activity', results.laneActivity);
  
  // Overall status
  const hasIssues = results.staleHeartbeats.length > 0 || 
                    results.duplicates.length > 0 ||
                    results.oldMessages.some(m => m.priority === 'P0' || m.priority === 'P1');
  
  console.log('\n=== OVERALL: ' + (hasIssues ? 'ORANGE - Issues Detected' : 'GREEN - All Healthy') + ' ===\n');
}

function checkLaneActivity(lane, results) {
  const outbox = path.join(lane.path, 'lanes', lane.name, 'outbox');
  const files = fs.readdirSync(outbox).filter(f => f.endsWith('.json'));
  
  if (files.length === 0) {
    results.laneActivity.push({ lane: lane.name, status: 'NO MESSAGES', age: null });
    return;
  }
  
  const latest = files.map(f => {
    const stat = fs.statSync(path.join(outbox, f));
    return { file: f, time: stat.mtime };
  }).sort((a, b) => b.time - a.time)[0];
  
  const age = (Date.now() - latest.time.getTime()) / 1000;
  const status = age < 1800 ? 'ACTIVE' : age < 3600 ? 'SLOW' : 'INACTIVE';
  
  results.laneActivity.push({
    lane: lane.name,
    status: status,
    age: Math.round(age / 60) + ' min ago',
    latest: latest.file
  });
}

function checkInbox(inboxPath, results) {
  if (!fs.existsSync(inboxPath)) return;
  
  const files = fs.readdirSync(inboxPath).filter(f => f.endsWith('.json'));
  const keys = {};
  
  for (const file of files) {
    const filePath = path.join(inboxPath, file);
    
    // Skip processed/expired
    if (filePath.includes('processed') || filePath.includes('expired')) continue;
    
    try {
      const msg = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      
      // Check heartbeat
      if (msg.heartbeat && msg.heartbeat.last_heartbeat_at) {
        const age = (Date.now() - new Date(msg.heartbeat.last_heartbeat_at).getTime()) / 1000;
        if (age > msg.heartbeat.timeout_seconds) {
          results.staleHeartbeats.push({
            file: file,
            age: Math.round(age / 60) + ' min',
            timeout: msg.heartbeat.timeout_seconds + 's'
          });
        }
      }
      
      // Check idempotency
      if (msg.idempotency_key) {
        if (keys[msg.idempotency_key]) {
          results.duplicates.push({
            key: msg.idempotency_key,
            files: [keys[msg.idempotency_key], file]
          });
        } else {
          keys[msg.idempotency_key] = file;
        }
      }
      
      // Check age
      if (msg.timestamp && msg.priority) {
        const age = (Date.now() - new Date(msg.timestamp).getTime()) / 1000;
        const threshold = THRESHOLDS[msg.priority] || 86400;
        if (age > threshold) {
          results.oldMessages.push({
            file: file,
            priority: msg.priority,
            age: Math.round(age / 60) + ' min',
            threshold: Math.round(threshold / 60) + ' min'
          });
        }
      }
    } catch (e) {
      // Skip malformed JSON
    }
  }
}

function printSection(name, items) {
  console.log(`[${name}]`);
  if (items.length === 0) {
    console.log('  ✅ OK');
  } else {
    items.forEach(item => {
      console.log('  ⚠️', JSON.stringify(item));
    });
  }
  console.log('');
}

// Run
checkHealth();
