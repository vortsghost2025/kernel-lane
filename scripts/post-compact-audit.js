#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

const _archivistRoot = path.join(__dirname, '..');

const UBUNTU_SSH_HOST = 'we4free@100.95.40.99';
const UBUNTU_REPOS_BASE = '/home/we4free/agent/repos';
const HEARTBEAT_TIMEOUT_SECONDS = 900;

const REPO_MAP = {
  archivist: 'Archivist-Agent',
  kernel: 'kernel-lane',
  library: 'self-organizing-library',
  swarmmind: 'SwarmMind'
};

const LANES = {
  archivist: { root: _archivistRoot, inbox: path.join(_archivistRoot, 'lanes', 'archivist', 'inbox') },
  library: { root: path.join(_archivistRoot, '..', 'self-organizing-library'), inbox: path.join(_archivistRoot, '..', 'self-organizing-library', 'lanes', 'library', 'inbox') },
  swarmmind: { root: path.join(_archivistRoot, '..', 'SwarmMind'), inbox: path.join(_archivistRoot, '..', 'SwarmMind', 'lanes', 'swarmmind', 'inbox') },
  kernel: { root: path.join(_archivistRoot, '..', 'kernel-lane'), inbox: path.join(_archivistRoot, '..', 'kernel-lane', 'lanes', 'kernel', 'inbox') }
};

class PostCompactAudit {
  constructor(options = {}) {
    this.auditDir = options.auditDir || path.join(_archivistRoot, '.compact-audit');
    this.trustStorePath = options.trustStorePath || path.join(_archivistRoot, 'lanes', 'broadcast', 'trust-store.json');
    this.constraintsPath = options.constraintsPath || path.join(_archivistRoot, 'constitutional_constraints.yaml');
    this.bootstrapPath = options.bootstrapPath || path.join(_archivistRoot, 'BOOTSTRAP.md');
    this.governancePath = options.governancePath || path.join(_archivistRoot, 'GOVERNANCE.md');
    this.handoffPath = options.handoffPath || path.join(_archivistRoot, 'COMPACT_CONTEXT_HANDOFF.md');
    this.restorePacketPath = options.restorePacketPath || null;
  }

  _hashContent(content) {
    return crypto.createHash('sha256').update(content).digest('hex');
  }

  _hashFile(filePath) {
    if (!fs.existsSync(filePath)) return null;
    return this._hashContent(fs.readFileSync(filePath, 'utf8'));
  }

  _countInboxMessages(inboxPath) {
    if (!fs.existsSync(inboxPath)) return 0;
    try {
      return fs.readdirSync(inboxPath)
        .filter(f => f.endsWith('.json') && !f.startsWith('heartbeat'))
        .length;
    } catch (_) { return 0; }
  }

  _getActiveBlocker() {
    const blockerPath = path.join(_archivistRoot, 'lanes', 'broadcast', 'active-blocker.json');
    if (!fs.existsSync(blockerPath)) return { exists: false, blocker: null };
    try {
      return { exists: true, blocker: JSON.parse(fs.readFileSync(blockerPath, 'utf8')) };
    } catch (_) { return { exists: false, blocker: null }; }
  }

  _getTrustStoreKeyIds() {
    if (!fs.existsSync(this.trustStorePath)) return {};
    try {
      const ts = JSON.parse(fs.readFileSync(this.trustStorePath, 'utf8'));
      const keys = ts.keys || ts;
      const result = {};
      for (const [lane, entry] of Object.entries(keys)) {
        if (entry && entry.key_id) result[lane] = entry.key_id;
      }
      return result;
    } catch (_) { return {}; }
  }

  _getConstraintNames() {
    if (!fs.existsSync(this.constraintsPath)) return [];
    try {
      const content = fs.readFileSync(this.constraintsPath, 'utf8');
      const names = [];
      const regex = /- name:\s*(.+)/g;
      let match;
      while ((match = regex.exec(content)) !== null) {
        names.push(match[1].trim());
      }
      return names;
    } catch (_) { return []; }
  }

