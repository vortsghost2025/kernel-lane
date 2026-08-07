'use strict';

/**
 * Governance Discriminated Union Types
 *
 * Single source of truth for all governance status/type enums.
 * Derived from canonical JSON schemas in schemas/ directory.
 *
 * Rust philosophy: if a rule matters, it exists in the execution path — not only in prose.
 * These types replace scattered inline arrays/sets across governance scripts.
 * Adding a new variant HERE will cause exhaustiveSwitch() to fail in any unhandled switch,
 * providing compiler-like enforcement at the governance layer.
 *
 * @module governance-types
 */

// ─── Convergence Gate ───────────────────────────────────────────────

/**
 * @enum {string}
 * Source: schemas/inbox-message-v1.json → convergence_gate.status
 */
const ConvergenceStatus = Object.freeze({
  PROVEN: 'proven',
  UNPROVEN: 'unproven',
  CONFLICTED: 'conflicted',
  BLOCKED: 'blocked',
});

/**
 * Superset of convergence-positive statuses used across scripts.
 * Includes legacy aliases from identity-enforcer and inbox-watcher.
 *
 * ACCEPT_ALIAS ('accept') is a legacy alias for ACCEPTED ('accepted').
 * identity-enforcer.js line 257 outputs decision='accept' at runtime,
 * and historical artifacts use convergence_gate.status='accept'.
 * Both 'accepted' and 'accept' are valid; 'accept' is deprecated but
 * must remain in the set for backward compatibility.
 *
 * @enum {string}
 */
const ConvergedStatus = Object.freeze({
  PROVEN: 'proven',
  APPROVED: 'approved',
  RATIFIED: 'ratified',
  ACCEPTED: 'accepted',
  ACCEPT_ALIAS: 'accept',
});

// ─── Lane Identity ──────────────────────────────────────────────────

/**
 * @enum {string}
 * Source: schemas/inbox-message-v1.json → to (minus 'all')
 */
const LaneId = Object.freeze({
  ARCHIVIST: 'archivist',
  LIBRARY: 'library',
  SWARMIND: 'swarmmind',
  KERNEL: 'kernel',
  BROADCAST: 'broadcast',
  CONTROL_PLANE: 'control-plane',
});

/**
 * @enum {string}
 * Source: schemas/broadcast-message-v1.json → from
 */
const BroadcastSender = Object.freeze({
  ARCHIVIST: 'archivist',
  LIBRARY: 'library',
  SWARMIND: 'swarmmind',
  KERNEL: 'kernel',
  CONTROL_PLANE: 'control-plane',
});

// ─── Message Types ──────────────────────────────────────────────────

/**
 * @enum {string}
 * Source: schemas/inbox-message-v1.json → type
 *
 * Note: REQUEST is a governance extension not present in the schema's
 * type enum. inbox-watcher.js uses 'request' in ACTION_REQUIRED_TYPES.
 * The governance enum is a superset of the schema enum at this point.
 */
const MessageType = Object.freeze({
  TASK: 'task',
  RESPONSE: 'response',
  HEARTBEAT: 'heartbeat',
  ESCALATION: 'escalation',
  HANDOFF: 'handoff',
  ACK: 'ack',
  ALERT: 'alert',
  NOTIFICATION: 'notification',
  STATUS: 'status',
  REQUEST: 'request',
});

/**
 * @enum {string}
 * Source: schemas/inbox-message-v1.json → task_kind
 */
const TaskKind = Object.freeze({
  PROPOSAL: 'proposal',
  REVIEW: 'review',
  AMENDMENT: 'amendment',
  RATIFICATION: 'ratification',
  VOTE: 'vote',
  VOTE_TALLY: 'vote-tally',
  ACK: 'ack',
  DONE: 'done',
  STATUS: 'status',
  REPORT: 'report',
  HANDOFF: 'handoff',
  ALERT: 'alert',
  NOTIFICATION: 'notification',
  HEARTBEAT: 'heartbeat',
  AUDIT: 'audit',
  GOVERNANCE_DECISION: 'governance_decision',
});

/**
 * @enum {string}
 * Source: schemas/inbox-message-v1.json → priority
 */
const Priority = Object.freeze({
  P0: 'P0',
  P1: 'P1',
  P2: 'P2',
  P3: 'P3',
});

// ─── Execution ──────────────────────────────────────────────────────

