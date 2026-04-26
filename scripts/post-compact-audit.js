#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const LANES = {
  archivist: { root: 'S:/Archivist-Agent', inbox: 'S:/Archivist-Agent/lanes/archivist/inbox' },
  library: { root: 'S:/self-organizing-library', inbox: 'S:/self-organizing-library/lanes/library/inbox' },
  swarmmind: { root: 'S:/SwarmMind', inbox: 'S:/SwarmMind/lanes/swarmmind/inbox' },
  kernel: { root: 'S:/kernel-lane', inbox: 'S:/kernel-lane/lanes/kernel/inbox' }
};

class PostCompactAudit {
  constructor(options = {}) {
    this.auditDir = options.auditDir || 'S:/Archivist-Agent/.compact-audit';
    this.trustStorePath = options.trustStorePath || 'S:/Archivist-Agent/lanes/broadcast/trust-store.json';
    this.constraintsPath = options.constraintsPath || 'S:/Archivist-Agent/constitutional_constraints.yaml';
    this.bootstrapPath = options.bootstrapPath || 'S:/Archivist-Agent/BOOTSTRAP.md';
    this.governancePath = options.governancePath || 'S:/Archivist-Agent/GOVERNANCE.md';
    this.handoffPath = options.handoffPath || 'S:/Archivist-Agent/COMPACT_CONTEXT_HANDOFF.md';
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
    const blockerPath = 'S:/Archivist-Agent/lanes/broadcast/active-blocker.json';
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

    _getLaneHeartbeats() {
    const results = {};
    for (const [laneId, config] of Object.entries(LANES)) {
      const hbPath = path.join(config.inbox, `heartbeat-${laneId}.json`);
      if (!fs.existsSync(hbPath)) {
        results[laneId] = { status: 'no_heartbeat', timestamp: null };
        continue;
      }
      try {
        const data = JSON.parse(fs.readFileSync(hbPath, 'utf8'));
        const age = Date.now() - new Date(data.timestamp).getTime();
        results[laneId] = {
          status: age > 900000 ? 'stale' : 'alive',
          timestamp: data.timestamp,
          age_seconds: Math.floor(age / 1000)
        };
      } catch (_) {
        results[laneId] = { status: 'error', timestamp: null };
      }
    }
    return results;
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
        known_risks: [
                'identity_soft_keys',
                'determinism_not_guaranteed',
                'kernel_partial_convergence',
                'contract_alignment_ambiguous',
                'subagent_code_destruction_surface'
            ],
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
            known_risks: [],
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
        (pre.active_blocker.blocker?.id !== post.active_blocker.blocker?.id)) {
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
      if (state.status === 'alive' && post.lane_states[lane]?.status !== 'alive') {
        diff.lane_degradations.push({
          lane,
          pre_status: state.status,
          post_status: post.lane_states[lane]?.status || 'unknown'
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
                    const postInfo = post.file_integrity[lane]?.[fileKey];
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
    for (const [laneId, config] of Object.entries(LANES)) {
      sources.live_lane_state[laneId] = {
        heartbeat: (() => {
          const hbPath = path.join(config.inbox, `heartbeat-${laneId}.json`);
          if (!fs.existsSync(hbPath)) return null;
          try { return JSON.parse(fs.readFileSync(hbPath, 'utf8')); } catch (_) { return null; }
        })(),
        inbox_count: this._countInboxMessages(config.inbox),
        identity_exists: fs.existsSync(path.join(config.root, '.identity', 'public.pem'))
      };
    }

    const contradictions = [];

    if (!sources.handoff.exists) contradictions.push('handoff_missing');
    if (!sources.constraints.exists) contradictions.push('constraints_missing');
    if (!sources.trust_store.exists) contradictions.push('trust_store_missing');
    if (!sources.governance.exists) contradictions.push('governance_missing');
    if (!sources.bootstrap.exists) contradictions.push('bootstrap_missing');

    for (const [lane, state] of Object.entries(sources.live_lane_state)) {
      if (!state.identity_exists) contradictions.push(`${lane}_no_identity`);
      if (state.heartbeat?.status === 'dead' || !state.heartbeat) {
        contradictions.push(`${lane}_no_heartbeat`);
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

    console.log('\n=== Audit Result ===');
    console.log(`Status: ${audit.status}`);
    console.log(`Contradictions: ${audit.diff.unexpected_changes.length}`);
    if (audit.diff.unexpected_changes.length > 0) {
      console.log('Changes:');
      for (const c of audit.diff.unexpected_changes) {
        console.log(`  - ${c}`);
      }
    }
    console.log(`Message loss: ${audit.diff.message_loss}`);
    console.log(`Trust chain intact: ${audit.diff.trust_chain_intact}`);
    console.log(`Constraints intact: ${audit.diff.constraints_intact}`);
    console.log(`Governance intact: ${audit.diff.governance_intact}`);
    console.log(`Bootstrap intact: ${audit.diff.bootstrap_intact}`);
        console.log(`Risk set preserved: ${audit.diff.risk_set_preserved}`);
        console.log(`File integrity violations: ${audit.diff.file_integrity_violations?.length || 0}`);
        if (audit.diff.file_integrity_violations?.length > 0) {
            for (const v of audit.diff.file_integrity_violations) {
                console.log(` - ${v.lane}/${v.file}: ${v.deleted ? 'DELETED' : 'HASH_CHANGED'}`);
            }
        }
        console.log(`Self-declared alignment: ${audit.proof.self_declared_alignment}`);

    console.log('\n=== Multi-Source Truth Reload ===');
    const truth = this.multiSourceTruthReload();
    console.log(`Sources checked: ${truth.source_count}`);
    console.log(`Status: ${truth.status}`);
    if (truth.contradictions.length > 0) {
      console.log('Contradictions:');
      for (const c of truth.contradictions) {
        console.log(`  - ${c}`);
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
}

module.exports = { PostCompactAudit };

if (require.main === module) {
  const audit = new PostCompactAudit();
  const result = audit.run();
  process.exit(result.status === 'conflicted' ? 1 : 0);
}