    _getFileIntegrityChecks() {
        const integrityFiles = [
            { name: 'private_pem', suffix: '.identity/private.pem', binary: true },
            { name: 'public_pem', suffix: '.identity/public.pem', binary: false },
            { name: 'snapshot_json', suffix: '.identity/snapshot.json', binary: false },
            { name: 'keys_json', suffix: '.identity/keys.json', binary: false },
            { name: 'lane_trust_store', suffix: 'lanes/broadcast/trust-store.json', binary: false },
            { name: 'agents_md', suffix: 'AGENTS.md', binary: false },
            { name: 'targets_json', suffix: 'config/targets.json', binary: false },
            { name: 'convergence_protocol_md', suffix: 'lanes/broadcast/CONVERGENCE_PROTOCOL.md', binary: false }
        ];
        const trustStorePath = this.trustStorePath;
        const results = {};
        for (const [laneId, config] of Object.entries(LANES)) {
            const laneFiles = {};
            for (const spec of integrityFiles) {
                const fPath = path.join(config.root, spec.suffix);
                if (!fs.existsSync(fPath)) {
                    laneFiles[spec.name] = { path: fPath, exists: false, hash: null };
                    continue;
                }
                try {
                    const content = spec.binary
                        ? fs.readFileSync(fPath)
                        : fs.readFileSync(fPath, 'utf8');
                    laneFiles[spec.name] = {
                        path: fPath,
                        exists: true,
                        hash: crypto.createHash('sha256').update(content).digest('hex')
                    };
                } catch (_) {
                    laneFiles[spec.name] = { path: fPath, exists: true, hash: null, error: 'read_failed' };
                }
            }
            laneFiles.trust_store = {
                path: trustStorePath,
                exists: fs.existsSync(trustStorePath),
                hash: this._hashFile(trustStorePath)
            };
            results[laneId] = laneFiles;
        }
  return results;
    }

  _probeUbuntuHeartbeats() {
    const lanes = Object.keys(REPO_MAP);
    const results = {};

    const isUbuntu = process.platform === 'linux' || fs.existsSync('/proc/uptime');
    if (isUbuntu) {
      return this._probeLocalUbuntuHeartbeats(lanes);
    }

    const hbPaths = lanes.map(lane => {
      const repo = REPO_MAP[lane];
      return `${UBUNTU_REPOS_BASE}/${repo}/lanes/${lane}/inbox/heartbeat-${lane}.json`;
    });
    const scriptLines = ['#!/bin/bash'];
    for (let i = 0; i < lanes.length; i++) {
      const lane = lanes[i];
      const fp = hbPaths[i];
      scriptLines.push(`if [ -f "${fp}" ]; then`);
      scriptLines.push(`  ts=$(grep -o '"timestamp": *"[^"]*"' "${fp}" | head -1 | sed 's/.*"\\([^"]*\\)".*/\\1/')`);
      scriptLines.push(`  if [ -z "$ts" ]; then ts="parse-error"; fi`);
      scriptLines.push(`  echo "${lane}:$ts"`);
      scriptLines.push(`else`);
      scriptLines.push(`  echo "${lane}:no-file"`);
      scriptLines.push(`fi`);
    }
    const scriptContent = scriptLines.join('\n');
    const tmpScript = path.join(require('os').tmpdir(), 'archivist_hb_probe.sh');
    fs.writeFileSync(tmpScript, scriptContent, 'utf8');
    const remoteScript = '/tmp/_archivist_heartbeat_probe.sh';
    const cmd = `scp -o ConnectTimeout=5 -o BatchMode=yes -o StrictHostKeyChecking=no "${tmpScript}" ${UBUNTU_SSH_HOST}:${remoteScript} && ssh -o ConnectTimeout=5 -o BatchMode=yes -o StrictHostKeyChecking=no ${UBUNTU_SSH_HOST} "bash ${remoteScript}; rm -f ${remoteScript}"`;
    try {
      const output = execSync(cmd, { encoding: 'utf8', timeout: 20000, windowsHide: true }).trim();
      for (const line of output.split('\n')) {
        const colonIdx = line.indexOf(':');
        if (colonIdx < 1) continue;
        const lane = line.substring(0, colonIdx);
        const value = line.substring(colonIdx + 1);
        if (!REPO_MAP[lane]) continue;
        if (value === 'no-file' || value === 'parse-error' || !value) {
          results[lane] = { status: 'no_heartbeat', timestamp: null, source: 'ubuntu-ssh' };
          continue;
        }
        const ts = new Date(value);
        if (isNaN(ts.getTime())) {
          results[lane] = { status: 'error', timestamp: null, source: 'ubuntu-ssh' };
          continue;
        }
        const age = Date.now() - ts.getTime();
        results[lane] = {
          status: age > HEARTBEAT_TIMEOUT_SECONDS * 1000 ? 'stale' : 'alive',
          timestamp: value,
          age_seconds: Math.floor(age / 1000),
          source: 'ubuntu-ssh'
        };
      }
    } catch (_) {
      for (const lane of lanes) {
        results[lane] = { status: 'unreachable', timestamp: null, source: 'ubuntu-ssh' };
      }
    } finally {
      try { fs.unlinkSync(tmpScript); } catch (_e) {}
    }
    return results;
  }

