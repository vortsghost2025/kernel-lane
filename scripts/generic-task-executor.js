#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { getCodeVersionHash } = require('./code-version-hash');

const EXECUTOR_VERSION = '3.1.0';
const FEATURE_FLAGS = {
  v3_enabled: true,
  nlp_routing: true,
  timing_instrumentation: true,
  safety_rails: true,
  diff_size_limit: true,
};

const LANE_REGISTRY = {
  archivist: { root: 'S:/Archivist-Agent', inbox_target: 'S:/Archivist-Agent/lanes/archivist/inbox' },
  kernel: { root: 'S:/kernel-lane', inbox_target: 'S:/Archivist-Agent/lanes/archivist/inbox' },
  library: { root: 'S:/self-organizing-library', inbox_target: 'S:/Archivist-Agent/lanes/archivist/inbox' },
  swarmmind: { root: 'S:/SwarmMind', inbox_target: 'S:/Archivist-Agent/lanes/archivist/inbox' },
};

const TRUTH_CRITICAL_PATH_MARKERS = [
  '/scripts/lane-worker.js',
  '/scripts/verification-domain-gate.js',
  '/scripts/validate-responses.js',
  '/scripts/completion-proof.js',
];

function nowIso() { return new Date().toISOString(); }
function ensureDir(d) { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); }
function isPathAllowed(normalized) {
  const allowedRoots = Object.values(LANE_REGISTRY).map(r => r.root.replace(/\\/g, '/'));
  allowedRoots.push(os.tmpdir().replace(/\\/g, '/'));
  return allowedRoots.some(ar => normalized.startsWith(ar));
}

function safeReadJson(p) {
  try { return { ok: true, value: JSON.parse(fs.readFileSync(p, 'utf8')) }; }
  catch (e) { return { ok: false, error: e.message }; }
}

function countJson(dir) {
  if (!fs.existsSync(dir)) return 0;
  return fs.readdirSync(dir).filter(f => f.endsWith('.json') && !f.toLowerCase().startsWith('heartbeat')).length;
}

function resolveTargetInbox(msg, senderLane) {
  if (msg.from === 'archivist') return LANE_REGISTRY.archivist.inbox_target;
  if (LANE_REGISTRY[msg.from]) return LANE_REGISTRY[msg.from].inbox_target;
  return LANE_REGISTRY.archivist.inbox_target;
}

function executeStatusTask(msg, lane) {
  const root = LANE_REGISTRY[lane].root;
  const processed = countJson(path.join(root, 'lanes', lane, 'inbox', 'processed'));
  const quarantine = countJson(path.join(root, 'lanes', lane, 'inbox', 'quarantine'));
  const blocked = countJson(path.join(root, 'lanes', lane, 'inbox', 'blocked'));
  const ar = countJson(path.join(root, 'lanes', lane, 'inbox', 'action-required'));
  let trustStoreKeyId = null;
  try {
    const ts = JSON.parse(fs.readFileSync(path.join(root, 'lanes/broadcast/trust-store.json'), 'utf8'));
    if (ts[lane]) trustStoreKeyId = ts[lane].key_id;
  } catch (_) {}
  let systemState = null;
  try {
    const ss = JSON.parse(fs.readFileSync(path.join(root, 'lanes/broadcast/system_state.json'), 'utf8'));
    systemState = { status: ss.system_status, contradictions: ss.active_contradictions?.length ?? 0, processed_ok: ss.processed_ok };
  } catch (_) {}
  return {
    task_kind: 'status',
    results: { processed_count: processed, quarantine_count: quarantine, blocked_count: blocked, action_required_count: ar, trust_store_key_id: trustStoreKeyId, system_state: systemState },
    summary: `${lane}: processed=${processed} quarantine=${quarantine} blocked=${blocked} ar=${ar} key_id=${trustStoreKeyId} state=${systemState?.status || 'unknown'} ok=${systemState?.processed_ok}`,
  };
}

function executeFileReadTask(msg, lane) {
  const root = LANE_REGISTRY[lane].root;
  const body = (msg.body || '');
  const targetPath = body.match(/read\s+file\s+["']?([^"'\s]+)["']?/i)?.[1]
    || body.match(/read\s+["']?([^"'\s]+)["']?/i)?.[1]
    || body.match(/file[:=]\s*["']?([^"'\s]+)["']?/i)?.[1];
  if (!targetPath) {
    return { task_kind: 'report', results: { error: 'No file path specified. Use: "read file <path>" or "file: <path>"' }, summary: 'Error: no file path in task body' };
  }
  const resolved = targetPath.startsWith('/') || targetPath.match(/^[A-Za-z]:/) ? targetPath : path.join(root, targetPath);
  const normalized = resolved.replace(/\\/g, '/');
  if (!isPathAllowed(normalized)) {
    return { task_kind: 'report', results: { error: `Path outside allowed roots: ${resolved}` }, summary: `Error: path outside allowed roots` };
  }
  try {
    const stat = fs.statSync(resolved);
    if (stat.isDirectory()) {
      const entries = fs.readdirSync(resolved).slice(0, 100);
      return { task_kind: 'report', results: { type: 'directory', path: resolved, entries, count: entries.length }, summary: `Directory ${resolved}: ${entries.length} entries` };
    }
    if (stat.size > 50000) {
      const content = fs.readFileSync(resolved, 'utf8').slice(0, 50000);
      return { task_kind: 'report', results: { type: 'file', path: resolved, size: stat.size, content: content + '\n... TRUNCATED (50KB limit)' }, summary: `File ${resolved}: ${stat.size} bytes (truncated to 50KB)` };
    }
    const content = fs.readFileSync(resolved, 'utf8');
    return { task_kind: 'report', results: { type: 'file', path: resolved, size: stat.size, content }, summary: `File ${resolved}: ${stat.size} bytes` };
  } catch (e) {
    return { task_kind: 'report', results: { error: `Cannot read ${resolved}: ${e.message}` }, summary: `Error reading ${resolved}` };
  }
}

