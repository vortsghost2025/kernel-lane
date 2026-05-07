#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

class ClaimCommitGuard {
  constructor(options = {}) {
    this.repoRoot = options.repoRoot || path.resolve(__dirname, '..');
    this.strict = options.strict !== undefined ? !!options.strict : false;
    this.logPath = options.logPath || path.join(this.repoRoot, 'logs', 'claim-commit-guard.log');
    this.logStream = null;
  }

  _log(msg) {
    const line = `[claim-commit-guard] ${new Date().toISOString()} ${msg}`;
    if (!this.logStream) {
      try {
        fs.mkdirSync(path.dirname(this.logPath), { recursive: true });
      } catch (_) {}
      this.logStream = fs.createWriteStream(this.logPath, { flags: 'a' });
    }
    this.logStream.write(line + '\n');
  }

  _fileExistsInGit(filePath, repoRoot) {
    const rel = path.isAbsolute(filePath)
      ? path.relative(repoRoot, filePath).replace(/\\/g, '/')
      : filePath.replace(/\\/g, '/');
    if (!rel || rel.startsWith('..')) return { exists: false, reason: 'path_outside_repo' };
    try {
      execSync(`git ls-files --error-unmatch "${rel}"`, {
        cwd: repoRoot,
        encoding: 'utf8',
        timeout: 5000,
        stdio: 'pipe',
        windowsHide: true,
      });
      return { exists: true, path: rel };
    } catch (_) {
      try {
        const result = execSync(`git log --diff-filter=A --all --format=%H -- "${rel}"`, {
          cwd: repoRoot,
          encoding: 'utf8',
          timeout: 5000,
          windowsHide: true,
        }).trim();
        return { exists: result.length > 0, path: rel, in_history: result.length > 0 };
      } catch (_2) {
        return { exists: false, path: rel, reason: 'not_in_git' };
      }
    }
  }

  _fileExistsOnDisk(filePath, repoRoot) {
    const abs = path.isAbsolute(filePath) ? filePath : path.join(repoRoot, filePath);
    return fs.existsSync(abs);
  }

