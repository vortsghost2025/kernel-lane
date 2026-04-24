#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const { ArtifactResolver } = require('./artifact-resolver');

const DEFAULT_ALLOWED_ROOTS = [
  'S:/Archivist-Agent',
  'S:/kernel-lane',
  'S:/self-organizing-library',
  'S:/SwarmMind',
];

const COMPLETION_WINDOW_MS = 5 * 60 * 1000;

class ExecutionGate {
  constructor(options = {}) {
    const rawRoots = options.allowedRoots || DEFAULT_ALLOWED_ROOTS;
    this.resolver = options.resolver || new ArtifactResolver({
      allowedRoots: rawRoots,
      dryRun: options.dryRun !== undefined ? !!options.dryRun : true,
      configPath: options.configPath,
    });
    this.lane = options.lane || 'archivist';
    this.dryRun = options.dryRun !== undefined ? !!options.dryRun : true;
    this.completionLogPath = options.completionLogPath || null;
  }

  verify(msg) {
    if (!msg || typeof msg !== 'object') {
      return {
        execution_verified: false,
        would_verify: false,
        verification_type: 'INVALID_MESSAGE',
        reason: 'Message is null or not an object',
        verifier_lane: this.lane,
        verified_at: null,
      };
    }

    const classification = this.resolver.classifyProof(msg);

    if (classification.type === 'NONE') {
      return {
        execution_verified: false,
        would_verify: false,
        verification_type: 'NO_PROOF',
        reason: 'No completion proof field present — cannot verify execution',
        verifier_lane: this.lane,
        verified_at: null,
      };
    }

    // Non-path proofs (message IDs, task IDs) — accept if referenced message exists
    if (classification.path === null) {
      const refVerified = this._verifyReference(msg, classification);
      return {
        execution_verified: refVerified.verified,
        would_verify: !!refVerified.wouldVerify,
        verification_type: classification.type,
        reason: refVerified.reason,
        verifier_lane: this.lane,
        verified_at: refVerified.verified ? new Date().toISOString() : null,
      };
    }

    // Path-based proofs — resolve artifact on filesystem
    const resolution = this.resolver.resolveMessage(msg);
    if (!resolution.resolved) {
      return {
        execution_verified: false,
        would_verify: false,
        verification_type: resolution.type,
        reason: `Artifact unresolvable: ${resolution.reason}`,
        artifact_path: resolution.path,
        verifier_lane: this.lane,
        verified_at: null,
      };
    }

    if (this.dryRun && resolution.reason === 'DRY_RUN_SKIP_FS_CHECK') {
      return {
        execution_verified: false,
        would_verify: true,
        verification_type: resolution.type,
        reason: resolution.reason,
        artifact_path: resolution.path,
        verifier_lane: this.lane,
        verified_at: null,
      };
    }

    return {
      execution_verified: true,
      would_verify: true,
      verification_type: resolution.type,
      reason: resolution.reason,
      artifact_path: resolution.path,
      verifier_lane: this.lane,
      verified_at: new Date().toISOString(),
    };
  }

  _verifyReference(msg, classification) {
    if (classification.type === 'LEGACY_MESSAGE_ID') {
      const msgId = msg.completion_message_id;
      if (!msgId) return { verified: false, wouldVerify: false, reason: 'completion_message_id is empty' };

      const found = this._findReferencedMessage(msgId, msg);
      if (found) {
        return { verified: true, wouldVerify: true, reason: 'Referenced message exists on disk' };
      }
      if (this.dryRun) {
        return { verified: false, wouldVerify: true, reason: 'DRY_RUN_SKIP_REF_CHECK' };
      }
      return { verified: false, wouldVerify: false, reason: `Referenced message not found: ${msgId}` };
    }

    if (classification.type === 'LEGACY_TASK_ID') {
      const taskId = msg.resolved_by_task_id;
      if (!taskId) return { verified: false, wouldVerify: false, reason: 'resolved_by_task_id is empty' };

      const found = this._findReferencedTask(taskId, msg);
      if (found) {
        return { verified: true, wouldVerify: true, reason: 'Referenced task exists on disk' };
      }
      if (this.dryRun) {
        return { verified: false, wouldVerify: true, reason: 'DRY_RUN_SKIP_REF_CHECK' };
      }
      return { verified: false, wouldVerify: false, reason: `Referenced task not found: ${taskId}` };
    }

    // LEGACY_REFERENCE from completion-proof classifyProof
    return { verified: false, wouldVerify: false, reason: 'NON_PATH_PROOF_UNVERIFIED' };
  }