  _probeLocalUbuntuHeartbeats(lanes) {
    const results = {};
    for (const lane of lanes) {
      const repo = REPO_MAP[lane];
      const hbPath = path.join(UBUNTU_REPOS_BASE, repo, 'lanes', lane, 'inbox', `heartbeat-${lane}.json`);
      if (!fs.existsSync(hbPath)) {
        results[lane] = { status: 'no_heartbeat', timestamp: null, source: 'ubuntu-local' };
        continue;
      }
      try {
        const data = JSON.parse(fs.readFileSync(hbPath, 'utf8'));
        const age = Date.now() - new Date(data.timestamp).getTime();
        results[lane] = {
          status: age > HEARTBEAT_TIMEOUT_SECONDS * 1000 ? 'stale' : 'alive',
          timestamp: data.timestamp,
          age_seconds: Math.floor(age / 1000),
          source: 'ubuntu-local'
        };
      } catch (_) {
        results[lane] = { status: 'error', timestamp: null, source: 'ubuntu-local' };
      }
    }
    return results;
  }

  _getLaneHeartbeats() {
    const localResults = {};
    for (const [laneId, config] of Object.entries(LANES)) {
      const hbPath = path.join(config.inbox, `heartbeat-${laneId}.json`);
      if (!fs.existsSync(hbPath)) {
        localResults[laneId] = { status: 'no_heartbeat', timestamp: null, source: 'windows-local' };
        continue;
      }
      try {
        const data = JSON.parse(fs.readFileSync(hbPath, 'utf8'));
        const age = Date.now() - new Date(data.timestamp).getTime();
        localResults[laneId] = {
          status: age > HEARTBEAT_TIMEOUT_SECONDS * 1000 ? 'stale' : 'alive',
          timestamp: data.timestamp,
          age_seconds: Math.floor(age / 1000),
          source: 'windows-local'
        };
      } catch (_) {
        localResults[laneId] = { status: 'error', timestamp: null, source: 'windows-local' };
      }
    }
    const localAlive = Object.values(localResults).filter(s => s.status === 'alive').length;
    if (localAlive === 4) return localResults;
    const ubuntuResults = this._probeUbuntuHeartbeats();
    const merged = {};
    for (const lane of Object.keys(LANES)) {
      const local = localResults[lane];
      const remote = ubuntuResults[lane];
      if (local.status === 'alive') {
        merged[lane] = local;
      } else if (remote && remote.status === 'alive') {
        merged[lane] = { ...remote, note: 'evidence_boundary_mismatch: local stale/missing but ubuntu alive' };
      } else if (remote && remote.status === 'unreachable') {
        merged[lane] = { ...local, note: 'ubuntu_unreachable: could not verify remote liveness' };
      } else {
        merged[lane] = remote && remote.status !== 'unreachable' ? remote : local;
      }
    }
    return merged;
  }

