#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const PRIORITY_ORDER = { P0: 0, P1: 1, P2: 2, P3: 3 };

const SKIP_FILENAMES = new Set([
  'heartbeat.json', 'watcher.log', 'watcher.pid', 'readme.md'
]);

const HEARTBEAT_PATTERN = /^heartbeat-.+\.json$/i;
const INBOX_MSG_PATTERN = /^\d{4}-/;

function isValidInboxMessage(filename) {
  const lower = filename.toLowerCase();
  if (SKIP_FILENAMES.has(lower)) return false;
  if (HEARTBEAT_PATTERN.test(lower)) return false;
  if (!INBOX_MSG_PATTERN.test(filename)) return false;
  return filename.endsWith('.json');
}

const DEFAULT_CONFIG = {
  laneName: 'kernel',
  inboxPath: path.join(__dirname, '..', 'lanes', 'kernel', 'inbox'),
  processedPath: path.join(__dirname, '..', 'lanes', 'kernel', 'inbox', 'processed'),
  outboxPath: path.join(__dirname, '..', 'lanes', 'kernel', 'outbox'),
  expiredPath: path.join(__dirname, '..', 'lanes', 'kernel', 'inbox', 'expired')
};

class InboxWatcher {
  constructor(overrides) {
    this.config = Object.assign({}, DEFAULT_CONFIG, overrides || {});
    this.processedKeys = new Set();
  }

  ensureDirs() {
    for (const dir of [this.config.inboxPath, this.config.processedPath,
                       this.config.outboxPath, this.config.expiredPath]) {
      if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); }
    }
  }

  loadProcessedKeys() {
    try {
      for (const f of fs.readdirSync(this.config.processedPath)) {
        if (f.endsWith('.json')) this.processedKeys.add(f);
      }
    } catch (e) { /* first run */ }
  }

  scan() {
    this.ensureDirs();
    this.loadProcessedKeys();

    let files;
    try { files = fs.readdirSync(this.config.inboxPath); }
    catch (e) { console.error('[watcher] Cannot read inbox:', e.message); return []; }

    const messages = [];
    for (const filename of files) {
      if (!isValidInboxMessage(filename)) continue;
      if (this.processedKeys.has(filename)) continue;
      const filePath = path.join(this.config.inboxPath, filename);
      try {
        const msg = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        msg._sourceFile = filename;
        msg._sourcePath = filePath;
        messages.push(msg);
      } catch (e) {
        console.error(`[watcher] Cannot parse ${filename}:`, e.message);
        this.moveToProcessed(filename, filePath);
      }
    }

    messages.sort((a, b) => (PRIORITY_ORDER[a.priority] ?? 3) - (PRIORITY_ORDER[b.priority] ?? 3));
    return messages;
  }

  moveToProcessed(filename, sourcePath) {
    const dest = path.join(this.config.processedPath, filename);
    try {
      if (fs.existsSync(dest)) { fs.unlinkSync(sourcePath); }
      else { fs.renameSync(sourcePath, dest); }
      this.processedKeys.add(filename);
    } catch (e) { console.error(`[watcher] Cannot move ${filename}:`, e.message); }
  }

  processMessage(msg) {
    const filename = msg._sourceFile;
    const sourcePath = msg._sourcePath;
    const from = msg.from || 'unknown';
    const type = msg.type || 'unknown';
    const priority = msg.priority || 'P3';
    const body = msg.body || '';

    console.log(`[watcher] ${priority} ${type} from ${from}: ${body.slice(0, 80)}`);

    // Kernel-specific: handle release requests and benchmark tasks
    if (type === 'task' && body.toLowerCase().includes('benchmark')) {
      console.log(`[watcher] BENCHMARK TASK: ${msg.id || filename}`);
    }

    if (msg.requires_action) {
      console.log(`[watcher] ACTION REQUIRED: ${msg.id || filename}`);
    }

    this.moveToProcessed(filename, sourcePath);
  }

  run() {
    console.log(`[watcher] ${this.config.laneName} inbox scan starting`);
    const messages = this.scan();
    console.log(`[watcher] Found ${messages.length} messages`);

    for (const msg of messages) {
      try { this.processMessage(msg); }
      catch (e) { console.error(`[watcher] Error: ${e.message}`); }
    }

    return messages.length;
  }
}

module.exports = { InboxWatcher, DEFAULT_CONFIG };

if (require.main === module) {
  const args = process.argv.slice(2);
  const watcher = new InboxWatcher();

  if (args.includes('--scan')) {
    const messages = watcher.scan();
    console.log(JSON.stringify(messages.map(m => ({
      id: m.id, from: m.from, priority: m.priority, type: m.type
    })), null, 2));
  } else {
    const count = watcher.run();
    console.log(`[watcher] Processed ${count} messages`);
  }
}
