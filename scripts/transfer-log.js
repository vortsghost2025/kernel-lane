#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const POLICY_PATH = path.join(__dirname, '..', 'config', 'transfer-log-policy.json');
const DEFAULT_LOG_PATH = path.join(__dirname, '..', 'logs', 'transfer-log.jsonl');

const DEFAULT_POLICY = {
  log_path: 'logs/transfer-log.jsonl',
  max_file_bytes: 10485760,
  rotation_count: 5,
  hash_algorithm: 'sha256',
  direction_enum: ['send', 'receive', 'scp_push', 'scp_pull', 'ssh_exec', 'smb_copy', 'local_copy'],
  status_enum: ['success', 'failed', 'retrying', 'aborted', 'verified'],
  protocol_enum: ['scp', 'ssh', 'smb', 'local_fs', 'http'],
  rotation: { compress_rotated: true, suffix: '.gz' },
  fields: {
    required: ['transfer_id', 'timestamp', 'direction', 'source_lane', 'dest_lane', 'protocol', 'file_path', 'file_hash', 'file_size', 'status', 'signed_by', 'key_id'],
  },
};

function loadPolicy(policyPath) {
  try {
    return JSON.parse(fs.readFileSync(policyPath || POLICY_PATH, 'utf8'));
  } catch (_) {
    return Object.assign({}, DEFAULT_POLICY);
  }
}

function resolveLogPath(policy) {
  const raw = policy.log_path || DEFAULT_POLICY.log_path;
  if (path.isAbsolute(raw)) return raw;
  return path.join(__dirname, '..', raw);
}

function hashContent(content, algorithm) {
  return crypto.createHash(algorithm || 'sha256').update(content).digest('hex');
}

function hashFile(filePath, algorithm) {
  try {
    const content = fs.readFileSync(filePath);
    return crypto.createHash(algorithm || 'sha256').update(content).digest('hex');
  } catch (_) {
    return '';
  }
}

function getFileSize(filePath) {
  try {
    return fs.statSync(filePath).size;
  } catch (_) {
    return -1;
  }
}

function generateTransferId(sourceLane, destLane) {
  const ts = Date.now();
  const rand = crypto.randomBytes(4).toString('hex');
  return `xfr-${sourceLane}-${destLane}-${ts}-${rand}`;
}

function validateEntry(entry, policy) {
  const errors = [];
  const requiredFields = (policy.fields && policy.fields.required) || DEFAULT_POLICY.fields.required;
  for (const field of requiredFields) {
    if (entry[field] === undefined || entry[field] === null) {
      errors.push(`Missing required field: ${field}`);
    }
  }
  if (entry.direction && policy.direction_enum && !policy.direction_enum.includes(entry.direction)) {
    errors.push(`Invalid direction "${entry.direction}"`);
  }
  if (entry.status && policy.status_enum && !policy.status_enum.includes(entry.status)) {
    errors.push(`Invalid status "${entry.status}"`);
  }
  if (entry.protocol && policy.protocol_enum && !policy.protocol_enum.includes(entry.protocol)) {
    errors.push(`Invalid protocol "${entry.protocol}"`);
  }
  return { valid: errors.length === 0, errors };
}

function checkRotation(logPath, policy) {
  try {
    const stat = fs.statSync(logPath);
    const maxBytes = policy.max_file_bytes || DEFAULT_POLICY.max_file_bytes;
    if (stat.size < maxBytes) return false;
  } catch (_) {
    return false;
  }
  return true;
}

function rotateLog(logPath, policy) {
  const maxRotation = policy.rotation_count || DEFAULT_POLICY.rotation_count;
  const compress = policy.rotation && policy.rotation.compress_rotated !== false;
  const suffix = (policy.rotation && policy.rotation.suffix) || '.gz';

  for (let i = maxRotation - 1; i >= 1; i--) {
    const oldPath = logPath + '.' + i + (compress ? suffix : '');
    const newPath = logPath + '.' + (i + 1) + (compress ? suffix : '');
    if (fs.existsSync(oldPath)) {
      if (i === maxRotation - 1) {
        fs.unlinkSync(oldPath);
      } else {
        fs.renameSync(oldPath, newPath);
      }
    }
  }

  const rotatedPath = logPath + '.1' + (compress ? suffix : '');
  if (compress) {
    const zlib = require('zlib');
    const content = fs.readFileSync(logPath);
    const compressed = zlib.gzipSync(content);
    fs.writeFileSync(rotatedPath, compressed);
    fs.writeFileSync(logPath, '');
  } else {
    fs.renameSync(logPath, rotatedPath);
  }

  return { rotated: true, path: rotatedPath };
}