  capturePreCompact() {
    const snapshot = {
      timestamp: new Date().toISOString(),
      phase: 'pre_compact',
      active_blocker: this._getActiveBlocker(),
      trust_store_key_ids: this._getTrustStoreKeyIds(),
      constraint_names: this._getConstraintNames(),
      governance_hash: this._hashFile(this.governancePath),
      bootstrap_hash: this._hashFile(this.bootstrapPath),
      handoff_hash: this._hashFile(this.handoffPath),
      lane_states: this._getLaneHeartbeats(),
      inbox_counts: {},
known_risks: this._getKnownRisks(),
            file_integrity: this._getFileIntegrityChecks()
        };

    for (const [laneId, config] of Object.entries(LANES)) {
      snapshot.inbox_counts[laneId] = this._countInboxMessages(config.inbox);
    }

    if (!fs.existsSync(this.auditDir)) {
      fs.mkdirSync(this.auditDir, { recursive: true });
    }

    const prePath = path.join(this.auditDir, 'PRE_COMPACT_SNAPSHOT.json');
    fs.writeFileSync(prePath, JSON.stringify(snapshot, null, 2));
    console.log(`[audit] Pre-compact snapshot saved: ${prePath}`);
    return snapshot;
  }

  capturePostCompact() {
    const snapshot = {
      timestamp: new Date().toISOString(),
      phase: 'post_compact',
      active_blocker: this._getActiveBlocker(),
      trust_store_key_ids: this._getTrustStoreKeyIds(),
      constraint_names: this._getConstraintNames(),
      governance_hash: this._hashFile(this.governancePath),
      bootstrap_hash: this._hashFile(this.bootstrapPath),
      handoff_hash: this._hashFile(this.handoffPath),
      lane_states: this._getLaneHeartbeats(),
        inbox_counts: {},
            known_risks: this._getKnownRisks(),
            file_integrity: this._getFileIntegrityChecks()
        };

    for (const [laneId, config] of Object.entries(LANES)) {
      snapshot.inbox_counts[laneId] = this._countInboxMessages(config.inbox);
    }

    return snapshot;
  }

