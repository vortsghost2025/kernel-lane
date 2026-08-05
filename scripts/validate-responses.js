#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const PROCESSED_DIR = path.join(REPO_ROOT, 'lanes', 'archivist', 'inbox', 'processed');
const BLOCKED_DIR = path.join(REPO_ROOT, 'lanes', 'archivist', 'inbox', 'blocked');

function validateLaneWorkerResponse(msg) {
  const lw = msg && msg._lane_worker ? msg._lane_worker : {};
  const errors = [];
  if (lw.enforce_ownership === true) {
    if (!('ownership' in lw)) {
      errors.push('Missing _lane_worker.ownership when enforce_ownership=true');
    }
    if (!Array.isArray(lw.ownership_notes)) {
      errors.push('Missing or invalid _lane_worker.ownership_notes when enforce_ownership=true');
    }
  }
  if (lw.reason === 'INVALID_DOMAIN') {
    if (!lw.domain_validation || lw.domain_validation.domain_valid !== false) {
      errors.push('Missing or invalid _lane_worker.domain_validation for INVALID_DOMAIN');
    }
    if (lw.verification_outcome !== 'INVALID_DOMAIN') {
      errors.push('verification_outcome must be INVALID_DOMAIN when reason=INVALID_DOMAIN');
    }
  }
  if (lw.reason === 'INVALID_DOMAIN_PRE_EXECUTION' || lw.reason === 'INVALID_DOMAIN_POST_EXECUTION') {
    if (lw.domain_gate_executed !== true) {
      errors.push('domain_gate_executed must be true for INVALID_DOMAIN routes');
    }
    if (!lw.domain_validation || lw.domain_validation.domain_valid !== false) {
      errors.push('domain_validation must exist and report domain_valid=false for INVALID_DOMAIN routes');
    }
    if (lw.verification_outcome !== 'INVALID_DOMAIN') {
      errors.push('verification_outcome must be INVALID_DOMAIN for INVALID_DOMAIN routes');
    }
    if (lw.reason === 'INVALID_DOMAIN_POST_EXECUTION') {
      if (lw.domain_validation.phase !== 'post_execution') {
        errors.push('INVALID_DOMAIN_POST_EXECUTION requires phase=post_execution');
      }
      if (lw.domain_validation.execution_preserved !== true) {
        errors.push('INVALID_DOMAIN_POST_EXECUTION requires execution_preserved=true');
      }
    }
    if (lw.reason === 'INVALID_DOMAIN_PRE_EXECUTION') {
      if (lw.domain_validation.phase !== 'pre_execution') {
        errors.push('INVALID_DOMAIN_PRE_EXECUTION requires phase=pre_execution');
      }
    }
  }
  if (lw.domain_gate_executed === true) {
    const expectedPath = ['domain_gate', 'execution_check', 'response_validation'];
    if (!Array.isArray(lw.verification_path)) {
      errors.push('verification_path missing when domain_gate_executed=true');
    } else if (JSON.stringify(lw.verification_path) !== JSON.stringify(expectedPath)) {
      errors.push('verification_path order invalid');
    }
  }
  return { valid: errors.length === 0, errors };
}

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
      const responseSchema = validateLaneWorkerResponse(msg);
      claim.response_schema_valid = responseSchema.valid;
      claim.response_schema_errors = responseSchema.errors;

      if (lw.execution_verified && lw.signature_valid && responseSchema.valid) {
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