function executeScriptTask(msg, lane) {
  const root = LANE_REGISTRY[lane].root;
  const body = (msg.body || '');
  const scriptMatch = body.match(/run\s+script\s+["']?([^"'\s]+)["']?/i) || body.match(/script[:=]\s*["']?([^"'\s]+)["']?/i);
  if (!scriptMatch) {
    return { task_kind: 'report', results: { error: 'No script specified. Use: "run script <name>"' }, summary: 'Error: no script in task body' };
  }
  const scriptName = scriptMatch[1];
  const scriptPath = path.join(root, 'scripts', scriptName.endsWith('.js') ? scriptName : scriptName + '.js');
  if (!fs.existsSync(scriptPath)) {
    return { task_kind: 'report', results: { error: `Script not found: ${scriptPath}` }, summary: `Error: script ${scriptName} not found` };
  }
  const LONG_RUNNING = ['heartbeat', 'inbox-watcher', 'relay-daemon'];
  const baseName = scriptName.replace(/\.js$/, '').toLowerCase();
  if (LONG_RUNNING.some(lr => baseName.includes(lr))) {
    return { task_kind: 'report', results: { script: scriptName, skipped: true, reason: 'Long-running daemon script — use "status" or "consistency check" instead' }, summary: `Script ${scriptName}: SKIPPED (long-running daemon)` };
  }
  const maxOutput = 50000;
  try {
    const { execSync } = require('child_process');
    const output = execSync(`node "${scriptPath}"`, { cwd: root, timeout: 30000, encoding: 'utf8', maxBuffer: maxOutput });
    return { task_kind: 'report', results: { script: scriptName, exit_code: 0, output: output.slice(0, maxOutput) }, summary: `Script ${scriptName}: success (${output.length} chars output)` };
  } catch (e) {
    const stdout = (e.stdout || '').slice(0, 25000);
    const stderr = (e.stderr || '').slice(0, 5000) || e.message.slice(0, 5000);
    const timedOut = e.killed || e.signal === 'SIGTERM' || stderr.includes('ETIMEDOUT') || stderr.includes('timed out');
    if (timedOut) {
      return { task_kind: 'report', results: { script: scriptName, exit_code: -1, timed_out: true, output: stdout, error: 'Script exceeded 30s timeout' }, summary: `Script ${scriptName}: TIMEOUT (30s)` };
    }
    const isTest = scriptName.toLowerCase().includes('test') || scriptName.toLowerCase().includes('recovery');
    const passCount = (stdout.match(/\[PASS\]/g) || []).length;
    const failCount = (stdout.match(/\[FAIL\]/g) || []).length;
    if (isTest && passCount > 0 && failCount <= 1) {
      return { task_kind: 'report', results: { script: scriptName, exit_code: e.status || 1, passed: passCount, failed: failCount, output: stdout, note: `Test suite: ${passCount} PASS, ${failCount} FAIL (non-zero exit but mostly passing)` }, summary: `Script ${scriptName}: ${passCount}P/${failCount}F` };
    }
    return { task_kind: 'report', results: { script: scriptName, exit_code: e.status || 1, output: stdout, error: stderr }, summary: `Script ${scriptName}: exit ${e.status || 1}` };
  }
}