/**
 * @enum {string}
 * Source: schemas/inbox-message-v1.json → execution.mode
 */
const ExecutionMode = Object.freeze({
  MANUAL: 'manual',
  SESSION_TASK: 'session_task',
  WATCHER: 'watcher',
});

/**
 * @enum {string}
 * Source: schemas/inbox-message-v1.json → execution.engine
 */
const ExecutionEngine = Object.freeze({
  KILO: 'kilo',
  OPENCODE: 'opencode',
  OTHER: 'other',
});

/**
 * @enum {string}
 * Source: schemas/inbox-message-v1.json → execution.actor
 */
const ExecutionActor = Object.freeze({
  LANE: 'lane',
  SUBAGENT: 'subagent',
  WATCHER: 'watcher',
});

// ─── Heartbeat ──────────────────────────────────────────────────────

/**
 * @enum {string}
 * Source: schemas/inbox-message-v1.json → heartbeat.status
 */
const HeartbeatStatus = Object.freeze({
  PENDING: 'pending',
  IN_PROGRESS: 'in_progress',
  DONE: 'done',
  FAILED: 'failed',
  ESCALATED: 'escalated',
  TIMED_OUT: 'timed_out',
});

/**
 * @enum {string}
 * Source: schemas/broadcast-message-v1.json → heartbeat.status
 */
const BroadcastHeartbeatStatus = Object.freeze({
  DONE: 'done',
  PENDING: 'pending',
  CRITICAL: 'critical',
});

// ─── Uncertainty ────────────────────────────────────────────────────

/**
 * @enum {string}
 * Source: schemas/inbox-message-v1.json → uncertainty.level
 * Note: schema has low|medium|high; schema-validator also allows 'critical'.
 */
const UncertaintyLevel = Object.freeze({
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
  CRITICAL: 'critical',
});

/**
 * @enum {string}
 * Source: schemas/inbox-message-v1.json → uncertainty.type items
 * Plus legacy aliases from schema-validator (execution_failure, escalated_review).
 */
const UncertaintyType = Object.freeze({
  MISSING_EVIDENCE: 'missing_evidence',
  CONFLICTING_SOURCES: 'conflicting_sources',
  TOOL_FAILURE: 'tool_failure',
  EXECUTION_FAILURE: 'execution_failure',
  STALE_STATE: 'stale_state',
  AMBIGUOUS_INTENT: 'ambiguous_intent',
  BLOCKED_BY_PERMISSION: 'blocked_by_permission',
  IMPLEMENTATION_UNKNOWN: 'implementation_unknown',
  RUNTIME_NOT_VERIFIED: 'runtime_not_verified',
  DEPENDENCY_UNRESOLVED: 'dependency_unresolved',
  PARTIAL_COMPLETION: 'partial_completion',
  ESCALATED_REVIEW: 'escalated_review',
});

// ─── Review ─────────────────────────────────────────────────────────

/**
 * @enum {string}
 * Source: schemas/inbox-message-v1.json → review.status
 */
const ReviewStatus = Object.freeze({
  DRAFT: 'draft',
  NEEDS_REPAIR: 'needs_repair',
  VERIFIED_PARTIAL: 'verified_partial',
  VERIFIED_ACCEPT: 'verified_accept',
  REJECTED: 'rejected',
  ESCALATED: 'escalated',
});

// ─── Quarantine ─────────────────────────────────────────────────────

/**
 * @enum {string}
 * Source: schemas/quarantine-manifest-v1.json → reason_category
 */
const QuarantineReason = Object.freeze({
  CORRUPT: 'CORRUPT',
  VERIFICATION_FAILED: 'VERIFICATION_FAILED',
  SIGNATURE_INVALID: 'SIGNATURE_INVALID',
  SCHEMA_INVALID: 'SCHEMA_INVALID',
  UNDER_ADJUDICATION: 'UNDER_ADJUDICATION',
  DRIFT_DETECTED: 'DRIFT_DETECTED',
  ORPHANED: 'ORPHANED',
  UNKNOWN: 'UNKNOWN',
});

/**
 * @enum {string}
 * Source: schemas/quarantine-manifest-v1.json → recovery.status
 */
const RecoveryStatus = Object.freeze({
  BLOCKED: 'BLOCKED',
  RECOVERABLE: 'RECOVERABLE',
  ESCALATED: 'ESCALATED',
  RESOLVED: 'RESOLVED',
});