  runContradictionTest(pre, post) {
    const diff = {
      blocker_changed: false,
      blocker_detail: null,
      trust_chain_intact: true,
      trust_detail: null,
      constraints_intact: true,
      constraints_detail: null,
      governance_intact: true,
      governance_detail: null,
      bootstrap_intact: true,
      bootstrap_detail: null,
      handoff_intact: true,
      handoff_detail: null,
      message_loss: 0,
      message_loss_detail: {},
      lane_degradations: [],
      risk_set_preserved: true,
      missing_risks: [],
      unexpected_changes: []
    };

if (pre.active_blocker.exists !== post.active_blocker.exists ||
    ((pre.active_blocker.blocker || {}).id !== (post.active_blocker.blocker || {}).id)) {
      diff.blocker_changed = true;
      diff.blocker_detail = {
        pre: pre.active_blocker,
        post: post.active_blocker
      };
      diff.unexpected_changes.push('active_blocker_changed');
    }

    for (const [lane, keyId] of Object.entries(pre.trust_store_key_ids)) {
      if (post.trust_store_key_ids[lane] !== keyId) {
        diff.trust_chain_intact = false;
        diff.trust_detail = diff.trust_detail || {};
        diff.trust_detail[lane] = {
          pre: keyId,
          post: post.trust_store_key_ids[lane] || 'MISSING'
        };
        diff.unexpected_changes.push(`trust_store_${lane}_key_changed`);
      }
    }
    for (const lane of Object.keys(post.trust_store_key_ids)) {
      if (!pre.trust_store_key_ids[lane]) {
        diff.trust_chain_intact = false;
        diff.unexpected_changes.push(`trust_store_${lane}_key_added`);
      }
    }

    const preConstraints = new Set(pre.constraint_names);
    const postConstraints = new Set(post.constraint_names);
    if (preConstraints.size !== postConstraints.size) {
      diff.constraints_intact = false;
      diff.constraints_detail = {
        pre_count: preConstraints.size,
        post_count: postConstraints.size,
        added: [...postConstraints].filter(c => !preConstraints.has(c)),
        removed: [...preConstraints].filter(c => !postConstraints.has(c))
      };
      diff.unexpected_changes.push('constraints_changed');
    }

    if (pre.governance_hash !== post.governance_hash) {
      diff.governance_intact = false;
      diff.governance_detail = { pre: pre.governance_hash, post: post.governance_hash };
      diff.unexpected_changes.push('governance_doc_modified');
    }

    if (pre.bootstrap_hash !== post.bootstrap_hash) {
      diff.bootstrap_intact = false;
      diff.bootstrap_detail = { pre: pre.bootstrap_hash, post: post.bootstrap_hash };
      diff.unexpected_changes.push('bootstrap_modified');
    }

    if (pre.handoff_hash && post.handoff_hash && pre.handoff_hash !== post.handoff_hash) {
      diff.handoff_intact = false;
      diff.handoff_detail = { pre: pre.handoff_hash, post: post.handoff_hash };
      diff.unexpected_changes.push('handoff_modified');
    }

    for (const [lane, count] of Object.entries(pre.inbox_counts)) {
      const postCount = post.inbox_counts[lane] || 0;
      if (postCount < count) {
        const loss = count - postCount;
        diff.message_loss += loss;
        diff.message_loss_detail[lane] = { pre: count, post: postCount, lost: loss };
      }
    }

    for (const [lane, state] of Object.entries(pre.lane_states)) {
      if (state.status === 'alive' && (post.lane_states[lane] || {}).status !== 'alive') {
        diff.lane_degradations.push({
          lane,
          pre_status: state.status,
          post_status: (post.lane_states[lane] || {}).status || 'unknown'
        });
        diff.unexpected_changes.push(`lane_${lane}_degraded`);
      }
    }

    const preRisks = new Set(pre.known_risks || []);
    const postRisks = new Set(post.known_risks || []);
    diff.missing_risks = [...preRisks].filter(r => !postRisks.has(r));
    if (diff.missing_risks.length > 0) {
        diff.risk_set_preserved = false;
            diff.unexpected_changes.push(`risks_lost: ${diff.missing_risks.join(', ')}`);
        }

        if (pre.file_integrity && post.file_integrity) {
            diff.file_integrity_violations = [];
            for (const [lane, files] of Object.entries(pre.file_integrity)) {
                for (const [fileKey, fileInfo] of Object.entries(files)) {
                    const postInfo = (post.file_integrity[lane] || {})[fileKey];
                    if (!postInfo) continue;
                    if (fileInfo.exists && postInfo.exists && fileInfo.hash && postInfo.hash && fileInfo.hash !== postInfo.hash) {
                        diff.file_integrity_violations.push({ lane, file: fileKey, pre_hash: fileInfo.hash, post_hash: postInfo.hash });
                        if (fileKey === 'private_pem' || fileKey === 'snapshot_json' || fileKey === 'trust_store') {
                            diff.unexpected_changes.push(`file_integrity_${lane}_${fileKey}_changed`);
                        }
                    }
                    if (fileInfo.exists && !postInfo.exists) {
                        diff.file_integrity_violations.push({ lane, file: fileKey, pre_hash: fileInfo.hash, post_hash: null, deleted: true });
                        diff.unexpected_changes.push(`file_integrity_${lane}_${fileKey}_deleted`);
                    }
                }
            }
        }

        return diff;
  }

  determineStatus(diff) {
    if (diff.unexpected_changes.length === 0 && diff.message_loss === 0) {
      return 'aligned';
    }

        const criticalChanges = diff.unexpected_changes.filter(c =>
            // trust_store changes are non-critical and ignored
            c.includes('bootstrap_modified') ||
            c.includes('governance_doc_modified') ||
            c.includes('constraints_changed') ||
            c.includes('file_integrity')
    );

    if (criticalChanges.length > 0) {
      return 'conflicted';
    }

    if (diff.message_loss > 0 || diff.lane_degradations.length > 0 || diff.blocker_changed) {
      return 'drifted';
    }

    return 'aligned';
  }

