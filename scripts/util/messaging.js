#!/usr/bin/env node
// ORIGIN: kernel-lane (original implementation)
// LAST_SYNC: 2026-05-02
// LOCAL UTILITY: Sovereignty-compliant messaging builder. No cross-lane imports.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { LaneDiscovery } = require('./lane-discovery');

const discovery = new LaneDiscovery();

function generateIdempotencyKey(taskId, from, to, subject) {
  const raw = `${taskId}:${from}:${to}:${subject}`;
  return crypto.createHash('sha256').update(raw).digest('hex');
}

function buildMessage({ from, to, type, taskKind, priority, subject, body, evidencePath, artifactPath }) {
  const taskId = `${type}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const msg = {
    schema_version: '1.3',
    task_id: taskId,
    idempotency_key: generateIdempotencyKey(taskId, from, to, subject),
    from: from,
    to: to,
    type: type || 'task',
    task_kind: taskKind || 'notification',
    priority: priority || 'P2',
    subject: subject,
    body: body,
    timestamp: new Date().toISOString(),
    requires_action: priority === 'P0' || priority === 'P1',
    payload: { mode: 'inline', compression: 'none' },
    execution: { mode: 'manual', engine: 'kilo', actor: 'lane' },
    lease: { owner: null, acquired_at: null, expires_at: null, renew_count: 0, max_renewals: 3 },
    retry: { attempt: 1, max_attempts: 3, last_error: null, last_attempt_at: null },
    evidence: {
      required: !!evidencePath,
      evidence_path: evidencePath || null,
      verified: false,
      verified_by: null,
      verified_at: null
    },
    evidence_exchange: {
      artifact_path: artifactPath || evidencePath || null,
      artifact_type: 'log',
      delivered_at: new Date().toISOString()
    },
    heartbeat: {
      status: 'pending',
      last_heartbeat_at: null,
      interval_seconds: 300,
      timeout_seconds: 3600
    },
    delivery_verification: { verified: false, verified_at: null, retries: 0 }
  };
  return msg;
}

function sendToLane(fromLane, toLane, message, filename) {
  return discovery.sendToLane(fromLane, toLane, message, filename);
}

module.exports = { buildMessage, sendToLane, generateIdempotencyKey, LaneDiscovery };