/**
 * @enum {string}
 * Source: schemas/quarantine-manifest-v1.json → adjudication.status
 */
const AdjudicationStatus = Object.freeze({
  NONE: 'NONE',
  PENDING: 'PENDING',
  IN_PROGRESS: 'IN_PROGRESS',
  RESOLVED: 'RESOLVED',
});

// ─── Payload ────────────────────────────────────────────────────────

/**
 * @enum {string}
 * Source: schemas/inbox-message-v1.json → payload.mode
 */
const PayloadMode = Object.freeze({
  INLINE: 'inline',
  PATH: 'path',
  CHUNKED: 'chunked',
});

/**
 * @enum {string}
 * Source: schemas/inbox-message-v1.json → payload.compression
 */
const PayloadCompression = Object.freeze({
  NONE: 'none',
  GZIP: 'gzip',
});

// ─── Signature ──────────────────────────────────────────────────────

/**
 * @enum {string}
 * Source: schemas/inbox-message-v1.json → signature_alg
 */
const SignatureAlgorithm = Object.freeze({
  RS256: 'RS256',
  EDDSA: 'EdDSA',
});

// ─── Disposition (inbox-watcher) ────────────────────────────────────

/**
 * @enum {string}
 * Source: inbox-watcher.js VALID_DISPOSITIONS
 */
const Disposition = Object.freeze({
  COMPLETED: 'completed',
  DECLINED: 'declined',
  SUPERSEDED: 'superseded',
  EXPIRED: 'expired',
  QUARANTINED: 'quarantined',
});

// ─── Enforcement Mode ───────────────────────────────────────────────

/**
 * @enum {string}
 * Source: identity-enforcer.js enforcementMode
 */
const EnforcementMode = Object.freeze({
  ENFORCE: 'enforce',
  WARN: 'warn',
  AUDIT: 'audit',
});

// ─── Recovery Trigger ───────────────────────────────────────────────

/**
 * @enum {string}
 * Source: schemas/recovery-audit-log.json → trigger
 */
const RecoveryTrigger = Object.freeze({
  AUTO_COMPACT: 'auto-compact',
  MANUAL_COMPACT: 'manual-compact',
  COLD_START: 'cold-start',
  CRASH_RECOVERY: 'crash-recovery',
});

// ─── Lane State ─────────────────────────────────────────────────────

/**
 * @enum {string}
 * Source: trust-store.json lane state model (post-audit)
 */
const LaneState = Object.freeze({
  ACTIVE: 'ACTIVE',
  DORMANT: 'DORMANT',
  EXPERIMENTAL: 'EXPERIMENTAL',
  ARCHIVED: 'ARCHIVED',
});

// ─── Operational Mode ──────────────────────────────────────────────

/**
 * @enum {string}
 * Source: lanes/broadcast/active-mode.json mode gate
 */
const OperationalMode = Object.freeze({
  OBSERVE: 'OBSERVE',
  BUILD: 'BUILD',
  CHAOS_LAB: 'CHAOS_LAB',
  RECOVERY: 'RECOVERY',
});

// ─── Verified By ────────────────────────────────────────────────────

/**
 * @enum {string}
 * Source: schema-validator.js validVerifiers
 */
const VerifiedBy = Object.freeze({
  ARCHIVIST: 'archivist',
  LIBRARY: 'library',
  SWARMMIND: 'swarmmind',
  CODEX: 'codex',
  SELF: 'self',
  USER: 'user',
});

// ─── Frozen enum value arrays (for .includes() checks) ──────────────

