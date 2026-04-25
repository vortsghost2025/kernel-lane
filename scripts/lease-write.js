#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const KERNEL_ROOT = 'S:/kernel-lane';
const { atomicWriteWithLease } = require(path.join(KERNEL_ROOT, 'scripts', 'atomic-write-util'));

function ensureParentDir(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

async function writeWithLease(filePath, content, laneId, timeoutMs = 30000) {
  ensureParentDir(filePath);
  return atomicWriteWithLease(filePath, content, laneId, timeoutMs);
}

async function moveFileWithLease(sourcePath, destPath, laneId, timeoutMs = 30000) {
  if (!fs.existsSync(sourcePath)) {
    return { moved: false, reason: 'SOURCE_MISSING', sourcePath, destPath };
  }

  ensureParentDir(destPath);

  if (fs.existsSync(destPath)) {
    fs.unlinkSync(sourcePath);
    return { moved: false, reason: 'DEST_EXISTS_SOURCE_DROPPED', sourcePath, destPath };
  }

  const content = fs.readFileSync(sourcePath, 'utf8');
  await writeWithLease(destPath, content, laneId, timeoutMs);
  fs.unlinkSync(sourcePath);
  return { moved: true, sourcePath, destPath };
}

module.exports = {
  writeWithLease,
  moveFileWithLease,
};