function logTransfer(entryOrDetails, options) {
  const opts = options || {};
  const policy = opts.policy || loadPolicy();
  const logPath = opts.logPath || resolveLogPath(policy);

  let entry;
  if (entryOrDetails && entryOrDetails.transfer_id) {
    entry = Object.assign({}, entryOrDetails);
  } else {
    const details = entryOrDetails || {};
    const algorithm = policy.hash_algorithm || DEFAULT_POLICY.hash_algorithm;
    const fileHash = details.file_hash || (details.file_path ? hashFile(details.file_path, algorithm) : '');
    const fileSize = details.file_size || (details.file_path ? getFileSize(details.file_path) : -1);

    entry = {
      transfer_id: details.transfer_id || generateTransferId(details.source_lane || 'unknown', details.dest_lane || 'unknown'),
      timestamp: details.timestamp || new Date().toISOString(),
      direction: details.direction || 'send',
      source_lane: details.source_lane || 'unknown',
      dest_lane: details.dest_lane || 'unknown',
      protocol: details.protocol || 'local_fs',
      file_path: details.file_path || '',
      file_hash: fileHash,
      file_size: fileSize,
      status: details.status || 'success',
      signed_by: details.signed_by || '',
      key_id: details.key_id || '',
    };

    if (details.duration_ms !== undefined) entry.duration_ms = details.duration_ms;
    if (details.error) entry.error = details.error;
    if (details.retry_attempt !== undefined) entry.retry_attempt = details.retry_attempt;
    if (details.correlation_id) entry.correlation_id = details.correlation_id;
    if (details.metadata) entry.metadata = details.metadata;
  }

  const validation = validateEntry(entry, policy);
  if (!validation.valid) {
    return { logged: false, errors: validation.errors, entry: entry };
  }

  if (checkRotation(logPath, policy)) {
    rotateLog(logPath, policy);
  }

  const logDir = path.dirname(logPath);
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }

  const line = JSON.stringify(entry) + '\n';

  if (opts.dryRun) {
    return { logged: false, dryRun: true, entry: entry, line: line.trim() };
  }

  try {
    fs.appendFileSync(logPath, line, 'utf8');
    return { logged: true, transfer_id: entry.transfer_id, file_hash: entry.file_hash, entry: entry };
  } catch (e) {
    return { logged: false, errors: [`Write failed: ${e.message}`], entry: entry };
  }
}

function logSendResult(sendResult, msg, options) {
  const opts = options || {};
  const sourceLane = (msg && msg.from) || 'archivist';
  const destLane = (msg && msg.to) || 'unknown';
  const algorithm = (opts.policy && opts.policy.hash_algorithm) || 'sha256';
  const content = msg ? JSON.stringify(msg) : '';
  const fileHash = content ? hashContent(content, algorithm) : '';

  return logTransfer({
    source_lane: sourceLane,
    dest_lane: destLane,
    direction: 'send',
    protocol: 'local_fs',
    file_path: '',
    file_hash: fileHash,
    file_size: content.length,
    status: sendResult.delivered ? 'verified' : (sendResult.sent ? 'success' : 'failed'),
    signed_by: sourceLane,
    key_id: (msg && msg.key_id) || '',
    correlation_id: (msg && msg.task_id) || '',
    error: sendResult.errors && sendResult.errors.length > 0 ? sendResult.errors.join('; ') : '',
  }, opts);
}

