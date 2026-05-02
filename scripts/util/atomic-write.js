#!/usr/bin/env node
// ORIGIN: kernel-lane/scripts/atomic-write-util.js (local re-export)
// LAST_SYNC: 2026-05-02
// LOCAL UTILITY: Sovereignty-compliant wrapper. Delegates to local atomic-write-util.
'use strict';

const { atomicWriteWithLease, tryAcquireLock, releaseLock, isLockStale } = require('../atomic-write-util');

module.exports = { atomicWriteWithLease, tryAcquireLock, releaseLock, isLockStale };
