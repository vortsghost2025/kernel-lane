#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const IS_WIN32 = process.platform === 'win32';
const LANE_REGISTRY_PATH = IS_WIN32
  ? 'S:/Archivist-Agent/.global/lane-registry.json'
  : '/home/we4free/agent/repos/Archivist-Agent/.global/lane-registry.json';

const FALLBACK_LANE_ROOTS = IS_WIN32
  ? { archivist: 'S:/Archivist-Agent', swarmmind: 'S:/SwarmMind', kernel: 'S:/kernel-lane', library: 'S:/self-organizing-library' }
  : { archivist: '/home/we4free/agent/repos/Archivist-Agent', swarmmind: '/home/we4free/agent/repos/SwarmMind', kernel: '/home/we4free/agent/repos/kernel-lane', library: '/home/we4free/agent/repos/self-organizing-library' };

function getLaneRoots() {
  if (fs.existsSync(LANE_REGISTRY_PATH)) {
    try {
      const registry = JSON.parse(fs.readFileSync(LANE_REGISTRY_PATH, 'utf8'));
      const roots = {};
      const lanes = (registry && registry.lanes) || {};
      for (const lane of Object.keys(FALLBACK_LANE_ROOTS)) {
        if (lanes[lane] && lanes[lane].local_path) {
          roots[lane] = lanes[lane].local_path;
        }
      }
      for (const lane of Object.keys(FALLBACK_LANE_ROOTS)) {
        if (!roots[lane]) roots[lane] = FALLBACK_LANE_ROOTS[lane];
      }
      return roots;
    } catch (_) {}
  }
  return { ...FALLBACK_LANE_ROOTS };
}

function getAllBroadcastTrustStorePaths() {
  const roots = getLaneRoots();
  const result = {};
  for (const [lane, root] of Object.entries(roots)) {
    result[lane] = path.join(root, 'lanes', 'broadcast', 'trust-store.json');
  }
  return result;
}

function computeKeyIdFromPem(publicKeyPem) {
  const keyObj = crypto.createPublicKey(publicKeyPem);
  const der = keyObj.export({ type: 'spki', format: 'der' });
  return crypto.createHash('sha256').update(der).digest('hex').substring(0, 16);
}

module.exports = { getAllBroadcastTrustStorePaths, getLaneRoots, computeKeyIdFromPem };