function executeGitTask(msg, lane) {
  const root = LANE_REGISTRY[lane].root;
  const body = (msg.body || '');
  const gitCmd = body.match(/git\s+(status|log|diff|branch|remote)\s*(.*)/i);
  if (!gitCmd) {
    return { task_kind: 'report', results: { error: 'No git command specified. Use: "git status", "git log", "git diff", "git branch", "git remote"' }, summary: 'Error: no git command in task body' };
  }
  const allowed = ['status', 'log', 'diff', 'branch', 'remote'];
  const subcmd = gitCmd[1].toLowerCase();
  if (!allowed.includes(subcmd)) {
    return { task_kind: 'report', results: { error: `Git subcommand "${subcmd}" not allowed. Allowed: ${allowed.join(', ')}` }, summary: `Error: git ${subcmd} not allowed` };
  }
  const extraArgs = (gitCmd[2] || '').trim();
  if (extraArgs.match(/[;&|`$]/)) {
    return { task_kind: 'report', results: { error: 'Shell metacharacters not allowed in git arguments' }, summary: 'Error: invalid characters in git args' };
  }
  const logLimit = subcmd === 'log' ? ' -10' : '';
  try {
    const { execSync } = require('child_process');
    const output = execSync(`git ${subcmd}${logLimit} ${extraArgs}`, { cwd: root, timeout: 15000, encoding: 'utf8', maxBuffer: 30000 });
    return { task_kind: 'report', results: { git: subcmd, output: output.slice(0, 30000) }, summary: `git ${subcmd}: ${output.split('\n').length} lines` };
  } catch (e) {
    return { task_kind: 'report', results: { git: subcmd, exit_code: e.status || 1, output: (e.stdout || '').slice(0, 15000), error: (e.stderr || '').slice(0, 5000) }, summary: `git ${subcmd}: exit ${e.status || 1}` };
  }
}

function executeGrepTask(msg, lane) {
  const root = LANE_REGISTRY[lane].root;
  const body = (msg.body || '');
  const grepMatch = body.match(/(?:grep\s+|search\s+(?:for\s+)?)["']([^"']+)["']\s+(?:in|path|file|dir)\s+["']?([^"'\s]+)["']?/i)
    || body.match(/(?:grep\s+|search\s+(?:for\s+)?)["']([^"']+)["']/i)
    || body.match(/find\s+["']([^"']+)["']\s+(?:in|path|file|dir)\s+["']?([^"'\s]+)["']?/i)
    || body.match(/find\s+["']([^"']+)["']/i);
  if (!grepMatch) {
    return { task_kind: 'report', results: { error: 'No search pattern specified. Use: "grep \\"pattern\\" in <path>" or "search \\"pattern\\""' }, summary: 'Error: no search pattern in task body' };
  }
  const pattern = grepMatch[1];
  const searchPath = grepMatch[2] ? grepMatch[2] : '.';
  const resolved = searchPath.startsWith('/') || searchPath.match(/^[A-Za-z]:/) ? searchPath : path.join(root, searchPath);
  const normalized = resolved.replace(/\\/g, '/');
  if (!isPathAllowed(normalized)) {
    return { task_kind: 'report', results: { error: `Search path outside allowed roots: ${resolved}` }, summary: 'Error: search path outside allowed roots' };
  }
  try {
    const { execSync } = require('child_process');
    let output = '';
    const isWindows = process.platform === 'win32' || process.env.COMSPEC;
    try {
      if (isWindows) {
        output = execSync(`findstr /s /n /i "${pattern.replace(/"/g, '')}" "${resolved}\\*.md" "${resolved}\\*.json" "${resolved}\\*.js" "${resolved}\\*.yaml" "${resolved}\\*.yml" "${resolved}\\*.txt"`, { cwd: root, timeout: 15000, encoding: 'utf8', maxBuffer: 30000 });
      } else {
        output = execSync(`rg --max-count 20 --max-filesize 1M -n "${pattern.replace(/"/g, '\\"')}" "${resolved}"`, { cwd: root, timeout: 15000, encoding: 'utf8', maxBuffer: 30000 });
      }
    } catch (e) {
      if ((e.status === 1 && (e.stdout === '' || !e.stdout)) || (isWindows && (e.stdout || '').trim() === '')) {
        return { task_kind: 'report', results: { grep: pattern, matches: 0, output: '' }, summary: `grep "${pattern}": no matches` };
      }
      output = (e.stdout || '');
    }
    const lines = output.split('\n').filter(l => l.trim());
    return { task_kind: 'report', results: { grep: pattern, matches: lines.length, output: output.slice(0, 30000) }, summary: `grep "${pattern}": ${lines.length} matches` };
  } catch (e) {
    return { task_kind: 'report', results: { error: `Search failed: ${e.message.slice(0, 3000)}` }, summary: 'Error running search' };
  }
}

function executeWriteTask(msg, lane) {
  const root = LANE_REGISTRY[lane].root;
  const body = (msg.body || '');
  const writeMatch = body.match(/write\s+file\s+["']?([^"'\s]+)["']?\s*\n([\s\S]*)/i)
    || body.match(/write\s+["']?([^"'\s]+)["']?\s*[:=]\s*\n?([\s\S]*)/i);
  if (!writeMatch) {
    return { task_kind: 'report', results: { error: 'No write target specified. Use: "write file <path>\\n<content>"' }, summary: 'Error: no write target in task body' };
  }
  const targetPath = writeMatch[1];
  const content = writeMatch[2] || '';
  if (content.length > 10240) {
    return { task_kind: 'report', results: { error: `Content exceeds 10KB limit (${content.length} bytes). Write operations are bounded.` }, summary: 'Error: content too large for write' };
  }
  const resolved = targetPath.startsWith('/') || targetPath.match(/^[A-Za-z]:/) ? targetPath : path.join(root, targetPath);
  const normalized = resolved.replace(/\\/g, '/');
  if (!normalized.startsWith(root.replace(/\\/g, '/'))) {
    return { task_kind: 'report', results: { error: `Write target outside own lane root: ${resolved}. Writes only allowed within own lane.` }, summary: 'Error: write path outside own lane' };
  }
  const forbidden = ['trust-store.json', 'active-blocker.json', 'system_state.json', 'contradictions.json',
    '.identity/', '.trust/', 'BOOTSTRAP.md', 'GOVERNANCE.md', 'COVENANT.md', 'AGENTS.md'];
  if (forbidden.some(f => normalized.includes(f))) {
    return { task_kind: 'report', results: { error: `Write to governance/critical file blocked: ${targetPath}` }, summary: 'Error: write to protected file' };
  }
  try {
    const lockCheck = acquireTruthCriticalLockIfNeeded(normalized, lane);
    if (!lockCheck.ok) {
      return {
        task_kind: 'report',
        results: { error: lockCheck.error, lock: lockCheck.lock || null },
        summary: 'Error: truth-critical write lock not acquired',
      };
    }
    const dir = path.dirname(resolved);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(resolved, content, 'utf8');
    return { task_kind: 'report', results: { written: resolved, bytes: content.length }, summary: `Wrote ${content.length} bytes to ${resolved}` };
  } catch (e) {
    return { task_kind: 'report', results: { error: `Write failed: ${e.message}` }, summary: `Error writing to ${resolved}` };
  }
}

function isTruthCriticalPath(normalizedPath) {
  return TRUTH_CRITICAL_PATH_MARKERS.some((m) => normalizedPath.endsWith(m));
}

function acquireTruthCriticalLockIfNeeded(normalizedPath, lane) {
  if (!isTruthCriticalPath(normalizedPath)) return { ok: true };
  const repoRoot = LANE_REGISTRY[lane].root;
  const lockDir = path.join(repoRoot, '.locks');
  ensureDir(lockDir);
  const lockPath = path.join(lockDir, 'truth-critical.lock.json');
  const now = Date.now();
  const owner = process.env.AGENT_INSTANCE_ID || `${lane}-executor`;
  const ttlMs = 10 * 60 * 1000;
  if (fs.existsSync(lockPath)) {
    try {
      const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      if (lock.expires_at_ms && lock.expires_at_ms > now && lock.owner !== owner) {
        return { ok: false, error: `Truth-critical lock held by ${lock.owner} until ${new Date(lock.expires_at_ms).toISOString()}`, lock };
      }
    } catch (_) {}
  }
  const lockObj = {
    owner,
    acquired_at_ms: now,
    expires_at_ms: now + ttlMs,
    ttl_ms: ttlMs,
    scope: 'truth-critical-execution-surface',
  };
  fs.writeFileSync(lockPath, JSON.stringify(lockObj, null, 2), 'utf8');
  return { ok: true, lock: lockObj };
}