  _findReferencedMessage(msgId, sourceMsg) {
    const searchDirs = this._getSearchDirs(sourceMsg);
    const normalizedId = String(msgId).toLowerCase();

    for (const dir of searchDirs) {
      if (!fs.existsSync(dir)) continue;
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const ent of entries) {
          if (!ent.isFile() || !ent.name.endsWith('.json')) continue;
          if (ent.name.toLowerCase().includes(normalizedId) || normalizedId.includes(ent.name.toLowerCase().replace('.json', ''))) {
            return path.join(dir, ent.name);
          }
        }
      } catch (_) {}
    }
    return null;
  }

  _findReferencedTask(taskId, sourceMsg) {
    return this._findReferencedMessage(taskId, sourceMsg);
  }

  _getSearchDirs(sourceMsg) {
    const fromLane = sourceMsg.from || 'archivist';
    const laneRootMap = {
      archivist: 'S:/Archivist-Agent',
      kernel: 'S:/kernel-lane',
      library: 'S:/self-organizing-library',
      swarmmind: 'S:/SwarmMind',
    };
    const root = laneRootMap[fromLane] || laneRootMap.archivist;
    return [
      path.join(root, 'lanes', fromLane, 'inbox', 'processed'),
      path.join(root, 'lanes', fromLane, 'outbox'),
      path.join(root, 'lanes', fromLane, 'inbox'),
    ];
  }

  stamp(msg) {
    const result = this.verify(msg);
    return {
      ...msg,
      execution_verified: result.execution_verified,
      would_verify: result.would_verify === true,
      execution_verification: {
        type: result.verification_type,
        reason: result.reason,
        would_verify: result.would_verify === true,
        verifier_lane: result.verifier_lane,
        verified_at: result.verified_at,
        artifact_path: result.artifact_path || null,
      },
    };
  }

  checkLiveness(processedDir) {
    const now = Date.now();
    const cutoff = now - COMPLETION_WINDOW_MS;
    let count = 0;

    if (!fs.existsSync(processedDir)) {
      return {
        tasks_completed_last_5min: 0,
        alert: true,
        alert_reason: 'PROCESSED_DIR_MISSING',
        checked_at: new Date().toISOString(),
      };
    }

    try {
      const entries = fs.readdirSync(processedDir, { withFileTypes: true });
      for (const ent of entries) {
        if (!ent.isFile() || !ent.name.endsWith('.json')) continue;
        const fullPath = path.join(processedDir, ent.name);
        try {
          const stat = fs.statSync(fullPath);
          if (stat.mtimeMs >= cutoff) {
            count++;
          }
        } catch (_) {}
      }
    } catch (_) {}

    const alert = count === 0;
    return {
      tasks_completed_last_5min: count,
      alert,
      alert_reason: alert ? 'ZERO_COMPLETIONS_WHILE_SYSTEM_ACTIVE' : null,
      checked_at: new Date().toISOString(),
    };
  }

  checkLivenessAcrossLanes() {
    const laneDirs = {
      archivist: 'S:/Archivist-Agent/lanes/archivist/inbox/processed',
      kernel: 'S:/kernel-lane/lanes/kernel/inbox/processed',
      library: 'S:/self-organizing-library/lanes/library/inbox/processed',
      swarmmind: 'S:/SwarmMind/lanes/swarmmind/inbox/processed',
    };

    const results = {};
    let totalCompletions = 0;

    for (const [lane, dir] of Object.entries(laneDirs)) {
      const liveness = this.checkLiveness(dir);
      results[lane] = liveness;
      totalCompletions += liveness.tasks_completed_last_5min;
    }

    return {
      total_completed_last_5min: totalCompletions,
      per_lane: results,
      system_alert: totalCompletions === 0,
      alert_reason: totalCompletions === 0 ? 'ALL_LANES_ZERO_COMPLETIONS' : null,
      checked_at: new Date().toISOString(),
    };
  }
}

module.exports = { ExecutionGate, COMPLETION_WINDOW_MS };