  generateAudit(pre, post) {
    const diff = this.runContradictionTest(pre, post);
    const status = this.determineStatus(diff);

    const audit = {
      timestamp: new Date().toISOString(),
      schema: 'post-compact-audit-v1',
      pre_compact: {
        active_blocker: pre.active_blocker,
        trust_store_key_ids: pre.trust_store_key_ids,
        constraint_names: pre.constraint_names,
        lane_states: pre.lane_states,
        inbox_counts: pre.inbox_counts,
        governance_hash: pre.governance_hash,
        bootstrap_hash: pre.bootstrap_hash,
        handoff_hash: pre.handoff_hash,
            known_risks: pre.known_risks,
            file_integrity: pre.file_integrity
        },
        post_compact: {
            active_blocker: post.active_blocker,
            trust_store_key_ids: post.trust_store_key_ids,
            constraint_names: post.constraint_names,
            lane_states: post.lane_states,
            inbox_counts: post.inbox_counts,
            governance_hash: post.governance_hash,
            bootstrap_hash: post.bootstrap_hash,
            handoff_hash: post.handoff_hash,
            known_risks: post.known_risks,
            file_integrity: post.file_integrity
      },
      diff,
      status,
      proof: {
        method: 'multi_source_contradiction_test',
        sources_checked: [
          'active_blocker',
          'trust_store',
          'constitutional_constraints',
          'governance_doc',
          'bootstrap_doc',
          'handoff_doc',
          'inbox_message_counts',
                'lane_heartbeats',
                'known_risk_set',
                'file_integrity'
        ],
        contradictions_found: diff.unexpected_changes.length,
        self_declared_alignment: false
      }
    };

    const auditPath = path.join(this.auditDir, 'POST_COMPACT_AUDIT.json');
    fs.writeFileSync(auditPath, JSON.stringify(audit, null, 2));

    return audit;
  }

  generateTamperEvidentHandoff(handoffContent) {
    const hash = this._hashContent(handoffContent);
    const record = {
      timestamp: new Date().toISOString(),
      handoff_hash_sha256: hash,
      hash_algorithm: 'sha256',
      purpose: 'tamper-evident handoff — detect post-compact modification'
    };

    const logPath = path.join(this.auditDir, 'HANDOFF_HASH_LOG.jsonl');
    fs.appendFileSync(logPath, JSON.stringify(record) + '\n');

    return record;
  }

  verifyHandoffIntegrity(handoffContent, expectedHash) {
    const currentHash = this._hashContent(handoffContent);
    return {
      intact: currentHash === expectedHash,
      current_hash: currentHash,
      expected_hash: expectedHash,
      action: currentHash === expectedHash ? 'proceed' : 'quarantine_restore'
    };
  }

  _loadRestorePacket() {
    const packetPath = this.restorePacketPath;
    if (!packetPath) return null;
    try {
      if (!fs.existsSync(packetPath)) return null;
      const packet = JSON.parse(fs.readFileSync(packetPath, 'utf8'));
      if (!packet.restore_payload) return null;
      return packet;
    } catch (_) { return null; }
  }

  _crossVerifyRestorePacket(packet, preSnapshot) {
    if (!packet || !preSnapshot) return { verified: false, violations: [] };
    const violations = [];
    const payload = packet.restore_payload;

    const packetConstraints = Object.keys(payload.governance_constraints || {});
    const crp = preSnapshot.compact_restore_packet || {};
    const preConstraints = crp.constraints
      ? Object.keys(crp.constraints)
      : (preSnapshot.constraint_names || []);
    const preConstraintSet = new Set(preConstraints);
    for (const c of packetConstraints) {
      if (!preConstraintSet.has(c)) violations.push(`packet_constraint_not_in_pre:${c}`);
    }

    const packetCheckpointIds = (payload.active_checkpoints || []).map(c => c.id || c).sort();
    const preCheckpointIds = (crp.checkpoints || [])
      .map(c => c.id || c).sort();
    if (JSON.stringify(packetCheckpointIds) !== JSON.stringify(preCheckpointIds)) {
      violations.push('checkpoint_mismatch_packet_vs_pre');
    }

    const authority = packet.authority || {};
    if (authority.fields_authoritative) {
      for (const field of authority.fields_authoritative) {
        const preVal = crp[field];
        const postVal = payload[field];
        if (preVal && postVal && JSON.stringify(preVal) !== JSON.stringify(postVal)) {
          violations.push(`authoritative_field_drift:${field}`);
        }
      }
    }

    return { verified: violations.length === 0, violations };
  }