function executeListDirTask(msg, lane) {
  const root = LANE_REGISTRY[lane].root;
  const body = (msg.body || '');
  const dirMatch = body.match(/list\s+(?:dir|directory|folder)\s+["']?([^"'\s]+)["']?/i)
    || body.match(/ls\s+["']?([^"'\s]+)["']?/i)
    || body.match(/list\s+["']?([^"'\s]+)["']?/i);
  if (!dirMatch) {
    return { task_kind: 'report', results: { error: 'No directory specified. Use: "list dir <path>" or "ls <path>"' }, summary: 'Error: no directory in task body' };
  }
  const targetPath = dirMatch[1];
  const resolved = targetPath.startsWith('/') || targetPath.match(/^[A-Za-z]:/) ? targetPath : path.join(root, targetPath);
  const normalized = resolved.replace(/\\/g, '/');
  if (!isPathAllowed(normalized)) {
    return { task_kind: 'report', results: { error: `Path outside allowed roots: ${resolved}` }, summary: 'Error: path outside allowed roots' };
  }
  try {
    const stat = fs.statSync(resolved);
    if (!stat.isDirectory()) {
      return { task_kind: 'report', results: { error: `Not a directory: ${resolved}` }, summary: `Error: ${resolved} is not a directory` };
    }
    const entries = fs.readdirSync(resolved).map(name => {
      try {
        const full = path.join(resolved, name);
        const s = fs.statSync(full);
        return { name, type: s.isDirectory() ? 'DIR' : 'FILE', size: s.size, modified: s.mtime.toISOString() };
      } catch (_) {
        return { name, type: 'UNKNOWN', size: 0, modified: null };
      }
    });
    return { task_kind: 'report', results: { path: resolved, entries, count: entries.length }, summary: `Directory ${resolved}: ${entries.length} entries` };
  } catch (e) {
    return { task_kind: 'report', results: { error: `Cannot list ${resolved}: ${e.message}` }, summary: `Error listing ${resolved}` };
  }
}

function executeHashTask(msg, lane) {
  const root = LANE_REGISTRY[lane].root;
  const body = (msg.body || '');
  const hashMatch = body.match(/hash\s+(?:file\s+)?["']?([^"'\s]+)["']?/i)
    || body.match(/sha(?:256)?\s+["']?([^"'\s]+)["']?/i)
    || body.match(/checksum\s+["']?([^"'\s]+)["']?/i);
  if (!hashMatch) {
    return { task_kind: 'report', results: { error: 'No file specified. Use: "hash file <path>" or "sha256 <path>"' }, summary: 'Error: no file in task body' };
  }
  const targetPath = hashMatch[1];
  const resolved = targetPath.startsWith('/') || targetPath.match(/^[A-Za-z]:/) ? targetPath : path.join(root, targetPath);
  const normalized = resolved.replace(/\\/g, '/');
  if (!isPathAllowed(normalized)) {
    return { task_kind: 'report', results: { error: `Path outside allowed roots: ${resolved}` }, summary: 'Error: path outside allowed roots' };
  }
  try {
    const stat = fs.statSync(resolved);
    if (stat.isDirectory()) {
      return { task_kind: 'report', results: { error: `Cannot hash directory: ${resolved}` }, summary: 'Error: target is a directory' };
    }
    if (stat.size > 50000000) {
      return { task_kind: 'report', results: { error: `File too large for hash: ${stat.size} bytes (50MB limit)` }, summary: 'Error: file too large' };
    }
    const crypto = require('crypto');
    const content = fs.readFileSync(resolved);
    const hash = crypto.createHash('sha256').update(content).digest('hex');
    return { task_kind: 'report', results: { path: resolved, size: stat.size, sha256: hash, modified: stat.mtime.toISOString() }, summary: `SHA256 ${resolved}: ${hash.slice(0, 16)}... (${stat.size} bytes)` };
  } catch (e) {
    return { task_kind: 'report', results: { error: `Hash failed: ${e.message}` }, summary: `Error hashing ${resolved}` };
  }
}

