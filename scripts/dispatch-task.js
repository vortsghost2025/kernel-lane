#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const REPO_ROOT = path.resolve(__dirname, '..');

const LANE_REGISTRY = {
  archivist: { inbox: 'S:/Archivist-Agent/lanes/archivist/inbox', root: 'S:/Archivist-Agent' },
  kernel: { inbox: 'S:/kernel-lane/lanes/kernel/inbox', root: 'S:/kernel-lane' },
  library: { inbox: 'S:/self-organizing-library/lanes/library/inbox', root: 'S:/self-organizing-library' },
  swarmmind: { inbox: 'S:/SwarmMind/lanes/swarmmind/inbox', root: 'S:/SwarmMind' },
};

function generateId() {
  return 'task-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex');
}

function dispatchTask(options) {
  const {
    to,
    from = 'archivist',
    type = 'task',
    taskKind = 'proposal',
    priority = 'P2',
    subject,
    body,
    requiresAction = true,
    payload = {},
    artifactPath = null,
  } = options;

  if (!LANE_REGISTRY[to]) throw new Error(`Unknown lane: ${to}. Valid: ${Object.keys(LANE_REGISTRY).join(', ')}`);
  if (!subject) throw new Error('subject is required');

  const taskId = generateId();
  const now = new Date().toISOString();

  const msg = {
    schema_version: '1.3',
    task_id: taskId,
    idempotency_key: crypto.createHash('sha256').update(taskId + from + to + now).digest('hex').slice(0, 64),
    from,
    to,
    type,
    task_kind: taskKind,
    priority,
    subject,
    body: body || '',
    timestamp: now,
    requires_action: requiresAction,
    payload: { mode: 'inline', compression: 'none', ...payload },
    execution: { mode: 'manual', engine: 'opencode', actor: 'lane' },
    lease: { owner: to, acquired_at: now },
    retry: { attempt: 1, max_attempts: 3 },
    evidence: { required: true, verified: false },
    evidence_exchange: artifactPath ? {
      artifact_path: artifactPath,
      artifact_type: 'log',
      delivered_at: now,
    } : {
      artifact_path: `lanes/${to}/outbox/response-${taskId}.json`,
      artifact_type: 'response',
      delivered_at: now,
    },
    heartbeat: {
      status: 'pending',
      last_heartbeat_at: now,
      interval_seconds: 300,
      timeout_seconds: 3600,
    },
  };

  // Sign
  try {
    const { createSignedMessage } = require(path.join(REPO_ROOT, 'scripts', 'create-signed-message.js'));
    const signed = createSignedMessage(msg, from);
    Object.assign(msg, signed);
  } catch (e) {
    console.error(`[dispatch] Signing failed: ${e.message}, dispatching unsigned`);
  }

  // Deliver
  const targetInbox = LANE_REGISTRY[to].inbox;
  if (!fs.existsSync(targetInbox)) fs.mkdirSync(targetInbox, { recursive: true });
  const outPath = path.join(targetInbox, `${taskId}.json`);
  fs.writeFileSync(outPath, JSON.stringify(msg, null, 2), 'utf8');

  // Log to own outbox
  const ownOutbox = path.join(LANE_REGISTRY[from].inbox, '..', 'outbox');
  if (!fs.existsSync(ownOutbox)) fs.mkdirSync(ownOutbox, { recursive: true });
  fs.writeFileSync(path.join(ownOutbox, `${taskId}.json`), JSON.stringify(msg, null, 2), 'utf8');

  return { task_id: taskId, delivered_to: outPath, signed: !!msg.signature };
}

function parseArgs(argv) {
  const args = { from: 'archivist' };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--to': args.to = argv[++i]; break;
      case '--from': args.from = argv[++i]; break;
      case '--type': args.type = argv[++i]; break;
      case '--kind': args.taskKind = argv[++i]; break;
      case '--priority': args.priority = argv[++i]; break;
      case '--subject': args.subject = argv[++i]; break;
      case '--body': args.body = argv[++i]; break;
      case '--no-action': args.requiresAction = false; break;
      case '--artifact': args.artifactPath = argv[++i]; break;
    }
  }
  return args;
}

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  if (!args.to || !args.subject) {
    console.error('Usage: node dispatch-task.js --to <lane> --subject "..." [--body "..."] [--kind proposal] [--priority P2] [--from archivist] [--no-action] [--artifact path]');
    console.error('Lanes:', Object.keys(LANE_REGISTRY).join(', '));
    process.exit(1);
  }
  try {
    const result = dispatchTask(args);
    console.log(`[dispatch] task_id=${result.task_id} signed=${result.signed} delivered=${result.delivered_to}`);
  } catch (e) {
    console.error(`[dispatch] ERROR: ${e.message}`);
    process.exit(1);
  }
}

module.exports = { dispatchTask, LANE_REGISTRY };