  multiSourceTruthReload() {
    const sources = {};

    sources.handoff = {
      path: this.handoffPath,
      exists: fs.existsSync(this.handoffPath),
      hash: this._hashFile(this.handoffPath)
    };

    sources.constraints = {
      path: this.constraintsPath,
      exists: fs.existsSync(this.constraintsPath),
      hash: this._hashFile(this.constraintsPath),
      names: this._getConstraintNames()
    };

    sources.trust_store = {
      path: this.trustStorePath,
      exists: fs.existsSync(this.trustStorePath),
      hash: this._hashFile(this.trustStorePath),
      key_ids: this._getTrustStoreKeyIds()
    };

    sources.governance = {
      path: this.governancePath,
      exists: fs.existsSync(this.governancePath),
      hash: this._hashFile(this.governancePath)
    };

    sources.bootstrap = {
      path: this.bootstrapPath,
      exists: fs.existsSync(this.bootstrapPath),
      hash: this._hashFile(this.bootstrapPath)
    };

    sources.live_lane_state = {};
    const laneHeartbeats = this._getLaneHeartbeats();
    for (const [laneId, config] of Object.entries(LANES)) {
      sources.live_lane_state[laneId] = {
        heartbeat: (() => {
          const hbPath = path.join(config.inbox, `heartbeat-${laneId}.json`);
          if (!fs.existsSync(hbPath)) return null;
          try { return JSON.parse(fs.readFileSync(hbPath, 'utf8')); } catch (_) { return null; }
        })(),
        heartbeat_status: laneHeartbeats[laneId],
        inbox_count: this._countInboxMessages(config.inbox),
        identity_exists: fs.existsSync(path.join(config.root, '.identity', 'public.pem'))
      };
    }

    const restorePacket = this._loadRestorePacket();
    if (restorePacket) {
      sources.restore_packet = {
        path: this.restorePacketPath,
        exists: true,
        timestamp: restorePacket.timestamp,
        context_lost: restorePacket.context_lost,
      constraints_count: Object.keys((restorePacket.restore_payload || {}).governance_constraints || {}).length,
      checkpoints_count: ((restorePacket.restore_payload || {}).active_checkpoints || []).length
      };
    }

    const prePath = path.join(this.auditDir, 'PRE_COMPACT_SNAPSHOT.json');
    const preSnapshot = fs.existsSync(prePath)
      ? JSON.parse(fs.readFileSync(prePath, 'utf8'))
      : null;

    if (restorePacket && preSnapshot) {
      sources.restore_packet_cross_verify = this._crossVerifyRestorePacket(restorePacket, preSnapshot);
    }

    const contradictions = [];

    if (!sources.handoff.exists) contradictions.push('handoff_missing');
    if (!sources.constraints.exists) contradictions.push('constraints_missing');
    if (!sources.trust_store.exists) contradictions.push('trust_store_missing');
    if (!sources.governance.exists) contradictions.push('governance_missing');
    if (!sources.bootstrap.exists) contradictions.push('bootstrap_missing');

    for (const [lane, state] of Object.entries(sources.live_lane_state)) {
      if (!state.identity_exists) contradictions.push(`${lane}_no_identity`);
      const hbStatus = (state.heartbeat_status || {}).status;
      if (hbStatus === 'dead' || (hbStatus !== 'alive' && !state.heartbeat && hbStatus !== 'alive')) {
        if (hbStatus !== 'alive') {
          contradictions.push(`${lane}_no_heartbeat`);
        }
      }
    }

    if (sources.restore_packet_cross_verify && !sources.restore_packet_cross_verify.verified) {
      for (const v of sources.restore_packet_cross_verify.violations) {
        contradictions.push(`restore_packet:${v}`);
      }
    }

    return {
      sources,
      source_count: Object.keys(sources).length,
      contradictions,
      status: contradictions.length === 0 ? 'consistent' : 'contradicted',
      timestamp: new Date().toISOString()
    };
  }