function executeDiffTask(msg, lane) {
  const root = LANE_REGISTRY[lane].root;
  const body = (msg.body || '');
  const diffMatch = body.match(/diff\s+["']?([^"'\s]+)["']?\s+["']?([^"'\s]+)["']?/i)
    || body.match(/compare\s+["']?([^"'\s]+)["']?\s+(?:to|with|and)\s+["']?([^"'\s]+)["']?/i);
  if (!diffMatch) {
    return { task_kind: 'report', results: { error: 'Need two file paths. Use: "diff <file1> <file2>" or "compare <file1> with <file2>"' }, summary: 'Error: need two file paths' };
  }
  const path1 = diffMatch[1];
  const path2 = diffMatch[2];
  const resolve = (p) => {
    if (p.startsWith('/') || p.match(/^[A-Za-z]:/)) return p;
    return path.join(root, p);
  };
  const resolved1 = resolve(path1);
  const resolved2 = resolve(path2);
  const norm1 = resolved1.replace(/\\/g, '/');
  const norm2 = resolved2.replace(/\\/g, '/');
  if (!isPathAllowed(norm1) || !isPathAllowed(norm2)) {
    return { task_kind: 'report', results: { error: 'One or both paths outside allowed roots' }, summary: 'Error: path outside allowed roots' };
  }
try {
  const stat1 = fs.statSync(resolved1);
  const stat2 = fs.statSync(resolved2);
  const DIFF_SIZE_LIMIT = 10 * 1024 * 1024;
  if (stat1.size > DIFF_SIZE_LIMIT || stat2.size > DIFF_SIZE_LIMIT) {
    return { task_kind: 'report', results: { error: `File too large for diff (10MB limit). ${path.basename(resolved1)}: ${stat1.size}, ${path.basename(resolved2)}: ${stat2.size}` }, summary: 'Error: file too large for diff' };
  }
  const content1 = fs.readFileSync(resolved1, 'utf8');
    const content2 = fs.readFileSync(resolved2, 'utf8');
    const lines1 = content1.split('\n');
    const lines2 = content2.split('\n');
    const maxLines = Math.max(lines1.length, lines2.length);
    const diffs = [];
    const maxDiffs = 200;
    for (let i = 0; i < maxLines && diffs.length < maxDiffs; i++) {
      const l1 = i < lines1.length ? lines1[i] : undefined;
      const l2 = i < lines2.length ? lines2[i] : undefined;
      if (l1 !== l2) {
        diffs.push({ line: i + 1, left: l1 !== undefined ? l1.slice(0, 200) : '<EOF>', right: l2 !== undefined ? l2.slice(0, 200) : '<EOF>' });
      }
    }
    const identical = diffs.length === 0 && lines1.length === lines2.length;
    return {
      task_kind: 'report',
      results: { file1: resolved1, file2: resolved2, identical, total_lines_1: lines1.length, total_lines_2: lines2.length, diff_count: diffs.length, diffs: diffs.slice(0, 100), truncated: diffs.length > 100 },
      summary: identical ? `Files identical (${lines1.length} lines)` : `${diffs.length} differences between ${path.basename(resolved1)} and ${path.basename(resolved2)}`
    };
  } catch (e) {
    return { task_kind: 'report', results: { error: `Diff failed: ${e.message}` }, summary: `Error running diff` };
  }
}

function executeCountTask(msg, lane) {
  const root = LANE_REGISTRY[lane].root;
  const body = (msg.body || '');
  const countMatch = body.match(/count\s+["']([^"']+)["']\s+(?:in|path|file|dir)\s+["']?([^"'\s]+)["']?/i)
    || body.match(/count\s+["']([^"']+)["']/i);
  if (!countMatch) {
    return { task_kind: 'report', results: { error: 'No pattern specified. Use: "count \\"pattern\\" in <path>"' }, summary: 'Error: no pattern in task body' };
  }
  const pattern = countMatch[1];
  const searchPath = countMatch[2] || '.';
  const resolved = searchPath.startsWith('/') || searchPath.match(/^[A-Za-z]:/) ? searchPath : path.join(root, searchPath);
  const normalized = resolved.replace(/\\/g, '/');
  if (!isPathAllowed(normalized)) {
    return { task_kind: 'report', results: { error: `Search path outside allowed roots: ${resolved}` }, summary: 'Error: search path outside allowed roots' };
  }
  try {
    const stat = fs.statSync(resolved);
    const re = new RegExp(pattern, 'gi');
    if (stat.isDirectory()) {
      const limits = { maxFiles: 500, maxBytes: 5 * 1024 * 1024 };
      let filesScanned = 0;
      let totalBytes = 0;
      let totalCount = 0;
      const perFile = [];
      const queue = [resolved];
      while (queue.length > 0 && filesScanned < limits.maxFiles && totalBytes < limits.maxBytes) {
        const current = queue.shift();
        let entries = [];
        try {
          entries = fs.readdirSync(current);
        } catch (_) {
          continue;
        }
        for (const name of entries) {
          const full = path.join(current, name);
          let s;
          try {
            s = fs.statSync(full);
          } catch (_) {
            continue;
          }
          if (s.isDirectory()) {
            queue.push(full);
            continue;
          }
          if (!s.isFile()) continue;
          if (filesScanned >= limits.maxFiles || totalBytes >= limits.maxBytes) break;
          if (s.size > 1024 * 1024) continue; // Skip very large files in directory mode.
          let content = '';
          try {
            content = fs.readFileSync(full, 'utf8');
          } catch (_) {
            continue;
          }
          filesScanned++;
          totalBytes += s.size;
          const matches = content.match(re);
          const count = matches ? matches.length : 0;
          totalCount += count;
          if (count > 0) perFile.push({ file: full, count });
        }
      }
      const truncated = filesScanned >= limits.maxFiles || totalBytes >= limits.maxBytes;
      return {
        task_kind: 'report',
        results: { path: resolved, pattern, count: totalCount, files_scanned: filesScanned, bytes_scanned: totalBytes, truncated, matches_by_file: perFile.slice(0, 100) },
        summary: `"${pattern}" in ${resolved}: ${totalCount} occurrences (${filesScanned} files${truncated ? ', truncated' : ''})`
      };
    }
    const content = fs.readFileSync(resolved, 'utf8');
    const matches = content.match(re);
    const count = matches ? matches.length : 0;
    return { task_kind: 'report', results: { file: resolved, pattern, count }, summary: `"${pattern}" in ${path.basename(resolved)}: ${count} occurrences` };
  } catch (e) {
    return { task_kind: 'report', results: { error: `Count failed: ${e.message}` }, summary: 'Error running count' };
  }
}