  _extractClaimedPaths(msg) {
    const paths = [];
    const ep = msg.evidence?.evidence_path;
    if (ep && typeof ep === 'string' && ep.trim().length > 0) {
      paths.push({ field: 'evidence.evidence_path', value: ep.trim() });
    }
    const cg = msg.convergence_gate?.evidence;
    if (cg && typeof cg === 'string' && cg.trim().length > 0) {
      paths.push({ field: 'convergence_gate.evidence', value: cg.trim() });
    }
    if (msg.evidence_exchange?.artifact_path && typeof msg.evidence_exchange.artifact_path === 'string') {
      paths.push({ field: 'evidence_exchange.artifact_path', value: msg.evidence_exchange.artifact_path.trim() });
    }
    if (msg.body && typeof msg.body === 'string') {
      const bodyPaths = msg.body.match(/(?:S:|\/home\/we4free\/agent\/repos\/)[^\s"']+/g);
      if (bodyPaths) {
        for (const bp of bodyPaths) {
          paths.push({ field: 'body (absolute ref)', value: bp });
        }
      }
    }
    return paths;
  }

  verifyMessage(msg, repoRoot) {
    const root = repoRoot || this.repoRoot;
    const claimedPaths = this._extractClaimedPaths(msg);
    if (claimedPaths.length === 0) {
      return { pass: true, claims: 0, details: [], verdict: 'no_claims' };
    }

    const details = [];
    let allVerified = true;

    for (const claim of claimedPaths) {
      let resolvedRoot = root;
      let filePath = claim.value;
      if (filePath.startsWith('S:/kernel-lane') || filePath.startsWith('/home/we4free/agent/repos/kernel-lane')) {
        resolvedRoot = path.join(root, '..', 'kernel-lane');
        filePath = filePath.replace(/^(S:\/kernel-lane|\/home\/we4free\/agent\/repos\/kernel-lane)\/?/, '');
      } else if (filePath.startsWith('S:/SwarmMind') || filePath.startsWith('/home/we4free/agent/repos/SwarmMind')) {
        resolvedRoot = path.join(root, '..', 'SwarmMind');
        filePath = filePath.replace(/^(S:\/SwarmMind|\/home\/we4free\/agent\/repos\/SwarmMind)\/?/, '');
      } else if (filePath.startsWith('S:/self-organizing-library') || filePath.startsWith('/home/we4free/agent/repos/self-organizing-library')) {
        resolvedRoot = path.join(root, '..', 'self-organizing-library');
        filePath = filePath.replace(/^(S:\/self-organizing-library|\/home\/we4free\/agent\/repos\/self-organizing-library)\/?/, '');
      } else if (filePath.startsWith('S:/Archivist-Agent') || filePath.startsWith('/home/we4free/agent/repos/Archivist-Agent')) {
        resolvedRoot = root.includes('Archivist-Agent') ? root : path.join(root, '..', 'Archivist-Agent');
        filePath = filePath.replace(/^(S:\/Archivist-Agent|\/home\/we4free\/agent\/repos\/Archivist-Agent)\/?/, '');
      }

      if (!fs.existsSync(resolvedRoot) || !fs.existsSync(path.join(resolvedRoot, '.git'))) {
        details.push({ field: claim.field, path: claim.value, status: 'skip', reason: 'repo_not_found' });
        continue;
      }

      const onDisk = this._fileExistsOnDisk(filePath, resolvedRoot);
      const inGit = this._fileExistsInGit(filePath, resolvedRoot);

      if (onDisk && inGit.exists) {
        details.push({ field: claim.field, path: claim.value, status: 'verified', on_disk: true, in_git: true });
      } else if (onDisk && !inGit.exists) {
        allVerified = false;
        details.push({ field: claim.field, path: claim.value, status: 'uncommitted', on_disk: true, in_git: false });
      } else if (!onDisk && inGit.exists) {
        details.push({ field: claim.field, path: claim.value, status: 'deleted_tracked', on_disk: false, in_git: true });
      } else {
        allVerified = false;
        details.push({ field: claim.field, path: claim.value, status: 'missing', on_disk: false, in_git: false });
      }
    }

    const verdict = allVerified ? 'verified' : 'premature_claim';
    return { pass: allVerified, claims: claimedPaths.length, details, verdict };
  }

  checkOutboxMessage(msg, repoRoot, outboxDir) {
    const result = this.verifyMessage(msg, repoRoot);
    const msgId = msg.id || 'unknown';

    if (result.pass) {
      this._log(`PASS ${msgId}: ${result.claims} claims verified`);
      return { allowed: true, ...result };
    }

    const outboxBase = outboxDir || path.join(repoRoot, 'lanes', msg.from || 'unknown', 'outbox');
    const selfReferential = result.details
      .filter(d => !d.on_disk || !d.in_git)
      .filter(d => {
        const absPath = path.isAbsolute(d.path) ? d.path : path.join(repoRoot, d.path);
        return absPath.startsWith(outboxBase);
      });
    if (selfReferential.length > 0 && selfReferential.length === result.details.filter(d => !d.on_disk || !d.in_git).length) {
      this._log(`PASS ${msgId}: self-referential outbox evidence (allowed)`);
      return { allowed: true, ...result, note: 'self_referential_outbox_evidence' };
    }

    const uncommitted = result.details
      .filter(d => d.status === 'uncommitted' || d.status === 'missing')
      .map(d => `${d.field}=${d.path}`);

    this._log(`BLOCK ${msgId}: premature claim — ${uncommitted.join(', ')}`);
    return { allowed: false, ...result };
  }

  close() {
    if (this.logStream) {
      this.logStream.end();
      this.logStream = null;
    }
  }
}

function parseArgs(argv) {
  const out = { lane: null, apply: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--lane' && argv[i + 1]) { out.lane = String(argv[i + 1]).toLowerCase(); i++; continue; }
    if (a === '--apply') { out.apply = true; continue; }
    if (a === '--strict') { out.apply = true; out.strict = true; continue; }
    if (a === '--json') { out.json = true; continue; }
  }
  return out;
}

function guessLane(repoRoot) {
  const lower = String(repoRoot || '').toLowerCase();
  if (lower.includes('archivist')) return 'archivist';
  if (lower.includes('kernel-lane')) return 'kernel';
  if (lower.includes('self-organizing') || lower.includes('library')) return 'library';
  if (lower.includes('swarmmind')) return 'swarmmind';
  return 'archivist';
}

async function runCli() {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = path.resolve(__dirname, '..');
  const lane = args.lane || guessLane(repoRoot);
  const outboxDir = path.join(repoRoot, 'lanes', lane, 'outbox');

  const guard = new ClaimCommitGuard({ repoRoot, strict: args.strict });

  if (!fs.existsSync(outboxDir)) {
    console.log(`[claim-commit-guard] lane=${lane} no outbox directory found`);
    guard.close();
    return;
  }

  const entries = fs.readdirSync(outboxDir, { withFileTypes: true });
  const jsonFiles = entries.filter(e => e.isFile() && e.name.endsWith('.json'));

  let blocked = 0;
  let passed = 0;
  let errors = 0;

  for (const ent of jsonFiles) {
    const filePath = path.join(outboxDir, ent.name);
    let msg;
    try {
      msg = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (_) {
      errors++;
      continue;
    }

    const result = guard.checkOutboxMessage(msg, repoRoot, outboxDir);

    if (args.json) {
      console.log(JSON.stringify({ file: ent.name, ...result }, null, 2));
    } else {
      const mark = result.allowed ? 'PASS' : 'BLOCK';
      console.log(`[claim-commit-guard] ${mark} ${ent.name}: ${result.claims} claims, verdict=${result.verdict}`);
      for (const d of result.details) {
        if (d.status !== 'verified' && d.status !== 'skip') {
          console.log(`  ${d.status}: ${d.field} -> ${d.path} (disk=${d.on_disk}, git=${d.in_git})`);
        }
      }
    }

    if (result.allowed) {
      passed++;
    } else {
      blocked++;
    }
  }

  console.log(`[claim-commit-guard] lane=${lane} scanned=${jsonFiles.length} passed=${passed} blocked=${blocked} errors=${errors}`);
  guard.close();
}

if (require.main === module) {
  runCli().catch(err => { console.error(`[claim-commit-guard] FATAL: ${err.message}`); process.exit(1); });
}

module.exports = { ClaimCommitGuard };
