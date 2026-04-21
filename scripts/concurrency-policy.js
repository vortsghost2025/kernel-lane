'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_POLICY = {
  enforcement: {
    one_watcher_process_per_repo: true,
    max_concurrent_message_processing: 1,
    min_poll_interval_seconds: 60,
    min_heartbeat_interval_seconds: 60,
    reject_uuid_named_temp_files: true
  },
  locks: {
    watcher_lock_dir: '.runtime/locks',
    watcher_lock_file_pattern: 'watcher-{lane}.lock',
    stale_after_seconds: 900
  }
};

function loadPolicy(repoRoot) {
  const policyPath = path.join(repoRoot, 'lanes', 'broadcast', 'CONCURRENCY_POLICY_v1.json');
  try {
    if (fs.existsSync(policyPath)) {
      return JSON.parse(fs.readFileSync(policyPath, 'utf8'));
    }
  } catch (_) {
    // fall through to defaults
  }
  return DEFAULT_POLICY;
}

function assertWatcherConfig({ laneName, pollSeconds, heartbeatSeconds, maxConcurrent }, policy) {
  const rules = (policy && policy.enforcement) || DEFAULT_POLICY.enforcement;

  if (typeof maxConcurrent === 'number' && maxConcurrent > rules.max_concurrent_message_processing) {
    throw new Error(
      `CONCURRENCY_POLICY_VIOLATION: maxConcurrent=${maxConcurrent} exceeds ${rules.max_concurrent_message_processing}`
    );
  }
  if (typeof pollSeconds === 'number' && pollSeconds < rules.min_poll_interval_seconds) {
    throw new Error(
      `CONCURRENCY_POLICY_VIOLATION: pollSeconds=${pollSeconds} below minimum ${rules.min_poll_interval_seconds}`
    );
  }
  if (typeof heartbeatSeconds === 'number' && heartbeatSeconds < rules.min_heartbeat_interval_seconds) {
    throw new Error(
      `CONCURRENCY_POLICY_VIOLATION: heartbeatSeconds=${heartbeatSeconds} below minimum ${rules.min_heartbeat_interval_seconds}`
    );
  }
  if (!laneName || typeof laneName !== 'string') {
    throw new Error('CONCURRENCY_POLICY_VIOLATION: missing laneName');
  }
}

function acquireWatcherLock({ repoRoot, laneName, policy }) {
  const lockCfg = (policy && policy.locks) || DEFAULT_POLICY.locks;
  const lockDir = path.join(repoRoot, lockCfg.watcher_lock_dir || '.runtime/locks');
  const filePattern = lockCfg.watcher_lock_file_pattern || 'watcher-{lane}.lock';
  const staleAfterSeconds = Number(lockCfg.stale_after_seconds || 900);
  const lockFile = filePattern.replace('{lane}', laneName);
  const lockPath = path.join(lockDir, lockFile);

  if (!fs.existsSync(lockDir)) {
    fs.mkdirSync(lockDir, { recursive: true });
  }

  const owner = {
    lane: laneName,
    pid: process.pid,
    host: os.hostname(),
    acquired_at: new Date().toISOString()
  };

  const tryAcquire = () => {
    fs.writeFileSync(lockPath, JSON.stringify(owner, null, 2), { flag: 'wx' });
  };

  try {
    tryAcquire();
  } catch (err) {
    if (!err || err.code !== 'EEXIST') {
      throw err;
    }

    let stale = false;
    try {
      const raw = fs.readFileSync(lockPath, 'utf8');
      const existing = JSON.parse(raw);
      const acquiredMs = Date.parse(existing.acquired_at);
      const sameHost = !existing.host || existing.host === os.hostname();
      let pidAlive = null;
      if (sameHost && Number.isInteger(existing.pid) && existing.pid > 0) {
        try {
          process.kill(existing.pid, 0);
          pidAlive = true;
        } catch (pidErr) {
          // ESRCH => no such process; EPERM => process exists but cannot signal.
          pidAlive = pidErr && pidErr.code === 'EPERM';
        }
      }

      // Crash-safe contract: never trust filesystem timestamps for lock logic.
      // If acquired_at is missing or invalid, treat lock as stale and reclaim.
      if (!Number.isFinite(acquiredMs)) {
        stale = true;
      } else if (pidAlive === false) {
        stale = true;
        console.log(
          `[lock] Reclaiming dead-pid lock (old_pid=${existing.pid}, host=${existing.host || 'unknown'})`
        );
      } else {
        const ageSeconds = Math.floor((Date.now() - acquiredMs) / 1000);
        stale = ageSeconds > staleAfterSeconds;
        if (stale) {
          console.log(
            `[lock] Reclaiming stale lock (age=${ageSeconds}s, stale_after=${staleAfterSeconds}s, old_pid=${existing.pid})`
          );
        }
      }
    } catch (_) {
      stale = true;
    }

    if (!stale) {
      throw new Error(`CONCURRENCY_POLICY_VIOLATION: watcher lock already held at ${lockPath}`);
    }

    try {
      fs.unlinkSync(lockPath);
      tryAcquire();
    } catch (reErr) {
      throw new Error(`CONCURRENCY_POLICY_VIOLATION: could not acquire stale watcher lock (${reErr.message})`);
    }
  }

  return () => {
    try {
      if (!fs.existsSync(lockPath)) return;
      const raw = fs.readFileSync(lockPath, 'utf8');
      const existing = JSON.parse(raw);
      if (existing && existing.pid === process.pid) {
        fs.unlinkSync(lockPath);
      }
    } catch (_) {
      // best effort
    }
  };
}

module.exports = {
  loadPolicy,
  assertWatcherConfig,
  acquireWatcherLock
};