const NLP_ROUTES = [
  { patterns: [/trust.?store/, /trust.?integrit/, /key.?valid/, /identit.?health/], verb: 'consistency check' },
  { patterns: [/check.*consist/, /system.?health/, /is.*consist/, /are.*lanes.*sync/, /cross.?lane.*check/], verb: 'consistency check' },
  { patterns: [/how many.*process/, /inbox.*count/, /message.*count/, /what.*status/, /lane.*status/], verb: 'status' },
  { patterns: [/what.*in.*dir/, /show.*folder/, /list.*file/, /what.*file.*exist/, /dir.*content/], verb: 'list dir' },
  { patterns: [/is.*file.*same/, /file.*chang/, /has.*modif/, /file.*identical/, /doc.*chang/, /governance.*chang/], verb: 'diff' },
  { patterns: [/verif.*integrit/, /file.*hash/, /checksum/, /sha.*of/], verb: 'hash file' },
  { patterns: [/how many.*(?:occurrence|instance|match)/, /count.*pattern/, /how often/], verb: 'count' },
  { patterns: [/show.*content/, /cat.*file/, /what.*in.*file/, /read.*content/, /display.*file/], verb: 'read file' },
  { patterns: [/find.*text/, /where.*mention/, /where.*defin/, /search.*for/], verb: 'grep' },
  { patterns: [/latest.*commit/, /recent.*change/, /commit.*hist/, /what.*chang/], verb: 'git log' },
  { patterns: [/uncommit/, /\bstag(?:e|ing)?\b/, /\bdirty\b/, /\bmodif(?:ied|ication)\s+file/], verb: 'git status' },
  { patterns: [/run.*test/, /execut.*test/, /run.*bench/], verb: 'run script' },
];

function nlpRoute(msg) {
  const text = ((msg.body || '') + ' ' + (msg.subject || '')).toLowerCase();
  for (const route of NLP_ROUTES) {
    const matched = route.patterns.find(p => p.test(text));
    if (matched) {
      return { verb: route.verb, matched_pattern: matched.toString(), confidence: 0.7 };
    }
  }
  return null;
}

function normalizeNlpCountBody(msgBody) {
  const original = msgBody || '';
  const quotedPattern = original.match(/["']([^"']+)["']/);
  const pathMatch = original.match(/\b(?:in|within|inside|from)\s+([A-Za-z]:[^\s"']+|\/[^\s"']+|[^\s"']+)/i);
  if (quotedPattern && pathMatch) {
    return `count "${quotedPattern[1]}" in ${pathMatch[1]}`;
  }
  if (quotedPattern) {
    return `count "${quotedPattern[1]}"`;
  }
  return `count ${original}`;
}

function executeConsistencyCheck(msg, lane) {
  const root = LANE_REGISTRY[lane].root;
  try {
    const scriptPath = path.join(root, 'scripts', 'cross-lane-consistency-check.js');
    if (!fs.existsSync(scriptPath)) {
      return { task_kind: 'report', results: { error: 'cross-lane-consistency-check.js not found' }, summary: 'Error: consistency check script not found' };
    }
    const { execSync } = require('child_process');
    const output = execSync(`node "${scriptPath}"`, { cwd: root, timeout: 60000, encoding: 'utf8', maxBuffer: 100000 });
    return { task_kind: 'report', results: { check_type: 'cross-lane-consistency', output: output.slice(0, 100000) }, summary: `Consistency check: ${output.includes('Consistent: YES') ? 'PASS' : 'ISSUES FOUND'}` };
  } catch (e) {
    return { task_kind: 'report', results: { error: e.message.slice(0, 5000) }, summary: 'Error running consistency check' };
  }
}

