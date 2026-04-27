#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_TIMEOUT_MS = 30000;
const LOCK_EXTENSION = '.lease';

function readLockFile(lockPath) {
  try {
    const raw = fs.readFileSync(lockPath, 'utf8');
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

function isLockStale(lock, now, timeoutMs) {
  if (!lock || !lock.acquired_at) return true;
  const acquiredAt = new Date(lock.acquired_at).getTime();
  if (Number.isNaN(acquiredAt)) return true;
  return (now - acquiredAt) > timeoutMs;
}

function tryAcquireLock(filePath, laneId, timeoutMs) {
  const lockPath = filePath + LOCK_EXTENSION;
  const now = Date.now();

  if (fs.existsSync(lockPath)) {
    const existing = readLockFile(lockPath);
    if (!isLockStale(existing, now, timeoutMs)) {
      if (existing.owner === laneId) {
        return true;
      }
      return false;
    }
    try { fs.unlinkSync(lockPath); } catch (_) {}
  }

  const lockData = {
    owner: laneId,
    acquired_at: new Date(now).toISOString(),
    expiry_ms: timeoutMs,
    target: filePath,
  };

  const tmpLock = lockPath + '.tmp';
  fs.writeFileSync(tmpLock, JSON.stringify(lockData, null, 2), 'utf8');

  try {
    fs.renameSync(tmpLock, lockPath);
    return true;
  } catch (_) {
    try { fs.unlinkSync(tmpLock); } catch (_2) {}
    return false;
  }
}

function releaseLock(filePath) {
  const lockPath = filePath + LOCK_EXTENSION;
  try { fs.unlinkSync(lockPath); } catch (_) {}
}

async function atomicWriteWithLease(filePath, content, laneId, timeoutMs) {
  const effectiveTimeout = typeof timeoutMs === 'number' && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;
  const effectiveLane = laneId || 'unknown';
  const startTime = Date.now();
  const maxWait = effectiveTimeout + 5000;
  const retryInterval = 200;

  while (Date.now() - startTime < maxWait) {
    const acquired = tryAcquireLock(filePath, effectiveLane, effectiveTimeout);
    if (acquired) {
      try {
        const tmpPath = filePath + '.tmp';
        await new Promise((resolve, reject) => {
          fs.writeFile(tmpPath, content, { encoding: 'utf8' }, err => {
            if (err) reject(err); else resolve();
          });
        });
        fs.renameSync(tmpPath, filePath);
        return { written: true, laneId: effectiveLane, timeoutMs: effectiveTimeout };
      } catch (writeErr) {
        throw writeErr;
      } finally {
        releaseLock(filePath);
      }
    }
    await new Promise(r => setTimeout(r, retryInterval));
  }

  const lockPath = filePath + LOCK_EXTENSION;
  const existing = readLockFile(lockPath);
  const owner = existing ? existing.owner : 'unknown';
  throw new Error(
    `Lease acquisition timed out for ${filePath}. ` +
    `Current lock owner: ${owner}, waited ${Date.now() - startTime}ms`
  );
}

module.exports = { atomicWriteWithLease, tryAcquireLock, releaseLock, isLockStale };
