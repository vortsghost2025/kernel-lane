#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const cp = require('./completion-proof');
const { getCodeVersionHash } = require('./code-version-hash');

const DEFAULT_CONFIG_PATH = path.join(__dirname, '..', 'config', 'verification-domain-gate.json');

const VALID_TASK_KINDS = new Set([
  'task',
  'proposal',
  'review',
  'finding',
  'report',
  'status',
  'ack',
  'handoff',
]);

function loadGateConfig(configPath = DEFAULT_CONFIG_PATH) {
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (_) {
    return null;
  }
}

function toMs(value) {
  if (!value) return null;
  const ms = Date.parse(String(value));
  return Number.isNaN(ms) ? null : ms;
}

function evaluateTemporal(msg) {
  const dispatchTs = toMs(msg.dispatch_timestamp || msg.timestamp);
  const executionTs = toMs(
    msg.execution_timestamp ||
    (msg.evidence_exchange && msg.evidence_exchange.delivered_at) ||
    (msg.heartbeat && msg.heartbeat.last_heartbeat_at)
  );

  if (!dispatchTs || !executionTs) {
    return {
      valid: false,
      reason: 'temporal constraint unreachable',
      expected: 'execution_timestamp > dispatch_timestamp',
      actual: null,
    };
  }

  return {
    valid: executionTs >= dispatchTs,
    reason: executionTs >= dispatchTs ? null : 'execution timestamp precedes dispatch',
    expected: 'execution_timestamp > dispatch_timestamp',
    actual: executionTs >= dispatchTs,
  };
}

function evaluateSemantic(msg, localCodeVersionHash = null) {
  const taskKindValid = !msg.task_kind || VALID_TASK_KINDS.has(String(msg.task_kind).toLowerCase());
  const hasProof = cp.hasCompletionProof(msg);
  const evidenceFieldsPresent = hasProof
    ? Boolean(
      (msg.evidence_exchange && msg.evidence_exchange.artifact_path) ||
      msg.completion_artifact_path ||
      msg.completion_message_id ||
      msg.resolved_by_task_id
    )
    : true;
  const routingMetadataValid = !msg._execution_result || !msg._execution_result._routing || Boolean(msg._execution_result._routing.verb);

  const messageCodeHash = msg && msg._governance ? msg._governance.code_version_hash : null;
  const codeVersionHashValid = !messageCodeHash || !localCodeVersionHash || messageCodeHash === localCodeVersionHash;
  const valid = taskKindValid && evidenceFieldsPresent && routingMetadataValid && codeVersionHashValid;
  let reason = null;
  if (!taskKindValid) reason = 'schema does not cover behavior';
  else if (!evidenceFieldsPresent) reason = 'evidence fields missing for completion proof';
  else if (!routingMetadataValid) reason = 'routing metadata invalid';
  else if (!codeVersionHashValid) reason = 'code version hash mismatch';

  return {
    valid,
    reason,
    task_kind_valid: taskKindValid,
    evidence_fields_present: evidenceFieldsPresent,
    routing_metadata_valid: routingMetadataValid,
    code_version_hash_valid: codeVersionHashValid,
    local_code_version_hash: localCodeVersionHash,
    message_code_version_hash: messageCodeHash,
  };
}

function evaluateObservability(msg, resolver) {
  const classification = resolver.classifyProof(msg);
  if (classification.type === 'NONE') {
    return { valid: true, reason: null, path_resolves: true, proof_type: 'NONE' };
  }
  const resolution = resolver.resolveMessage(msg);
  if (!resolution.resolved) {
    return {
      valid: false,
      reason: 'artifact not observable',
      path_resolves: false,
      proof_type: classification.type,
      resolution_reason: resolution.reason,
    };
  }
  return {
    valid: true,
    reason: null,
    path_resolves: true,
    proof_type: classification.type,
    resolution_reason: resolution.reason,
  };
}

function evaluateVerificationDomain(msg, options = {}) {
  const resolver = options.resolver;
  const localCodeVersionHash = options.localCodeVersionHash || getCodeVersionHash(options.repoRoot || path.resolve(__dirname, '..'));
  if (!resolver) {
    return {
      domain_valid: false,
      phase: 'pre_execution',
      has_execution_artifact: false,
      invalid_domain_reason: 'resolver unavailable',
      verification_outcome: 'INVALID_DOMAIN',
      execution_preserved: false,
    };
  }

  const hasExecutionArtifact = Boolean(
    msg.execution_timestamp ||
    (msg.evidence_exchange && msg.evidence_exchange.delivered_at) ||
    (msg.heartbeat && msg.heartbeat.last_heartbeat_at)
  );
  const phase = hasExecutionArtifact ? 'post_execution' : 'pre_execution';

  const temporal = evaluateTemporal(msg);
  const semantic = evaluateSemantic(msg, localCodeVersionHash);
  const observability = evaluateObservability(msg, resolver);

  if (!temporal.valid) {
    return {
      domain_valid: false,
      phase,
      has_execution_artifact: hasExecutionArtifact,
      invalid_domain_reason: temporal.reason,
      verification_outcome: 'INVALID_DOMAIN',
      execution_preserved: phase === 'post_execution',
      temporal,
      semantic,
      observability,
    };
  }
  if (!semantic.valid) {
    return {
      domain_valid: false,
      phase,
      has_execution_artifact: hasExecutionArtifact,
      invalid_domain_reason: semantic.reason,
      verification_outcome: 'INVALID_DOMAIN',
      execution_preserved: phase === 'post_execution',
      temporal,
      semantic,
      observability,
    };
  }
  if (!observability.valid) {
    return {
      domain_valid: false,
      phase,
      has_execution_artifact: hasExecutionArtifact,
      invalid_domain_reason: observability.reason,
      verification_outcome: 'INVALID_DOMAIN',
      execution_preserved: phase === 'post_execution',
      temporal,
      semantic,
      observability,
    };
  }

  return {
    domain_valid: true,
    phase,
    has_execution_artifact: hasExecutionArtifact,
    invalid_domain_reason: null,
    verification_outcome: 'PROCEED_TO_VERIFICATION',
    execution_preserved: false,
    temporal,
    semantic,
    observability,
  };
}

module.exports = {
  loadGateConfig,
  evaluateVerificationDomain,
};