function executeTask(msg, lane) {
  const t0 = Date.now();
  const kind = (msg.task_kind || '').toLowerCase();
  const body = (msg.body || '').toLowerCase();
  const attachRouting = (result, routing) => {
    const out = result || { task_kind: 'ack', results: {}, summary: 'No result' };
    if (!out.results) out.results = {};
    out.results._routing = routing;
    out.results._timing = { ms: Date.now() - t0, verb: routing.verb, source: routing.source };
    return out;
  };

  if (kind === 'status' || body.includes('report status') || body.includes('processed count')) {
    return attachRouting(executeStatusTask(msg, lane), { source: 'explicit', verb: 'status', confidence: 1.0 });
  }
  if (body.match(/list\s+(dir|directory|folder)\s+/i) || body.match(/\bls\s+/i)) {
    return attachRouting(executeListDirTask(msg, lane), { source: 'explicit', verb: 'list dir', confidence: 1.0 });
  }
  if (body.match(/hash\s+(?:file\s+)?/i) || body.match(/\bsha256?\s+/i) || body.match(/\bchecksum\s+/i)) {
    return attachRouting(executeHashTask(msg, lane), { source: 'explicit', verb: 'hash file', confidence: 1.0 });
  }
  if (body.match(/\bdiff\s+/i) || body.match(/\bcompare\s+/i)) {
    return attachRouting(executeDiffTask(msg, lane), { source: 'explicit', verb: 'diff', confidence: 1.0 });
  }
  if (body.match(/\bcount\s+/i)) {
    return attachRouting(executeCountTask(msg, lane), { source: 'explicit', verb: 'count', confidence: 1.0 });
  }
  if (body.includes('read file') || body.includes('read ') || body.includes('file:') || body.includes('file=')) {
    return attachRouting(executeFileReadTask(msg, lane), { source: 'explicit', verb: 'read file', confidence: 1.0 });
  }
  if (body.includes('run script') || body.includes('script:') || body.includes('script=')) {
    return attachRouting(executeScriptTask(msg, lane), { source: 'explicit', verb: 'run script', confidence: 1.0 });
  }
  if (body.match(/git\s+(status|log|diff|branch|remote)/i)) {
    return attachRouting(executeGitTask(msg, lane), { source: 'explicit', verb: 'git', confidence: 1.0 });
  }
  if (body.match(/\bgit\s+\S+/i)) {
    const gitSub = body.match(/git\s+(\S+)/i);
    const allowed = ['status', 'log', 'diff', 'branch', 'remote'];
    if (gitSub && !allowed.includes(gitSub[1].toLowerCase())) {
      return attachRouting({ task_kind: 'report', results: { error: `Git subcommand "${gitSub[1]}" not allowed. Allowed: ${allowed.join(', ')}` }, summary: `Error: git ${gitSub[1]} not allowed` }, { source: 'explicit', verb: 'git', confidence: 1.0 });
    }
  }
  if (body.match(/(grep|search|find)\s+/i)) {
    return attachRouting(executeGrepTask(msg, lane), { source: 'explicit', verb: 'grep', confidence: 1.0 });
  }
  if (body.match(/write\s+(file|to)?/i)) {
    return attachRouting(executeWriteTask(msg, lane), { source: 'explicit', verb: 'write file', confidence: 1.0 });
  }
  if (body.includes('consistency check') || body.includes('audit')) {
    return attachRouting(executeConsistencyCheck(msg, lane), { source: 'explicit', verb: 'consistency check', confidence: 1.0 });
  }

  const nlpDecision = nlpRoute(msg);
  if (nlpDecision) {
    const originalBody = msg.body || '';
    let normalizedBody;
    switch (nlpDecision.verb) {
      case 'status':
      case 'consistency check':
      case 'git log':
        normalizedBody = nlpDecision.verb;
        break;
      case 'git status':
        normalizedBody = 'git status';
        break;
      case 'count':
        normalizedBody = normalizeNlpCountBody(originalBody);
        break;
      case 'list dir': {
        const dirMatch = originalBody.match(/(?:in|from|at)\s+["']?([A-Za-z]:[^\s"']+|\/[^\s"']+)/i);
        normalizedBody = dirMatch ? `list dir ${dirMatch[1]}` : originalBody;
        break;
      }
      case 'hash file': {
        const fileMatch = originalBody.match(/(?:of|for|from)\s+["']?([A-Za-z]:[^\s"']+|\/[^\s"']+)/i);
        normalizedBody = fileMatch ? `hash file ${fileMatch[1]}` : originalBody;
        break;
      }
      case 'diff': {
        const fileMatch = originalBody.match(/(?:of|for|from|between)\s+["']?([A-Za-z]:[^\s"']+|\/[^\s"']+)/i);
        normalizedBody = fileMatch ? `diff ${fileMatch[1]}` : originalBody;
        break;
      }
      case 'read file': {
        const fileMatch = originalBody.match(/(?:read|show|display|cat)\s+["']?([A-Za-z]:[^\s"']+|\/[^\s"']+)/i);
        normalizedBody = fileMatch ? `read file ${fileMatch[1]}` : originalBody;
        break;
      }
      case 'grep': {
        const grepMatch = originalBody.match(/(?:find|search|where)\s+["']?([^"'\s]+)["']?\s+(?:in|from|within)\s+["']?([A-Za-z]:[^\s"']+|\/[^\s"']+)/i);
        normalizedBody = grepMatch ? `grep "${grepMatch[1]}" in ${grepMatch[2]}` : originalBody;
        break;
      }
      default:
        normalizedBody = nlpDecision.verb + ' ' + originalBody;
    }
    const nlpMsg = Object.assign({}, msg, { body: normalizedBody, _nlp_routed: true });
    const routing = { source: 'nlp', verb: nlpDecision.verb, confidence: nlpDecision.confidence, matched_pattern: nlpDecision.matched_pattern };
    switch (nlpDecision.verb) {
      case 'status': return attachRouting(executeStatusTask(nlpMsg, lane), routing);
      case 'list dir': return attachRouting(executeListDirTask(nlpMsg, lane), routing);
      case 'hash file': return attachRouting(executeHashTask(nlpMsg, lane), routing);
      case 'diff': return attachRouting(executeDiffTask(nlpMsg, lane), routing);
      case 'count': return attachRouting(executeCountTask(nlpMsg, lane), routing);
      case 'read file': return attachRouting(executeFileReadTask(nlpMsg, lane), routing);
      case 'grep': return attachRouting(executeGrepTask(nlpMsg, lane), routing);
      case 'git log': return attachRouting(executeGitTask(Object.assign({}, nlpMsg, { body: 'git log' }), lane), routing);
      case 'git status': return attachRouting(executeGitTask(Object.assign({}, nlpMsg, { body: 'git status' }), lane), routing);
      case 'run script': return attachRouting(executeScriptTask(nlpMsg, lane), routing);
      case 'consistency check': return attachRouting(executeConsistencyCheck(nlpMsg, lane), routing);
    }
  }

  return attachRouting({
    task_kind: 'ack',
    results: { acknowledged: true, note: 'Task type not recognized. Supported: status, "read file <path>", "run script <name>", "git status/log/diff", "grep <pattern> in <path>", "write file <path>\\n<content>", "list dir <path>", "hash file <path>", "diff <file1> <file2>", "count \\"pattern\\" in <path>", "consistency check" — or use natural language (e.g. "check if trust store is consistent")' },
    summary: `Acknowledged task: ${msg.subject || msg.task_id || 'unknown'}`,
  }, { source: 'fallback', verb: 'ack', confidence: 0.0 });
}