const CONVERGENCE_STATUSES = Object.freeze(Object.values(ConvergenceStatus));
const CONVERGED_STATUSES = Object.freeze(Object.values(ConvergedStatus));
const LANE_IDS = Object.freeze(Object.values(LaneId));
const MESSAGE_TYPES = Object.freeze(Object.values(MessageType));
const TASK_KINDS = Object.freeze(Object.values(TaskKind));
const PRIORITIES = Object.freeze(Object.values(Priority));
const UNCERTAINTY_LEVELS = Object.freeze(Object.values(UncertaintyLevel));
const UNCERTAINTY_TYPES = Object.freeze(Object.values(UncertaintyType));
const REVIEW_STATUSES = Object.freeze(Object.values(ReviewStatus));
const QUARANTINE_REASONS = Object.freeze(Object.values(QuarantineReason));
const RECOVERY_STATUSES = Object.freeze(Object.values(RecoveryStatus));
const ADJUDICATION_STATUSES = Object.freeze(Object.values(AdjudicationStatus));
const DISPOSITIONS = Object.freeze(Object.values(Disposition));
const VERIFIED_BY = Object.freeze(Object.values(VerifiedBy));
const HEARTBEAT_STATUSES = Object.freeze(Object.values(HeartbeatStatus));
const BROADCAST_HEARTBEAT_STATUSES = Object.freeze(Object.values(BroadcastHeartbeatStatus));
const ENFORCEMENT_MODES = Object.freeze(Object.values(EnforcementMode));
const EXECUTION_MODES = Object.freeze(Object.values(ExecutionMode));
const EXECUTION_ENGINES = Object.freeze(Object.values(ExecutionEngine));
const EXECUTION_ACTORS = Object.freeze(Object.values(ExecutionActor));
const PAYLOAD_MODES = Object.freeze(Object.values(PayloadMode));
const PAYLOAD_COMPRESSIONS = Object.freeze(Object.values(PayloadCompression));
const SIGNATURE_ALGORITHMS = Object.freeze(Object.values(SignatureAlgorithm));
const RECOVERY_TRIGGERS = Object.freeze(Object.values(RecoveryTrigger));
const OPERATIONAL_MODES = Object.freeze(Object.values(OperationalMode));
const LANE_STATES = Object.freeze(Object.values(LaneState));
const BROADCAST_SENDERS = Object.freeze(Object.values(BroadcastSender));

// ─── Frozen enum value Sets (for .has() checks) ─────────────────────

/** @type {Set<string>} */
const CONVERGENCE_STATUS_SET = Object.freeze(new Set(CONVERGENCE_STATUSES));
/** @type {Set<string>} */
const CONVERGED_STATUS_SET = Object.freeze(new Set(CONVERGED_STATUSES));
/** @type {Set<string>} */
const LANE_ID_SET = Object.freeze(new Set(LANE_IDS));
/** @type {Set<string>} */
const MESSAGE_TYPE_SET = Object.freeze(new Set(MESSAGE_TYPES));
/** @type {Set<string>} */
const TASK_KIND_SET = Object.freeze(new Set(TASK_KINDS));
/** @type {Set<string>} */
const PRIORITY_SET = Object.freeze(new Set(PRIORITIES));
/** @type {Set<string>} */
const UNCERTAINTY_LEVEL_SET = Object.freeze(new Set(UNCERTAINTY_LEVELS));
/** @type {Set<string>} */
const UNCERTAINTY_TYPE_SET = Object.freeze(new Set(UNCERTAINTY_TYPES));
/** @type {Set<string>} */
const REVIEW_STATUS_SET = Object.freeze(new Set(REVIEW_STATUSES));
/** @type {Set<string>} */
const QUARANTINE_REASON_SET = Object.freeze(new Set(QUARANTINE_REASONS));
/** @type {Set<string>} */
const RECOVERY_STATUS_SET = Object.freeze(new Set(RECOVERY_STATUSES));
/** @type {Set<string>} */
const ADJUDICATION_STATUS_SET = Object.freeze(new Set(ADJUDICATION_STATUSES));
/** @type {Set<string>} */
const DISPOSITION_SET = Object.freeze(new Set(DISPOSITIONS));
/** @type {Set<string>} */
const VERIFIED_BY_SET = Object.freeze(new Set(VERIFIED_BY));
/** @type {Set<string>} */
const HEARTBEAT_STATUS_SET = Object.freeze(new Set(HEARTBEAT_STATUSES));
/** @type {Set<string>} */
const ENFORCEMENT_MODE_SET = Object.freeze(new Set(ENFORCEMENT_MODES));
/** @type {Set<string>} */
const OPERATIONAL_MODE_SET = Object.freeze(new Set(OPERATIONAL_MODES));
/** @type {Set<string>} */
const LANE_STATE_SET = Object.freeze(new Set(LANE_STATES));

// ─── Exhaustive Switch Enforcement ──────────────────────────────────

