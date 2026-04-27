#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

let _discovery = null;
try {
  const { LaneDiscovery } = require('S:/Archivist-Agent/.global/lane-discovery');
  _discovery = new LaneDiscovery();
} catch (_) {}

function _getDefaultAllowedRoots() {
  if (_discovery) {
    const roots = [];
    for (const laneId of _discovery.listLanes()) {
      try { roots.push(_discovery.getLocalPath(laneId)); } catch (_) {}
    }
    if (roots.length > 0) return roots;
  }
  return ['S:/Archivist-Agent', 'S:/kernel-lane', 'S:/self-organizing-library', 'S:/SwarmMind Self-Optimizing Multi-Agent AI System'];
}

const DEFAULT_ALLOWED_ROOTS = _getDefaultAllowedRoots();

function normalizePath(p) {
  return p.replace(/\\/g, '/').toLowerCase();
}

function isContainedWithin(childResolved, rootNormalized) {
  const childNorm = normalizePath(childResolved);
  return childNorm === rootNormalized || childNorm.startsWith(rootNormalized + '/');
}

class ArtifactResolver {
  constructor(options = {}) {
    const rawRoots = options.allowedRoots || this._loadAllowedRoots(options.configPath);
    this.allowedRoots = rawRoots.map(r => normalizePath(path.resolve(r)));
    this._rawAllowedRoots = rawRoots;
    this.dryRun = options.dryRun !== undefined ? !!options.dryRun : true;
  }

  _loadAllowedRoots(configPath) {
    const searchPaths = [
      configPath,
      path.join(process.cwd(), 'config', 'allowed_roots.json'),
    ];

    for (const laneRoot of _getDefaultAllowedRoots()) {
      searchPaths.push(path.join(laneRoot, 'config', 'allowed_roots.json'));
    }

    for (const p of searchPaths) {
      if (!p) continue;
      try {
        const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
        if (Array.isArray(raw.allowed_roots) && raw.allowed_roots.length > 0) {
          return raw.allowed_roots;
        }
      } catch (_) {}
    }

    return [..._getDefaultAllowedRoots()];
  }

  isWithinAllowedRoots(artifactPath) {
    if (!artifactPath || typeof artifactPath !== 'string') return false;
    try {
      const resolved = path.resolve(artifactPath);
      for (const root of this.allowedRoots) {
        if (isContainedWithin(resolved, root)) return true;
      }
    } catch (_) {
      return false;
    }
    return false;
  }

  hasPathTraversal(artifactPath) {
    if (!artifactPath || typeof artifactPath !== 'string') return true;
    try {
      const resolved = path.resolve(artifactPath);
      return !this.isWithinAllowedRoots(resolved);
    } catch (_) {
      return true;
    }
  }

  resolveRelativePath(artifactPath) {
    if (!artifactPath || typeof artifactPath !== 'string') return null;
    if (path.isAbsolute(artifactPath)) return artifactPath;

    const candidates = [];
    for (const rawRoot of this._rawAllowedRoots) {
      const candidate = path.join(rawRoot, artifactPath);
      const resolved = path.resolve(candidate);
      if (!this.isWithinAllowedRoots(resolved)) continue;
      if (fs.existsSync(candidate)) return candidate;
      candidates.push(candidate);
    }
    return candidates.length > 0 ? candidates[0] : null;
  }

  resolveExists(artifactPath) {
    if (!artifactPath || typeof artifactPath !== 'string') {
      return { exists: false, reason: 'EMPTY_PATH' };
    }

    if (this.hasPathTraversal(artifactPath)) {
      return { exists: false, reason: 'PATH_TRAVERSAL_REJECTED' };
    }

    let resolvedPath = artifactPath;
    if (!path.isAbsolute(artifactPath)) {
      const resolved = this.resolveRelativePath(artifactPath);
      if (!resolved) {
        return { exists: false, reason: 'OUTSIDE_ALLOWED_ROOTS' };
      }
      resolvedPath = resolved;
    } else if (!this.isWithinAllowedRoots(artifactPath)) {
      return { exists: false, reason: 'OUTSIDE_ALLOWED_ROOTS' };
    }

    if (this.dryRun) {
      return { exists: true, reason: 'DRY_RUN_SKIP_FS_CHECK', path: resolvedPath };
    }

    try {
      const stat = fs.statSync(resolvedPath);
      return { exists: true, reason: 'FILE_EXISTS', path: resolvedPath, isFile: stat.isFile() };
    } catch (_) {
      return { exists: false, reason: 'FILE_NOT_FOUND', path: resolvedPath };
    }
  }

  classifyProof(msg) {
    if (!msg || typeof msg !== 'object') return { type: 'NONE', path: null };

    if (msg.evidence_exchange && msg.evidence_exchange.artifact_path) {
      return { type: 'EVIDENCE_EXCHANGE', path: msg.evidence_exchange.artifact_path };
    }

    if (msg.completion_artifact_path) {
      return { type: 'LEGACY_ARTIFACT_PATH', path: msg.completion_artifact_path };
    }

    if (msg.completion_message_id) {
      return { type: 'LEGACY_MESSAGE_ID', path: null };
    }

    if (msg.resolved_by_task_id) {
      return { type: 'LEGACY_TASK_ID', path: null };
    }

    if (msg.evidence && msg.evidence.required === true && msg.evidence.evidence_path) {
      return { type: 'EVIDENCE_PATH', path: msg.evidence.evidence_path };
    }

    return { type: 'NONE', path: null };
  }

  resolveMessage(msg) {
    const classification = this.classifyProof(msg);

    if (classification.type === 'NONE') {
      return {
        resolved: false,
        type: classification.type,
        path: null,
        reason: 'NO_PROOF_FIELD_PRESENT',
      };
    }

    if (classification.path === null) {
      return {
        resolved: true,
        type: classification.type,
        path: null,
        reason: 'NON_PATH_PROOF_ACCEPTED',
      };
    }

    const fileResult = this.resolveExists(classification.path);
    if (!fileResult.exists) {
      return {
        resolved: false,
        type: classification.type,
        path: classification.path,
        reason: fileResult.reason,
      };
    }

    return {
      resolved: true,
      type: classification.type,
      path: classification.path,
      reason: fileResult.reason,
    };
  }
}

module.exports = { ArtifactResolver, normalizePath, DEFAULT_ALLOWED_ROOTS };
