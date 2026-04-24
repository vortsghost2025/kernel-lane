#!/usr/bin/env node
'use strict';

const TERMINAL_TYPES = new Set([
  'ack',
  'acknowledgment',
  'heartbeat',
  'notification',
  'response',
]);

const LEGACY_ARTIFACT_FIELDS = [
  'completion_artifact_path',
  'completion_message_id',
  'resolved_by_task_id',
];

function hasCompletionProof(msg) {
  if (!msg || typeof msg !== 'object') return false;

  if (msg.evidence_exchange && msg.evidence_exchange.artifact_path) {
    return true;
  }

  for (const field of LEGACY_ARTIFACT_FIELDS) {
    const val = msg[field];
    if (val !== undefined && val !== null && val !== '' && val !== false) return true;
  }

  if (msg.evidence && msg.evidence.required === true && msg.evidence.evidence_path) return true;

  return false;
}

function hasFakeProof(msg) {
  if (!msg || typeof msg !== 'object') return false;
  const hasTerminalDecision = !!(msg.terminal_decision || msg.disposition);
  const hasArtifact = !!(
    (msg.evidence_exchange && msg.evidence_exchange.artifact_path) ||
    msg.completion_artifact_path ||
    msg.completion_message_id ||
    msg.resolved_by_task_id
  );
  return hasTerminalDecision && !hasArtifact;
}

function hasUnresolvableEvidence(msg) {
  if (!msg || typeof msg !== 'object') return false;
  if (!msg.evidence || msg.evidence.required !== true) return false;
  const exch = msg.evidence_exchange;
  if (!exch || !exch.artifact_path) return true;
  return false;
}

function isActionable(msg) {
  if (!msg || typeof msg !== 'object') return false;
  return msg.requires_action === true;
}

function hasFollowupObligation(msg) {
  if (!msg || typeof msg !== 'object') return false;
  return !!(msg.depends_on || msg.creates_followup || msg.links_to_contradiction);
}

function isTerminalInformational(msg) {
  if (!msg || typeof msg !== 'object') return false;
  if (msg.requires_action !== false) return false;
  const type = String(msg.type || '').toLowerCase().trim();
  if (!TERMINAL_TYPES.has(type)) return false;
  if (hasFollowupObligation(msg)) return false;
  return true;
}

function evaluate(msg) {
  if (!msg || typeof msg !== 'object') {
    return { pass: false, reason: 'INVALID_MESSAGE', detail: 'Message is null or not an object' };
  }

  if (hasUnresolvableEvidence(msg)) {
    return {
      pass: false,
      reason: 'EVIDENCE_REQUIRED_NO_ARTIFACT',
      detail: 'evidence.required=true but no evidence_exchange.artifact_path provided',
    };
  }

  if (hasFakeProof(msg)) {
    return {
      pass: false,
      reason: 'FAKE_COMPLETION_PROOF',
      detail: 'terminal_decision/disposition present without evidence_exchange or legacy artifact',
    };
  }

  if (isActionable(msg)) {
    if (hasCompletionProof(msg)) {
      return { pass: true, reason: 'ACTIONABLE_WITH_PROOF', detail: null };
    }
    return {
      pass: false,
      reason: 'ACTIONABLE_MISSING_PROOF',
      detail: 'Actionable message (type=' + msg.type + ', priority=' + msg.priority + ') requires evidence_exchange or legacy artifact. Bare terminal_decision is not proof.',
    };
  }

  if (isTerminalInformational(msg)) {
    return { pass: true, reason: 'TERMINAL_INFORMATIONAL', detail: null };
  }

  if (msg.requires_action === false && !TERMINAL_TYPES.has(String(msg.type || '').toLowerCase().trim())) {
    return {
      pass: false,
      reason: 'NON_TERMINAL_TYPE',
      detail: 'type="' + msg.type + '" is not a terminal type. Terminal types: ' + [...TERMINAL_TYPES].join(', '),
    };
  }

  if (msg.requires_action === false && hasFollowupObligation(msg)) {
    return {
      pass: false,
      reason: 'HAS_FOLLOWUP_OBLIGATION',
      detail: 'Message has followup obligation (depends_on=' + !!msg.depends_on + ', creates_followup=' + !!msg.creates_followup + ', links_to_contradiction=' + !!msg.links_to_contradiction + ')',
    };
  }

  if (msg.requires_action === undefined || msg.requires_action === null) {
    return {
      pass: false,
      reason: 'AMBIGUOUS_REQUIRES_ACTION',
      detail: 'requires_action is ' + msg.requires_action + ' -- must be explicitly true or false',
    };
  }

  return {
    pass: false,
    reason: 'UNKNOWN_FAILURE',
    detail: 'Message does not meet any gate criteria (requires_action=' + msg.requires_action + ', type=' + msg.type + ')',
  };
}

function classifyProof(msg) {
  if (!msg || typeof msg !== 'object') return { type: 'NONE', path: null };

  if (msg.evidence_exchange && msg.evidence_exchange.artifact_path) {
    return { type: 'EVIDENCE_EXCHANGE', path: msg.evidence_exchange.artifact_path };
  }

  for (const field of LEGACY_ARTIFACT_FIELDS) {
    const val = msg[field];
    if (val !== undefined && val !== null && val !== '' && val !== false) {
      if (field === 'completion_artifact_path') {
        return { type: 'LEGACY_ARTIFACT_PATH', path: val };
      }
      return { type: 'LEGACY_REFERENCE', path: null, field };
    }
  }

  if (msg.evidence && msg.evidence.required === true && msg.evidence.evidence_path) {
    return { type: 'EVIDENCE_PATH', path: msg.evidence.evidence_path };
  }

  return { type: 'NONE', path: null };
}

module.exports = {
  TERMINAL_TYPES,
  LEGACY_ARTIFACT_FIELDS,
  hasCompletionProof,
  hasFakeProof,
  hasUnresolvableEvidence,
  isActionable,
  hasFollowupObligation,
  isTerminalInformational,
  evaluate,
  classifyProof,
};
