#!/usr/bin/env node
// ORIGIN: Archivist-Agent/.global/lane-discovery.js (adapted)
// LAST_SYNC: 2026-05-02
// LOCAL UTILITY: Sovereignty-compliant local copy. No cross-lane imports.

const fs = require('fs');
const path = require('path');

const isWin32 = process.platform === 'win32';
const UBUNTU_ROOT = '/home/we4free/agent/repos';

function s(pathWin) {
  if (isWin32) return pathWin;
  const match = pathWin.match(/^S:\/(.+)$/);
  if (!match) return pathWin;
  return path.join(UBUNTU_ROOT, match[1]);
}

const LOCAL_REGISTRY = {
  schema_version: '1.1',
  registry_id: 'kernel-local-registry-001',
  origin: 'localized-from-archivist-registry-20260502',
  platform: process.platform,
  lanes: {
    archivist: {
      lane_id: 'archivist',
      role: 'coordinator',
      local_path: s('S:/Archivist-Agent'),
      repo: 'https://github.com/vortsghost2025/Archivist-Agent',
      mailboxes: {
        inbox: s('S:/Archivist-Agent/lanes/archivist/inbox'),
        outbox: s('S:/Archivist-Agent/lanes/archivist/outbox'),
        processed: s('S:/Archivist-Agent/lanes/archivist/inbox/processed')
      }
    },
    kernel: {
      lane_id: 'kernel',
      role: 'execution',
      local_path: s('S:/kernel-lane'),
      repo: 'https://github.com/vortsghost2025/kernel-lane.git',
      mailboxes: {
        inbox: s('S:/kernel-lane/lanes/kernel/inbox'),
        outbox: s('S:/kernel-lane/lanes/kernel/outbox'),
        processed: s('S:/kernel-lane/lanes/kernel/inbox/processed')
      }
    },
    swarmmind: {
      lane_id: 'swarmmind',
      role: 'optimization',
      local_path: s('S:/SwarmMind'),
      repo: 'https://github.com/vortsghost2025/SwarmMind',
      forbidden_variants: [
        s('S:/SwarmMind-Self-Optimizing-Multi-Agent-AI-System')
      ],
      mailboxes: {
        inbox: s('S:/SwarmMind/lanes/swarmmind/inbox'),
        outbox: s('S:/SwarmMind/lanes/swarmmind/outbox'),
        processed: s('S:/SwarmMind/lanes/swarmmind/inbox/processed')
      }
    },
    library: {
      lane_id: 'library',
      role: 'knowledge',
      local_path: s('S:/self-organizing-library'),
      repo: 'https://github.com/vortsghost2025/self-organizing-library',
      mailboxes: {
        inbox: s('S:/self-organizing-library/lanes/library/inbox'),
        outbox: s('S:/self-organizing-library/lanes/library/outbox'),
        processed: s('S:/self-organizing-library/lanes/library/inbox/processed')
      }
    }
  },
  broadcast: {
    path: s('S:/Archivist-Agent/lanes/broadcast')
  }
};

class LaneDiscovery {
  constructor() {
    this.registry = LOCAL_REGISTRY;
  }

  getLane(laneId) {
    const lane = this.registry.lanes[laneId.toLowerCase()];
    if (!lane) {
      throw new Error(`Lane '${laneId}' not found in registry. Available: ${Object.keys(this.registry.lanes).join(', ')}`);
    }
    return lane;
  }

  getInbox(laneId) {
    return this.getLane(laneId).mailboxes.inbox;
  }

  getOutbox(laneId) {
    return this.getLane(laneId).mailboxes.outbox;
  }

  getProcessed(laneId) {
    return this.getLane(laneId).mailboxes.processed;
  }

  getLocalPath(laneId) {
    return this.getLane(laneId).local_path;
  }

  getRepo(laneId) {
    return this.getLane(laneId).repo;
  }

  validatePath(laneId, testPath) {
    const lane = this.getLane(laneId);
    if (lane.forbidden_variants) {
      for (const variant of lane.forbidden_variants) {
        if (testPath.toLowerCase().includes(variant.toLowerCase())) {
          throw new Error(`PATH ERROR: '${testPath}' is a forbidden variant. Use canonical path: ${lane.local_path}`);
        }
      }
    }
    if (!testPath.startsWith(lane.local_path)) {
      throw new Error(`PATH MISMATCH: '${testPath}' does not match registered path for ${laneId}. Expected: ${lane.local_path}`);
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
    case 'inbox': console.log(discovery.getInbox(lane)); break;
    case 'outbox': console.log(discovery.getOutbox(lane)); break;
    case 'local': console.log(discovery.getLocalPath(lane)); break;
    case 'repo': console.log(discovery.getRepo(lane)); break;
    case 'list': console.log(discovery.listLanes().join('\n')); break;
    case 'validate':
      try { discovery.validatePath(lane, process.argv[4]); console.log('VALID'); }
      catch (e) { console.error(e.message); process.exit(1); }
      break;
    default:
      console.log('Usage: node lane-discovery.js <command> [lane] [path]');
      console.log('Commands: inbox, outbox, local, repo, list, validate');
  }
}

module.exports = { LaneDiscovery };
