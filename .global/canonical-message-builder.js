#!/usr/bin/env node
/**
 * Canonical Message Builder for Lanes
 * Use this ONE builder - NO ad-hoc generators allowed
 */

const fs = require('fs');
const path = require('path');
const { LaneDiscovery } = require('./lane-discovery.js');

class CanonicalMessageBuilder {
  constructor(laneId) {
    this.laneId = laneId;
    this.discovery = new LaneDiscovery();
    this.lane = this.discovery.getLane(laneId);
  }

  /**
   * Build a message with current schema
   * Valid types (MUST match enforcement):
   * - "task" - Action request
   * - "response" - Response to task
   * - "heartbeat" - Lane health check
   * - "escalation" - Priority escalation
   * - "handoff" - Session handoff
   * - "ack" - Acknowledgment
   * - "alert" - System alert
   * DEPRECATED: "proposal" - use "task" instead
   */
  buildMessage(options) {
    const {
      toLane,
      type = 'task',           // task, response, heartbeat, escalation, handoff, ack, alert
      taskKind = null,         // optional: audit, sync, etc.
      priority = 'P1',
      subject,
      body,
      requiresAction = true,
      leaseDurationMinutes = 5,
      evidence = { required: false },
      custom = {}
    } = options;

    // Validate type against enforcement schema
    const validTypes = ['task', 'response', 'heartbeat', 'escalation', 'handoff', 'ack', 'alert'];
    if (!validTypes.includes(type)) {
      throw new Error(`Invalid type: "${type}". Must be one of: ${validTypes.join(', ')}`);
    }

    const timestamp = new Date().toISOString();
    const id = `${this.laneId}-${type}-${Date.now()}`;
    
    const message = {
      schema_version: '1.3',
      task_id: id,
      idempotency_key: this.generateIdempotencyKey(),
      from: this.laneId,
      to: toLane,
      timestamp: timestamp,
      priority: priority,
      type: type,
      task_kind: taskKind,
      subject: subject,
      body: body,
      requires_action: requiresAction,
      lease: {
        owner: this.laneId,
        acquired_at: timestamp,
        expires_at: this.addMinutes(timestamp, leaseDurationMinutes),
        duration_minutes: leaseDurationMinutes
      },
      retry: {
        attempt: 1,
        max_attempts: 3,
        last_error: null,
        last_attempt_at: null
      },
      evidence: {
        required: evidence.required || false,
        evidence_path: evidence.path || null,
        evidence_hash: evidence.hash || null,
        verified: false,
        verified_by: null,
        verified_at: null
      },
      ...custom
    };

    return message;
  }

  /**
   * Send message to another lane using canonical paths
   */
  sendToLane(toLaneId, message, filename) {
    const targetLane = this.discovery.getLane(toLaneId);
    const inboxPath = this.discovery.getInbox(toLaneId);
    
    // Ensure target inbox exists
    if (!fs.existsSync(inboxPath)) {
      fs.mkdirSync(inboxPath, { recursive: true });
    }

    // Write to target inbox
    const targetFile = path.join(inboxPath, filename || `${message.task_id}.json`);
    fs.writeFileSync(targetFile, JSON.stringify(message, null, 2));

    // Log to sender outbox
    const outboxPath = this.discovery.getOutbox(this.laneId);
    if (!fs.existsSync(outboxPath)) {
      fs.mkdirSync(outboxPath, { recursive: true });
    }
    
    const receipt = {
      type: 'delivery_receipt',
      to: toLaneId,
      message_path: targetFile,
      timestamp: new Date().toISOString(),
      status: 'delivered'
    };
    const receiptFile = path.join(outboxPath, `receipt-${message.task_id}.json`);
    fs.writeFileSync(receiptFile, JSON.stringify(receipt, null, 2));

    return targetFile;
  }

  /**
   * Mark message as processed (move to processed/)
   */
  markProcessed(messageFile) {
    const inboxPath = this.discovery.getInbox(this.laneId);
    const processedPath = path.join(inboxPath, 'processed');
    
    if (!fs.existsSync(processedPath)) {
      fs.mkdirSync(processedPath, { recursive: true });
    }

    const baseName = path.basename(messageFile);
    const sourcePath = path.join(inboxPath, baseName);
    const targetPath = path.join(processedPath, baseName);

    if (fs.existsSync(sourcePath)) {
      fs.renameSync(sourcePath, targetPath);
      return targetPath;
    }
    throw new Error(`Message not found: ${sourcePath}`);
  }

  generateIdempotencyKey() {
    // Simple UUID-like generator (no shell dependencies)
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
      const r = Math.random() * 16 | 0;
      const v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }

  addMinutes(isoString, minutes) {
    const date = new Date(isoString);
    date.setMinutes(date.getMinutes() + minutes);
    return date.toISOString();
  }
}

module.exports = { CanonicalMessageBuilder };
