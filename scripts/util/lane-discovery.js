#!/usr/bin/env node
/**
 * LOCAL LANE DISCOVERY UTILITY
 * ORIGIN: S:/Archivist-Agent/.global/lane-discovery.js
 * LOCALIZED: Archivist (2026-05-02)
 * UPDATED: 2026-05-06 — Platform-aware (Windows S:/ + Ubuntu)
 * PURPOSE: Local implementation to avoid cross-boundary require() on .global/
 *
 * This is a sovereign copy that reads the lane registry directly
 * instead of importing from .global/ which is an external boundary.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const isWin32 = process.platform === 'win32';
const UBUNTU_ROOT = path.join(os.homedir(), 'agent', 'repos');

const REGISTRY_PATH = isWin32
  ? 'S:/Archivist-Agent/.global/lane-registry.json'
  : path.join(UBUNTU_ROOT, 'Archivist-Agent', '.global', 'lane-registry.json');

function _resolvePath(winPath) {
  if (isWin32) return winPath;
  const match = winPath.match(/^S:\/(.+)$/);
  if (!match) return winPath;
  return path.join(UBUNTU_ROOT, match[1]);
}

function _translateRegistry(registry) {
  for (const lane of Object.values(registry.lanes)) {
    lane.local_path = _resolvePath(lane.local_path);
    if (lane.mailboxes) {
      for (const [key, val] of Object.entries(lane.mailboxes)) {
        lane.mailboxes[key] = _resolvePath(val);
      }
    }
    if (lane.broadcast_access) {
      lane.broadcast_access = _resolvePath(lane.broadcast_access);
    }
    if (lane.forbidden_variants) {
      lane.forbidden_variants = lane.forbidden_variants.map(_resolvePath);
    }
  }
  if (registry.broadcast && registry.broadcast.path) {
    registry.broadcast.path = _resolvePath(registry.broadcast.path);
  }
  return registry;
}

class LaneDiscovery {
  constructor() {
    this.registry = this.loadRegistry();
  }

  loadRegistry() {
    try {
      const data = fs.readFileSync(REGISTRY_PATH, 'utf8');
      const raw = JSON.parse(data);
      return isWin32 ? raw : _translateRegistry(raw);
    } catch (e) {
      throw new Error(`Failed to load lane registry from ${REGISTRY_PATH}: ${e.message}. Cannot proceed without registry.`);
    }
  }

  getLane(laneId) {
    const lane = this.registry.lanes[laneId.toLowerCase()];
    if (!lane) {
      throw new Error(`Lane '${laneId}' not found in registry. Available: ${Object.keys(this.registry.lanes).join(', ')}`);
    }
    return lane;
  }

  getInbox(laneId) {
    const lane = this.getLane(laneId);
    return lane.mailboxes.inbox;
  }

  getOutbox(laneId) {
    const lane = this.getLane(laneId);
    return lane.mailboxes.outbox;
  }

  getProcessed(laneId) {
    const lane = this.getLane(laneId);
    return lane.mailboxes.processed;
  }

  getLocalPath(laneId) {
    const lane = this.getLane(laneId);
    return lane.local_path;
  }

  getRepo(laneId) {
    const lane = this.getLane(laneId);
    return lane.repo;
  }

  validatePath(laneId, testPath) {
    const lane = this.getLane(laneId);

    if (lane.forbidden_variants) {
      for (const variant of lane.forbidden_variants) {
        if (testPath.toLowerCase().includes(variant.toLowerCase())) {
          throw new Error(
            `PATH ERROR: '${testPath}' is a forbidden variant. ` +
            `Use canonical path: ${lane.local_path}`
          );
        }
      }
    }

    if (!testPath.startsWith(lane.local_path)) {
      throw new Error(
        `PATH MISMATCH: '${testPath}' does not match registered path for ${laneId}. ` +
        `Expected: ${lane.local_path}`
      );
    }

    return lane.local_path;
  }

  sendToLane(fromLane, toLane, message, filename) {
    const inboxPath = this.getInbox(toLane);
    const outboxPath = this.getOutbox(fromLane);

    if (!fs.existsSync(inboxPath)) {
      fs.mkdirSync(inboxPath, { recursive: true });
    }
    if (!fs.existsSync(outboxPath)) {
      fs.mkdirSync(outboxPath, { recursive: true });
    }

    const targetPath = path.join(inboxPath, filename);
    fs.writeFileSync(targetPath, JSON.stringify(message, null, 2));

    const receipt = {
      type: 'delivery_receipt',
      to: toLane,
      message_path: targetPath,
      timestamp: new Date().toISOString(),
      status: 'delivered'
    };
    const receiptPath = path.join(outboxPath, `receipt-${filename}`);
    fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2));

    console.log(`[LANE-DISCOVERY] Sent to ${toLane}: ${targetPath}`);
    return targetPath;
  }

  listLanes() {
    return Object.keys(this.registry.lanes);
  }

  getBroadcastPath() {
    return this.registry.broadcast.path;
  }
}

if (require.main === module) {
  const discovery = new LaneDiscovery();

  const command = process.argv[2];
  const lane = process.argv[3];

  switch (command) {
    case 'inbox':
      console.log(discovery.getInbox(lane));
      break;
    case 'outbox':
      console.log(discovery.getOutbox(lane));
      break;
    case 'local':
      console.log(discovery.getLocalPath(lane));
      break;
    case 'repo':
      console.log(discovery.getRepo(lane));
      break;
    case 'list':
      console.log(discovery.listLanes().join('\n'));
      break;
    case 'validate':
      try {
        discovery.validatePath(lane, process.argv[4]);
        console.log('VALID');
      } catch (e) {
        console.error(e.message);
        process.exit(1);
      }
      break;
    default:
      console.log('Usage: node lane-discovery.js <command> [lane] [path]');
      console.log('Commands: inbox, outbox, local, repo, list, validate');
  }
}

const _discovery = new LaneDiscovery();

function getRoots() {
  const lanes = _discovery.registry.lanes;
  const roots = {};
  for (const [id, lane] of Object.entries(lanes)) {
    roots[id] = lane.local_path;
  }
  return roots;
}

function sToLocal(winPath) {
  if (!isWin32 && winPath) {
    return winPath.replace(/^S:/, '/home/we4free/agent/repos').replace(/\\/g, '/');
  }
  return winPath;
}

function getAllLanes() {
  return _discovery.registry.lanes;
}

function getLane(laneId) {
  return _discovery.getLane(laneId);
}

function getLaneNames() {
  return Object.keys(_discovery.registry.lanes);
}

const LANES = _discovery.registry.lanes;
const ROOTS = getRoots();

module.exports = {
  LaneDiscovery,
  getRoots,
  sToLocal,
  getAllLanes,
  getLane,
  getLaneNames,
  LANES,
  ROOTS
};

/**
 * ORIGIN NOTE: Adapted from S:/Archivist-Agent/.global/lane-discovery.js
 * LOCAL COPY FOR ARCHIVIST LANE SOVEREIGNTY
 * Reads the same registry but avoids cross-boundary require() on .global/
 * Last sync: 2026-05-02
 */