/**
 * Exhaustive switch check — Rust's match enforcement ported to JS.
 *
 * Call this in the default case of every switch on a governance enum:
 *   switch (status) {
 *     case ConvergenceStatus.PROVEN: ...
 *     case ConvergenceStatus.UNPROVEN: ...
 *     case ConvergenceStatus.CONFLICTED: ...
 *     case ConvergenceStatus.BLOCKED: ...
 *     default: exhaustiveSwitch(status, 'ConvergenceStatus');
 *   }
 *
 * If all cases are handled, TypeScript narrows `value` to `never` and no
 * runtime error occurs. If a new variant is added to the enum but the
 * switch isn't updated, the `never` type assertion fails at type-check
 * time AND a descriptive Error throws at runtime.
 *
 * @template T
 * @param {T} value - The switch value (should be `never` if exhaustive)
 * @param {string} enumName - Human-readable enum name for error messages
 * @returns {never}
 * @throws {Error} If an unhandled variant reaches the default branch
 */
function exhaustiveSwitch(value, enumName) {
  throw new Error(
    `GOVERNANCE_EXHAUSTIVE_VIOLATION: Unhandled ${enumName} variant "${value}". ` +
    `Add a case for this variant or update the ${enumName} enum.`
  );
}

/**
 * @typedef {Object} ValidateEnumOk
 * @property {true} ok
 * @property {string} value
 */

/**
 * @typedef {Object} ValidateEnumErr
 * @property {false} ok
 * @property {string} error
 */

/**
 * Validate that a value belongs to a governance enum.
 * Returns a Result-style object instead of throwing.
 *
 * @param {string} value
 * @param {ReadonlyArray<string>} enumValues
 * @param {string} enumName
 * @returns {ValidateEnumOk | ValidateEnumErr}
 */
function validateEnum(value, enumValues, enumName) {
  if (enumValues.includes(value)) {
    return { ok: true, value };
  }
  return { ok: false, error: `Invalid ${enumName}: "${value}". Must be one of: ${enumValues.join(', ')}` };
}

module.exports = {
  ConvergenceStatus,
  ConvergedStatus,
  LaneId,
  BroadcastSender,
  MessageType,
  TaskKind,
  Priority,
  ExecutionMode,
  ExecutionEngine,
  ExecutionActor,
  HeartbeatStatus,
  BroadcastHeartbeatStatus,
  UncertaintyLevel,
  UncertaintyType,
  ReviewStatus,
  QuarantineReason,
  RecoveryStatus,
  AdjudicationStatus,
  PayloadMode,
  PayloadCompression,
  SignatureAlgorithm,
  Disposition,
  EnforcementMode,
  RecoveryTrigger,
  OperationalMode,
  LaneState,
  VerifiedBy,
  CONVERGENCE_STATUSES,
  CONVERGED_STATUSES,
  LANE_IDS,
  MESSAGE_TYPES,
  TASK_KINDS,
  PRIORITIES,
  UNCERTAINTY_LEVELS,
  UNCERTAINTY_TYPES,
  REVIEW_STATUSES,
  QUARANTINE_REASONS,
  RECOVERY_STATUSES,
  ADJUDICATION_STATUSES,
  DISPOSITIONS,
  VERIFIED_BY,
  HEARTBEAT_STATUSES,
  BROADCAST_HEARTBEAT_STATUSES,
  ENFORCEMENT_MODES,
  OPERATIONAL_MODES,
  EXECUTION_MODES,
  EXECUTION_ENGINES,
  EXECUTION_ACTORS,
  PAYLOAD_MODES,
  PAYLOAD_COMPRESSIONS,
  SIGNATURE_ALGORITHMS,
  RECOVERY_TRIGGERS,
  LANE_STATES,
  BROADCAST_SENDERS,
  CONVERGENCE_STATUS_SET,
  CONVERGED_STATUS_SET,
  LANE_ID_SET,
  MESSAGE_TYPE_SET,
  TASK_KIND_SET,
  PRIORITY_SET,
  UNCERTAINTY_LEVEL_SET,
  UNCERTAINTY_TYPE_SET,
  REVIEW_STATUS_SET,
  QUARANTINE_REASON_SET,
  RECOVERY_STATUS_SET,
  ADJUDICATION_STATUS_SET,
  DISPOSITION_SET,
  VERIFIED_BY_SET,
  HEARTBEAT_STATUS_SET,
  ENFORCEMENT_MODE_SET,
  OPERATIONAL_MODE_SET,
  LANE_STATE_SET,
  exhaustiveSwitch,
  validateEnum,
};