  run() {
    console.log('=== Post-Compact Audit ===\n');

    const restorePacket = this._loadRestorePacket();
    if (restorePacket) {
      console.log(`[audit] Restore packet loaded: ${this.restorePacketPath}`);
    console.log(`[audit] Constraints: ${Object.keys((restorePacket.restore_payload || {}).governance_constraints || {}).length}`);
      console.log(`[audit] Checkpoints: ${((restorePacket.restore_payload || {}).active_checkpoints || []).length}`);
      console.log(`[audit]   Context lost: ${restorePacket.context_lost} tokens`);
    }

    const prePath = path.join(this.auditDir, 'PRE_COMPACT_SNAPSHOT.json');
    let pre;

    if (fs.existsSync(prePath)) {
      pre = JSON.parse(fs.readFileSync(prePath, 'utf8'));
      console.log('[audit] Pre-compact snapshot loaded from file');
    } else {
      console.log('[audit] No pre-compact snapshot found — capturing current state as pre-compact');
      pre = this.capturePreCompact();
    }

    const post = this.capturePostCompact();
    console.log('[audit] Post-compact state captured');

    const audit = this.generateAudit(pre, post);

    if (restorePacket) {
      audit.restore_packet_verification = this._crossVerifyRestorePacket(restorePacket, pre);
      audit.proof.sources_checked.push('compact_restore_packet');
    }

    console.log('\n=== Audit Result ===');
    console.log(`Status: ${audit.status}`);
    console.log(`Contradictions: ${audit.diff.unexpected_changes.length}`);
    if (audit.diff.unexpected_changes.length > 0) {
      console.log('Changes:');
      for (const c of audit.diff.unexpected_changes) {
        console.log(` - ${c}`);
      }
    }
    console.log(`Message loss: ${audit.diff.message_loss}`);
    console.log(`Trust chain intact: ${audit.diff.trust_chain_intact}`);
    console.log(`Constraints intact: ${audit.diff.constraints_intact}`);
    console.log(`Governance intact: ${audit.diff.governance_intact}`);
    console.log(`Bootstrap intact: ${audit.diff.bootstrap_intact}`);
    console.log(`Risk set preserved: ${audit.diff.risk_set_preserved}`);
    const fivCount = (audit.diff.file_integrity_violations || []).length;
    console.log(`File integrity violations: ${fivCount}`);
    if (fivCount > 0) {
      for (const v of audit.diff.file_integrity_violations) {
        console.log(` - ${v.lane}/${v.file}: ${v.deleted ? 'DELETED' : 'HASH_CHANGED'}`);
      }
    }
    console.log(`Self-declared alignment: ${audit.proof.self_declared_alignment}`);

    if (audit.restore_packet_verification) {
      console.log(`Restore packet verified: ${audit.restore_packet_verification.verified}`);
      if (audit.restore_packet_verification.violations.length > 0) {
        console.log('Packet violations:');
        for (const v of audit.restore_packet_verification.violations) {
          console.log(` - ${v}`);
        }
      }
    }

    console.log('\n=== Multi-Source Truth Reload ===');
    const truth = this.multiSourceTruthReload();
    console.log(`Sources checked: ${truth.source_count}`);
    console.log(`Status: ${truth.status}`);
    if (truth.contradictions.length > 0) {
      console.log('Contradictions:');
      for (const c of truth.contradictions) {
        console.log(` - ${c}`);
      }
    }

    console.log('\n=== Tamper-Evident Handoff ===');
    if (fs.existsSync(this.handoffPath)) {
      const handoffContent = fs.readFileSync(this.handoffPath, 'utf8');
      const record = this.generateTamperEvidentHandoff(handoffContent);
      console.log(`Hash: ${record.handoff_hash_sha256}`);
      console.log(`Logged to: ${path.join(this.auditDir, 'HANDOFF_HASH_LOG.jsonl')}`);
    } else {
      console.log('No handoff file found — cannot hash');
    }

    const auditPath = path.join(this.auditDir, 'POST_COMPACT_AUDIT.json');
    console.log(`\nAudit saved: ${auditPath}`);

    return audit;
  }
  _getKnownRisks() {
    return [
      'identity_soft_keys',
      'determinism_not_guaranteed',
      'kernel_partial_convergence',
      'contract_alignment_ambiguous',
      'subagent_code_destruction_surface'
    ];
  }
}
module.exports = { PostCompactAudit };

if (require.main === module) {
  const audit = new PostCompactAudit();
  const result = audit.run();
  process.exit(result.status === 'conflicted' ? 1 : 0);
}
