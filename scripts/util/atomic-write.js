#!/usr/bin/env node
'use strict';
/**
 * LOCAL ATOMIC WRITE UTILITY
 * ORIGIN: S:/kernel-lane/scripts/atomic-write-util.js
 * LOCALIZED: Archivist (2026-05-02)
 * PURPOSE: Local implementation to avoid cross-lane require() from kernel-lane
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const IS_WINDOWS = os.platform() === 'win32';
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
    hostname: os.hostname(),
    pid: process.pid
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
  const MAX_RETRIES = 10;

  let attempt = 0;
  while (Date.now() - startTime < maxWait && attempt < MAX_RETRIES) {
    attempt++;
    const acquired = tryAcquireLock(filePath, effectiveLane, effectiveTimeout);
    if (acquired) {
      const tmpPath = filePath + '.tmp.' + process.pid;
      try {
        if (IS_WINDOWS) {
          const fd = fs.openSync(tmpPath, 'wx');
          try {
            if (Buffer.isBuffer(content)) {
              fs.writeSync(fd, content);
            } else {
              fs.writeSync(fd, content, 'utf8');
            }
            fs.fsyncSync(fd);
          } finally {
            fs.closeSync(fd);
          }

          try {
            fs.renameSync(tmpPath, filePath);
          } catch (renameErr) {
            fs.copyFileSync(tmpPath, filePath);
            fs.unlinkSync(tmpPath);
          }
        } else {
          const fd = fs.openSync(tmpPath, 'wx');
          try {
            if (Buffer.isBuffer(content)) {
              fs.writeSync(fd, content);
            } else {
              fs.writeSync(fd, content, 'utf8');
            }
            fs.fsyncSync(fd);
          } finally {
            fs.closeSync(fd);
          }
          fs.renameSync(tmpPath, filePath);
        }

        const verifyContent = fs.readFileSync(filePath, 'utf8');
        if (verifyContent !== content && !Buffer.isBuffer(content) &&
          !Buffer.from(verifyContent).equals(Buffer.from(content))) {
          throw new Error('Write verification failed - content mismatch');
        }

        return { written: true, laneId: effectiveLane, timeoutMs: effectiveTimeout, attempt };
      } catch (writeErr) {
        try {
          if (fs.existsSync(tmpPath)) {
            fs.unlinkSync(tmpPath);
          }
        } catch (_) {}

        if (attempt >= MAX_RETRIES) {
          throw writeErr;
        }

        await new Promise(r => setTimeout(r, retryInterval * attempt));
      } finally {
        releaseLock(filePath);
      }
    }

    await new Promise(r => setTimeout(r, retryInterval * attempt));
  }

  const lockPath = filePath + LOCK_EXTENSION;
  const existing = readLockFile(lockPath);
  const owner = existing ? existing.owner : 'unknown';
  throw new Error(
    `Lease acquisition timed out after ${attempt} attempts for ${filePath}. ` +
    `Current lock owner: ${owner}, waited ${Date.now() - startTime}ms`
  );
}

module.exports = { atomicWriteWithLease, tryAcquireLock, releaseLock, isLockStale, IS_WINDOWS };

/**
 * ORIGIN NOTE: Adapted from S:/kernel-lane/scripts/atomic-write-util.js
 * LOCAL COPY FOR ARCHIVIST LANE SOVEREIGNTY
 * Last sync: 2026-05-02
 */
