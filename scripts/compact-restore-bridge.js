#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const REPO_MAP = {
  archivist: 'Archivist-Agent',
  kernel: 'kernel-lane',
  library: 'self-organizing-library',
  swarmmind: 'SwarmMind'
};

const LANE_NAMES = Object.keys(REPO_MAP);

function detectRoot() {
  let dir = __dirname;
  for (let i = 0; i < 3; i++) {
    if (fs.existsSync(path.join(dir, 'BOOTSTRAP.md')) || fs.existsSync(path.join(dir, 'AGENTS.md'))) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  return path.join(__dirname, '..');
}

const ROOT = detectRoot();

function resolveLaneFromPath(filePath) {
  for (const [lane, repo] of Object.entries(REPO_MAP)) {
    if (filePath.includes(`/${repo}/`) || filePath.includes(`\\${repo}\\`) || filePath.includes(`/agent/repos/${repo}/`)) {
      return lane;
    }
  }
  const base = path.basename(path.dirname(filePath));
  for (const [lane, repo] of Object.entries(REPO_MAP)) {
    if (base === repo) return lane;
  }
  return null;
}

function resolveAuditDir(lane, rootsOverride) {
  const roots = rootsOverride || { archivist: ROOT, kernel: path.join(ROOT, '..', 'kernel-lane'), library: path.join(ROOT, '..', 'self-organizing-library'), swarmmind: path.join(ROOT, '..', 'SwarmMind') };
  const laneRoot = roots[lane];
  if (!laneRoot) return null;
  return path.join(laneRoot, '.compact-audit');
}

class CompactRestoreBridge {
  constructor(options = {}) {
    this.roots = options.roots || {
      archivist: ROOT,
      kernel: path.join(ROOT, '..', 'kernel-lane'),
      library: path.join(ROOT, '..', 'self-organizing-library'),
      swarmmind: path.join(ROOT, '..', 'SwarmMind')
    };
    this.auditDirs = {};
    for (const lane of LANE_NAMES) {
      this.auditDirs[lane] = resolveAuditDir(lane, this.roots);
    }
  }

  _hashContent(content) {
    return crypto.createHash('sha256').update(content).digest('hex');
  }

  _ensureDir(dirPath) {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
  }

  _readJsonSafe(filePath) {
    if (!fs.existsSync(filePath)) return null;
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (_) {
      return null;
    }
  }

  capturePreCompactFromPacket(lane, restorePacketPath) {
    const packet = this._readJsonSafe(restorePacketPath);
    if (!packet || !packet.restore_payload) {
      return { ok: false, error: 'invalid_restore_packet', path: restorePacketPath };
    }

    const auditDir = this.auditDirs[lane];
    if (!auditDir) {
      return { ok: false, error: 'unknown_lane', lane };
    }
    this._ensureDir(auditDir);

    const payload = packet.restore_payload;
    const snapshot = {
      timestamp: packet.timestamp || new Date().toISOString(),
      phase: 'pre_compact',
      source: 'compact_restore_packet',
      source_path: restorePacketPath,
      active_blocker: this._readJsonSafe(path.join(this.roots.archivist, 'lanes', 'broadcast', 'active-blocker.json')) || { exists: false, blocker: null },
      trust_store_key_ids: this._extractTrustStoreKeyIds(),
      constraint_names: Object.keys(payload.governance_constraints || {}),
      governance_hash: this._hashFileSafe(path.join(this.roots.archivist, 'GOVERNANCE.md')),
      bootstrap_hash: this._hashFileSafe(path.join(this.roots.archivist, 'BOOTSTRAP.md')),
      handoff_hash: this._hashFileSafe(path.join(this.roots[lane], 'COMPACT_CONTEXT_HANDOFF.md')),
      lane_states: {},
      inbox_counts: {},
      known_risks: this._getKnownRisks(),
      compact_restore_packet: {
        constraints: payload.governance_constraints,
        checkpoints: payload.active_checkpoints,
        drift_baseline: payload.drift_baseline,
        session_context: payload.session_context,
        working_context: payload.working_context_resume,
        authority: packet.authority
      }
    };

    const prePath = path.join(auditDir, 'PRE_COMPACT_SNAPSHOT.json');
    fs.writeFileSync(prePath, JSON.stringify(snapshot, null, 2));
    return { ok: true, path: prePath, lane, snapshot };
  }

  restoreFromPacket(lane, restorePacketPath) {
    const packet = this._readJsonSafe(restorePacketPath);
    if (!packet || !packet.restore_payload) {
      return { ok: false, error: 'invalid_restore_packet', path: restorePacketPath };
    }

    const auditDir = this.auditDirs[lane];
    if (!auditDir) {
      return { ok: false, error: 'unknown_lane', lane };
    }
    this._ensureDir(auditDir);

    const laneRoot = this.roots[lane];
    const restoreTarget = path.join(auditDir, 'COMPACT_RESTORE_PACKET.json');
    fs.writeFileSync(restoreTarget, JSON.stringify(packet, null, 2));

    const handoffPath = path.join(laneRoot, 'COMPACT_CONTEXT_HANDOFF.md');
    const payload = packet.restore_payload;
    const handoffLines = [
      `# Compact Context Handoff — ${lane}`,
      ``,
      `> Auto-generated from COMPACT_RESTORE_PACKET at ${packet.timestamp}`,
      `> Bridge: compact-restore-bridge.js`,
      ``,
      `## Governance Constraints`,
      ``
    ];
    for (const [name, active] of Object.entries(payload.governance_constraints || {})) {
      handoffLines.push(`- **${name}**: ${active ? 'ACTIVE' : 'INACTIVE'}`);
    }
    handoffLines.push('', '## Active Checkpoints', '');
    for (const cp of (payload.active_checkpoints || [])) {
      handoffLines.push(`- [${cp.id}] ${cp.name}`);
    }
    handoffLines.push('', '## Session Context', '');
  const sc = payload.session_context || {};
    handoffLines.push(`- Lane: ${sc.lane_id || lane}`);
    handoffLines.push(`- Role: ${sc.role || 'unknown'}`);
    handoffLines.push(`- Governance: ${sc.governance_active ? 'ACTIVE' : 'INACTIVE'}`);
    handoffLines.push('', '## Working Context Resume', '');
    for (const item of (payload.working_context_resume || [])) {
      handoffLines.push(`- ${item}`);
    }
    handoffLines.push('', '## Authority', '');
    handoffLines.push(`- Authoritative (MUST accept): ${(packet.authority.fields_authoritative || []).join(', ')}`);
    handoffLines.push(`- Advisory (MAY override): ${(packet.authority.fields_advisory || []).join(', ')}`);
    handoffLines.push('');

    fs.writeFileSync(handoffPath, handoffLines.join('\n'), 'utf8');
    const handoffHash = this._hashContent(handoffLines.join('\n'));

    const logPath = path.join(auditDir, 'HANDOFF_HASH_LOG.jsonl');
    const record = {
      timestamp: new Date().toISOString(),
      handoff_hash_sha256: handoffHash,
      hash_algorithm: 'sha256',
      source: 'compact_restore_bridge',
      lane,
      purpose: 'tamper-evident handoff — compact restore cycle'
    };
    fs.appendFileSync(logPath, JSON.stringify(record) + '\n');

    return {
      ok: true,
      lane,
      restore_target: restoreTarget,
      handoff_path: handoffPath,
      handoff_hash: handoffHash,
      constraints_restored: Object.keys(payload.governance_constraints || {}).length,
      checkpoints_restored: (payload.active_checkpoints || []).length,
      working_context_items: (payload.working_context_resume || []).length
    };
  }

  crossVerifyWithAudit(lane) {
    const auditDir = this.auditDirs[lane];
    if (!auditDir) return { ok: false, error: 'unknown_lane', lane };

    const preSnapshot = this._readJsonSafe(path.join(auditDir, 'PRE_COMPACT_SNAPSHOT.json'));
    const restorePacket = this._readJsonSafe(path.join(auditDir, 'COMPACT_RESTORE_PACKET.json'));

    if (!preSnapshot || !restorePacket) {
      return {
        ok: false,
        error: 'missing_data',
        has_pre_snapshot: !!preSnapshot,
        has_restore_packet: !!restorePacket,
        lane
      };
    }

    const packetConstraints = restorePacket.restore_payload.governance_constraints || {};
    const preConstraints = preSnapshot.compact_restore_packet.constraints || preSnapshot.constraint_names || {};
    const packetCheckpoints = restorePacket.restore_payload.active_checkpoints || [];
    const preCheckpoints = preSnapshot.compact_restore_packet.checkpoints || [];

    const constraintMatch = JSON.stringify(Object.keys(packetConstraints).sort()) ===
      JSON.stringify((Array.isArray(preConstraints) ? preConstraints : Object.keys(preConstraints)).sort());

    const checkpointIds = (cps) => cps.map(c => c.id || c).sort();
    const checkpointMatch = JSON.stringify(checkpointIds(packetCheckpoints)) ===
      JSON.stringify(checkpointIds(preCheckpoints));

    const violations = [];
    if (!constraintMatch) violations.push('constraint_mismatch');
    if (!checkpointMatch) violations.push('checkpoint_mismatch');

    if (restorePacket.authority.fields_authoritative) {
      for (const field of restorePacket.authority.fields_authoritative) {
        const crp = preSnapshot.compact_restore_packet || {};
      const preVal = crp[field];
        const rPayload = restorePacket.restore_payload || {};
      const postVal = rPayload[field];
        if (preVal && postVal && JSON.stringify(preVal) !== JSON.stringify(postVal)) {
          violations.push(`authoritative_field_drift:${field}`);
        }
      }
    }

    return {
      ok: violations.length === 0,
      lane,
      constraint_match: constraintMatch,
      checkpoint_match: checkpointMatch,
      violations,
      status: violations.length === 0 ? 'aligned' : 'conflicted'
    };
  }

  initializeLaneAuditDirs() {
    const results = {};
    for (const lane of LANE_NAMES) {
      const auditDir = this.auditDirs[lane];
      if (!auditDir) { results[lane] = { ok: false, error: 'no_root' }; continue; }
      this._ensureDir(auditDir);

      const metaPath = path.join(auditDir, 'meta.json');
      if (!fs.existsSync(metaPath)) {
        const meta = {
          lane,
          created: new Date().toISOString(),
          schema: 'compact-audit-v1',
          initialized_by: 'compact-restore-bridge'
        };
        fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
      }

      const logPath = path.join(auditDir, 'HANDOFF_HASH_LOG.jsonl');
      if (!fs.existsSync(logPath)) {
        fs.writeFileSync(logPath, '');
      }

      results[lane] = { ok: true, audit_dir: auditDir, meta_exists: fs.existsSync(metaPath) };
    }
    return results;
  }

  _hashFileSafe(filePath) {
    if (!fs.existsSync(filePath)) return null;
    try {
      return this._hashContent(fs.readFileSync(filePath, 'utf8'));
    } catch (_) {
      return null;
    }
  }

  _extractTrustStoreKeyIds() {
    const tsPath = path.join(this.roots.archivist, 'lanes', 'broadcast', 'trust-store.json');
    const ts = this._readJsonSafe(tsPath);
    if (!ts) return {};
    const keys = ts.keys || ts;
    const result = {};
    for (const [lane, entry] of Object.entries(keys)) {
      if (entry && entry.key_id) result[lane] = entry.key_id;
    }
    return result;
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

module.exports = { CompactRestoreBridge, resolveLaneFromPath, REPO_MAP, LANE_NAMES };

if (require.main === module) {
  const args = process.argv.slice(2);
  const command = args[0];
  const bridge = new CompactRestoreBridge();

  if (command === 'init') {
    console.log('=== Initializing .compact-audit/ for all lanes ===');
    const result = bridge.initializeLaneAuditDirs();
    for (const [lane, r] of Object.entries(result)) {
      console.log(`  ${lane}: ${r.ok ? 'OK' : 'FAIL'} ${r.audit_dir || r.error}`);
    }
  } else if (command === 'pre-compact') {
    const lane = args[1] || 'archivist';
    const packetPath = args[2];
    if (!packetPath) {
      console.error('Usage: compact-restore-bridge.js pre-compact <lane> <packet-path>');
      process.exit(1);
    }
    console.log(`=== Capturing pre-compact snapshot for ${lane} from ${packetPath} ===`);
    const result = bridge.capturePreCompactFromPacket(lane, packetPath);
    console.log(result.ok ? `  OK: ${result.path}` : `  FAIL: ${result.error}`);
    process.exit(result.ok ? 0 : 1);
  } else if (command === 'restore') {
    const lane = args[1] || 'archivist';
    const packetPath = args[2];
    if (!packetPath) {
      console.error('Usage: compact-restore-bridge.js restore <lane> <packet-path>');
      process.exit(1);
    }
    console.log(`=== Restoring ${lane} from compact restore packet ===`);
    const result = bridge.restoreFromPacket(lane, packetPath);
    if (result.ok) {
      console.log(`  Handoff: ${result.handoff_path}`);
      console.log(`  Hash: ${result.handoff_hash}`);
      console.log(`  Constraints: ${result.constraints_restored}`);
      console.log(`  Checkpoints: ${result.checkpoints_restored}`);
      console.log(`  Working context: ${result.working_context_items} items`);
    } else {
      console.log(`  FAIL: ${result.error}`);
    }
    process.exit(result.ok ? 0 : 1);
  } else if (command === 'cross-verify') {
    const lane = args[1] || 'archivist';
    console.log(`=== Cross-verifying ${lane} audit vs restore packet ===`);
    const result = bridge.crossVerifyWithAudit(lane);
    console.log(`  Status: ${result.status || (result.ok ? 'aligned' : 'error')}`);
    if ((result.violations || []).length > 0) {
      console.log(`  Violations: ${result.violations.join(', ')}`);
    }
    process.exit(result.ok ? 0 : 1);
  } else {
    console.log('Usage: compact-restore-bridge.js <init|pre-compact|restore|cross-verify> [lane] [packet-path]');
    console.log('');
    console.log('  init          Initialize .compact-audit/ dirs for all lanes');
    console.log('  pre-compact   Capture pre-compact snapshot from restore packet');
    console.log('  restore       Rebuild handoff + hash log from restore packet');
    console.log('  cross-verify  Compare restore packet against pre-compact snapshot');
    process.exit(0);
  }
}