function queryLog(options) {
  const opts = options || {};
  const policy = opts.policy || loadPolicy();
  const logPath = opts.logPath || resolveLogPath(policy);
  const limit = opts.limit || 100;
  const filter = opts.filter || {};

  let lines;
  try {
    const content = fs.readFileSync(logPath, 'utf8');
    lines = content.trim().split('\n').filter(function(l) { return l.length > 0; });
  } catch (_) {
    return { entries: [], total: 0 };
  }

  let entries = lines.map(function(line) {
    try { return JSON.parse(line); } catch (_) { return null; }
  }).filter(function(e) { return e !== null; });

  if (filter.source_lane) {
    entries = entries.filter(function(e) { return e.source_lane === filter.source_lane; });
  }
  if (filter.dest_lane) {
    entries = entries.filter(function(e) { return e.dest_lane === filter.dest_lane; });
  }
  if (filter.direction) {
    entries = entries.filter(function(e) { return e.direction === filter.direction; });
  }
  if (filter.status) {
    entries = entries.filter(function(e) { return e.status === filter.status; });
  }
  if (filter.protocol) {
    entries = entries.filter(function(e) { return e.protocol === filter.protocol; });
  }
  if (filter.since) {
    entries = entries.filter(function(e) { return e.timestamp >= filter.since; });
  }
  if (filter.until) {
    entries = entries.filter(function(e) { return e.timestamp <= filter.until; });
  }
  if (filter.correlation_id) {
    entries = entries.filter(function(e) { return e.correlation_id === filter.correlation_id; });
  }

  const total = entries.length;
  const start = Math.max(0, total - limit);
  entries = entries.slice(start);

  return { entries: entries, total: total, showing: entries.length };
}

function getStats(options) {
  const opts = options || {};
  const result = queryLog(Object.assign({}, opts, { limit: 999999 }));
  const entries = result.entries;

  const stats = {
    total_transfers: entries.length,
    by_status: {},
    by_direction: {},
    by_protocol: {},
    by_lane: {},
    failed_count: 0,
    verified_count: 0,
  };

  for (const entry of entries) {
    stats.by_status[entry.status] = (stats.by_status[entry.status] || 0) + 1;
    stats.by_direction[entry.direction] = (stats.by_direction[entry.direction] || 0) + 1;
    stats.by_protocol[entry.protocol] = (stats.by_protocol[entry.protocol] || 0) + 1;
    const laneKey = entry.source_lane + '->' + entry.dest_lane;
    stats.by_lane[laneKey] = (stats.by_lane[laneKey] || 0) + 1;
    if (entry.status === 'failed' || entry.status === 'aborted') stats.failed_count++;
    if (entry.status === 'verified') stats.verified_count++;
  }

  return stats;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const command = args[0];

  if (command === 'query') {
    const filter = {};
    for (let i = 1; i < args.length; i++) {
      if (args[i].startsWith('--source=')) filter.source_lane = args[i].split('=')[1];
      if (args[i].startsWith('--dest=')) filter.dest_lane = args[i].split('=')[1];
      if (args[i].startsWith('--status=')) filter.status = args[i].split('=')[1];
      if (args[i].startsWith('--direction=')) filter.direction = args[i].split('=')[1];
      if (args[i].startsWith('--protocol=')) filter.protocol = args[i].split('=')[1];
      if (args[i].startsWith('--since=')) filter.since = args[i].split('=')[1];
      if (args[i].startsWith('--until=')) filter.until = args[i].split('=')[1];
      if (args[i].startsWith('--limit=')) filter.limit = parseInt(args[i].split('=')[1], 10);
    }
    const result = queryLog(filter);
    console.log(JSON.stringify(result, null, 2));
  } else if (command === 'stats') {
    const stats = getStats();
    console.log(JSON.stringify(stats, null, 2));
  } else if (command === 'log') {
    const entry = JSON.parse(args[1] || '{}');
    const result = logTransfer(entry);
    if (result.logged) {
      console.log('[LOGGED] ' + result.transfer_id);
    } else {
      console.error('[FAILED] ' + (result.errors || []).join(', '));
      process.exit(1);
    }
  } else if (command === 'rotate') {
    const policy = loadPolicy();
    const logPath = resolveLogPath(policy);
    if (checkRotation(logPath, policy)) {
      const result = rotateLog(logPath, policy);
      console.log('[ROTATED] ' + result.path);
    } else {
      console.log('[NO-ROTATE] Log file under size limit');
    }
  } else {
    console.log('Usage: node transfer-log.js <command> [options]');
    console.log('Commands: query, stats, log, rotate');
    console.log('  query  --source=X --dest=X --status=X --direction=X --protocol=X --since=ISO --until=ISO --limit=N');
    console.log('  stats  — summary statistics');
    console.log('  log <json-entry> — log a transfer entry');
    console.log('  rotate — force rotation if over size limit');
  }
}

module.exports = {
  logTransfer,
  logSendResult,
  queryLog,
  getStats,
  loadPolicy,
  resolveLogPath,
  hashContent,
  hashFile,
  generateTransferId,
  validateEntry,
  checkRotation,
  rotateLog,
};
