#!/usr/bin/env node
/**
 * governance-message-verifier.js
 * 
 * Scans governance messages and verifies required acknowledgments.
 * Alerts on missing acknowledgments after threshold.
 * 
 * Usage: node governance-message-verifier.js [--alert-only]
 */

const fs = require('fs');
const path = require('path');

const REGISTRY_PATH = path.join(__dirname, '..', 'lanes', 'broadcast', 'governance-verification-registry.json');
const BROADCAST_PATH = path.join(__dirname, '..', 'lanes', 'broadcast');

// Constants
const ALERT_THRESHOLD_HOURS = 24;

function loadRegistry() {
  if (!fs.existsSync(REGISTRY_PATH)) {
    return { messages: {}, last_scan: null, alert_threshold_hours: ALERT_THRESHOLD_HOURS };
  }
  return JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
}

function saveRegistry(registry) {
  fs.writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2));
}

/**
 * Check if a lane has acknowledged a message by looking for:
 * - ack message in their outbox
 * - processed message with ack type
 */
function checkAcknowledgment(messageId, lane) {
  const laneInboxPath = getLaneInbox(lane);
  if (!laneInboxPath || !fs.existsSync(laneInboxPath)) {
    return false;
  }
  
  const processedPath = path.join(laneInboxPath, 'processed');
  if (!fs.existsSync(processedPath)) {
    return false;
  }
  
  const files = fs.readdirSync(processedPath);
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    try {
      const content = fs.readFileSync(path.join(processedPath, file), 'utf8');
      const msg = JSON.parse(content);
      if (msg.in_response_to === messageId && msg.type === 'ack') {
        return true;
      }
    } catch (e) {
      // Skip invalid files
    }
  }
  return false;
}

function getLaneInbox(lane) {
  const paths = {
    'archivist': 'S:/Archivist-Agent/lanes/archivist/inbox',
    'library': 'S:/self-organizing-library/lanes/library/inbox',
    'swarmmind': 'S:/SwarmMind/lanes/swarmmind/inbox',
    'kernel': 'S:/kernel-lane/lanes/kernel/inbox'
  };
  return paths[lane];
}

/**
 * Check all governance messages for acknowledgment status
 */
function scanGovernanceMessages() {
  const registry = loadRegistry();
  const now = new Date();
  const alerts = [];
  const updated = false;
  
  for (const [messageId, msgData] of Object.entries(registry.messages)) {
    if (msgData.status === 'ACKED') continue;
    
    const acknowledged = [];
    for (const lane of msgData.delivered) {
      const hasAck = checkAcknowledgment(messageId, lane);
      if (hasAck) {
        acknowledged.push(lane);
      }
    }
    
    const missing = msgData.required_acks.filter(a => !acknowledged.includes(a));
    
    if (missing.length === 0) {
      msgData.status = 'ACKED';
      msgData.verified_at = now.toISOString();
      alerts.push({ level: 'INFO', msg: `Governance message ACKED: ${messageId}` });
      updated = true;
    } else {
      msgData.acknowledged = acknowledged;
      msgData.missing_acks = missing;
      
      const ageHours = (now - new Date(msgData.created_at)) / (1000 * 60 * 60);
      if (ageHours > registry.alert_threshold_hours) {
        alerts.push({ 
          level: 'ALERT', 
          msg: `MISSING ACKS for governance message: ${messageId} (${ageHours.toFixed(1)}h old)`,
          missing: missing,
          subject: msgData.subject,
          priority: msgData.priority,
          blocking: msgData.blocking
        });
      }
    }
  }
  
  registry.last_scan = now.toISOString();
  
  if (updated || alerts.length > 0) {
    saveRegistry(registry);
  }
  
  return { registry, alerts };
}

/**
 * Get dashboard summary
 */
function getSummary() {
  const registry = loadRegistry();
  const pending = Object.values(registry.messages).filter(m => m.status !== 'ACKED');
  const blocking = pending.filter(m => m.blocking);
  
  return {
    total_governance_messages: Object.keys(registry.messages).length,
    pending_acks: pending.length,
    blocking_release: blocking.length,
    last_scan: registry.last_scan,
    alert_threshold_hours: registry.alert_threshold_hours,
    blocking_messages: blocking.map(m => ({
      id: m.subject,
      priority: m.priority,
      missing: m.required_acks || m.missing_acks
    }))
  };
}

/**
 * Main entry point
 */
function main() {
  const args = process.argv.slice(2);
  
  if (args.includes('--summary')) {
    console.log(JSON.stringify(getSummary(), null, 2));
    process.exit(0);
  }
  
  if (args.includes('--alert-only')) {
    const result = scanGovernanceMessages();
    const alerts = result.alerts.filter(a => a.level === 'ALERT');
    if (alerts.length > 0) {
      console.log('🚨 GOVERNANCE ALERTS:');
      for (const alert of alerts) {
        console.log(`  [${alert.priority}] ${alert.subject}`);
        console.log(`    Missing: ${alert.missing.join(', ')}`);
        console.log(`    Blocking: ${alert.blocking}`);
      }
      process.exit(1);
    }
    console.log('✅ No governance alerts');
    process.exit(0);
  }
  
  const result = scanGovernanceMessages();
  console.log(`Last scan: ${result.registry.last_scan}`);
  console.log(`Alerts: ${result.alerts.length}`);
  for (const alert of result.alerts) {
    console.log(`  [${alert.level}] ${alert.msg}`);
  }
}

if (require.main === module) {
  main();
}

module.exports = { scanGovernanceMessages, getSummary, checkAcknowledgment };