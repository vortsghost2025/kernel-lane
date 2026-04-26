#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const PROCESSED_DIR = path.join(REPO_ROOT, 'lanes', 'archivist', 'inbox', 'processed');
const BLOCKED_DIR = path.join(REPO_ROOT, 'lanes', 'archivist', 'inbox', 'blocked');

function validateResponses() {
  const results = { verified: [], failed: [], pending_review: [] };

  // Check processed responses
  if (fs.existsSync(PROCESSED_DIR)) {
    const files = fs.readdirSync(PROCESSED_DIR).filter(f => f.endsWith('.json') && f.startsWith('response-'));
    for (const f of files) {
      const msg = JSON.parse(fs.readFileSync(path.join(PROCESSED_DIR, f), 'utf8'));
      const lw = msg._lane_worker || {};
      const claim = {
        task_id: msg.task_id,
        original_task_id: msg._original_task_id,
        from: msg.from,
        type: msg.type,
        task_kind: msg.task_kind,
        subject: (msg.subject || '').slice(0, 80),
        body_summary: (msg.body || '').slice(0, 200),
        execution_verified: lw.execution_verified,
        signature_valid: lw.signature_valid,
        schema_valid: lw.schema_valid,
        route: lw.route,
        reason: lw.reason,
      };

      if (lw.execution_verified && lw.signature_valid) {
        results.verified.push(claim);
      } else {
        results.pending_review.push(claim);
      }
    }
  }

  // Check blocked responses
  if (fs.existsSync(BLOCKED_DIR)) {
    const files = fs.readdirSync(BLOCKED_DIR).filter(f => f.endsWith('.json') && f.startsWith('response-'));
    for (const f of files) {
      const msg = JSON.parse(fs.readFileSync(path.join(BLOCKED_DIR, f), 'utf8'));
      const lw = msg._lane_worker || {};
      results.failed.push({
        task_id: msg.task_id || f,
        from: msg.from,
        reason: lw.reason,
        detail: (lw.detail || '').slice(0, 200),
      });
    }
  }

  return results;
}

function generateSummary() {
  const results = validateResponses();
  const lines = [];

  lines.push('# Archivist Task Response Summary');
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push('');

  lines.push(`## Verified Responses: ${results.verified.length}`);
  for (const r of results.verified) {
    lines.push(`- **${r.task_id}** from ${r.from}: "${r.subject}"`);
    lines.push(`  ${r.body_summary}`);
    lines.push('');
  }

  lines.push(`## Pending Review: ${results.pending_review.length}`);
  for (const r of results.pending_review) {
    lines.push(`- **${r.task_id}** from ${r.from}: exec_verified=${r.execution_verified} sig=${r.signature_valid}`);
    lines.push('');
  }

  lines.push(`## Failed/Blocked: ${results.failed.length}`);
  for (const r of results.failed) {
    lines.push(`- **${r.task_id}** from ${r.from}: ${r.reason} — ${r.detail}`);
    lines.push('');
  }

  // Pending outgoing tasks
  const outboxDir = path.join(REPO_ROOT, 'lanes', 'archivist', 'outbox');
  if (fs.existsSync(outboxDir)) {
    const outFiles = fs.readdirSync(outboxDir).filter(f => f.endsWith('.json'));
    lines.push(`## Outgoing Tasks Pending Response: ${outFiles.length}`);
    for (const f of outFiles) {
      try {
        const msg = JSON.parse(fs.readFileSync(path.join(outboxDir, f), 'utf8'));
        lines.push(`- **${msg.task_id}** → ${msg.to}: "${(msg.subject || '').slice(0, 60)}" [${msg.priority}]`);
      } catch (_) {}
    }
  }

  return lines.join('\n');
}

if (require.main === module) {
  const summary = generateSummary();
  console.log(summary);
}

module.exports = { validateResponses, generateSummary };