function createResponse(originalMsg, executionResult, lane) {
  const resultJson = JSON.stringify(executionResult.results || {});
  const contentHash = 'sha256:' + crypto.createHash('sha256').update(resultJson).digest('hex');
  const codeVersionHash = getCodeVersionHash(LANE_REGISTRY[lane].root);
  return {
    schema_version: '1.3',
    task_id: `response-${originalMsg.task_id || Date.now()}`,
    idempotency_key: `resp-${Date.now()}-${(originalMsg.task_id || 'unknown').slice(0, 16)}`,
    from: lane,
    to: originalMsg.from || 'archivist',
    type: 'response',
    task_kind: executionResult.task_kind || 'ack',
    priority: originalMsg.priority || 'P2',
    subject: `Re: ${originalMsg.subject || 'Task'}`,
    body: executionResult.summary || 'Task completed.',
    timestamp: nowIso(),
    requires_action: false,
    payload: { mode: 'inline', compression: 'none' },
    execution: { mode: 'auto', engine: 'pipeline', actor: 'task-executor' },
    lease: { owner: lane, acquired_at: nowIso() },
    retry: { attempt: 1, max_attempts: 1 },
    evidence: { required: false, verified: true },
    evidence_exchange: {
      artifact_path: null,
      artifact_type: 'response',
      delivered_at: nowIso(),
    },
    heartbeat: { status: 'done', last_heartbeat_at: nowIso(), interval_seconds: 300, timeout_seconds: 900 },
    _original_task_id: originalMsg.task_id,
    _execution_result: executionResult.results,
    _governance: { executor_version: EXECUTOR_VERSION, content_hash: contentHash, code_version_hash: codeVersionHash, timestamp: nowIso() },
  };
}

function signAndDeliver(response, lane) {
  const root = LANE_REGISTRY[lane].root;
  const outboxDir = path.join(root, 'lanes', lane, 'outbox');
  ensureDir(outboxDir);

  let signed = response;
  try {
    const { createSignedMessage } = require(path.join(root, 'scripts', 'create-signed-message.js'));
    signed = createSignedMessage(response, lane);
  } catch (e) {
    signed._signing_error = e.message;
  }

  const outPath = path.join(outboxDir, `${response.task_id}.json`);
  fs.writeFileSync(outPath, JSON.stringify(signed, null, 2), 'utf8');

  const targetDir = resolveTargetInbox(response, lane);
  ensureDir(targetDir);
  const targetPath = path.join(targetDir, `${response.task_id}.json`);
  fs.writeFileSync(targetPath, JSON.stringify(signed, null, 2), 'utf8');

  return { delivered: true, path: targetPath, outbox: outPath };
}

class GenericTaskExecutor {
  constructor(lane, options = {}) {
    this.lane = lane;
    this.dryRun = options.dryRun !== undefined ? !!options.dryRun : true;
    this.root = LANE_REGISTRY[lane].root;
    this.arDir = path.join(this.root, 'lanes', lane, 'inbox', 'action-required');
    this.ipDir = path.join(this.root, 'lanes', lane, 'inbox', 'in-progress');
    this.procDir = path.join(this.root, 'lanes', lane, 'inbox', 'processed');
    this.executed = 0;
    this.errors = [];
    this.details = [];
  }

  run() {
    ensureDir(this.arDir);
    ensureDir(this.ipDir);
    ensureDir(this.procDir);

    const files = fs.readdirSync(this.arDir)
      .filter(f => f.endsWith('.json') && !f.toLowerCase().startsWith('heartbeat'));

    if (files.length === 0) {
      return { lane: this.lane, scanned: 0, executed: 0, errors: [] };
    }

    for (const filename of files) {
      const filePath = path.join(this.arDir, filename);
      const read = safeReadJson(filePath);
      if (!read.ok) {
        this.errors.push({ file: filename, error: read.error });
        continue;
      }

      const msg = read.value;
      delete msg._lane_worker;

      if (this.dryRun) {
        this.details.push({ file: filename, task_id: msg.task_id, subject: (msg.subject || '').slice(0, 60), action: 'WOULD_EXECUTE' });
        continue;
      }

      const inProgressPath = path.join(this.ipDir, filename);
      try { fs.renameSync(filePath, inProgressPath); }
      catch (e) { this.errors.push({ file: filename, error: `Move to in-progress failed: ${e.message}` }); continue; }

      const result = executeTask(msg, this.lane);
      const response = createResponse(msg, result, this.lane);
      const delivery = signAndDeliver(response, this.lane);

      const processedPath = path.join(this.procDir, filename);
      try { fs.renameSync(inProgressPath, processedPath); }
      catch (e) { this.errors.push({ file: filename, error: `Move to processed failed: ${e.message}` }); }

      this.executed++;
      this.details.push({
        file: filename, task_id: msg.task_id, subject: (msg.subject || '').slice(0, 60),
        action: 'EXECUTED', response_id: response.task_id, delivered_to: delivery.path,
      });
    }

    return { lane: this.lane, scanned: files.length, executed: this.executed, errors: this.errors, details: this.details };
  }
}

function parseArgs(argv) {
  const out = { lane: null, apply: false };
  for (const a of argv) {
    if (a === '--apply') out.apply = true;
    else if (a.startsWith('--lane=')) out.lane = a.split('=')[1];
    else if (!a.startsWith('-') && !out.lane && LANE_REGISTRY[a]) out.lane = a;
  }
  return out;
}

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));

  if (!args.lane) {
    console.error('Usage: node generic-task-executor.js <lane> [--apply]');
    console.error('  Lanes: ' + Object.keys(LANE_REGISTRY).join(', '));
    process.exit(1);
  }

  const executor = new GenericTaskExecutor(args.lane, { dryRun: !args.apply });
  const result = executor.run();

  console.log(`[task-executor] lane=${result.lane} dry_run=${!args.apply} scanned=${result.scanned} executed=${result.executed} errors=${result.errors.length}`);
  for (const d of (result.details || [])) {
    console.log(`  ${d.action}: ${d.task_id} "${d.subject}" ${d.delivered_to ? '-> ' + d.delivered_to : ''}`);
  }
  for (const e of result.errors) {
    console.log(`  ERROR: ${e.file}: ${e.error}`);
  }
}

module.exports = { GenericTaskExecutor, executeTask, createResponse, LANE_REGISTRY, NLP_ROUTES, isPathAllowed, EXECUTOR_VERSION, FEATURE_FLAGS };
