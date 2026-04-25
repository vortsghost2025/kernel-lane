#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const CANONICAL_INBOX = {
  archivist: 'S:/Archivist-Agent/lanes/archivist/inbox/',
  library:   'S:/self-organizing-library/lanes/library/inbox/',
  swarmmind: 'S:/SwarmMind/lanes/swarmmind/inbox/',
  kernel:    'S:/kernel-lane/lanes/kernel/inbox/',
};

const LANE_ROOTS = {
  archivist: 'S:/Archivist-Agent',
  library:   'S:/self-organizing-library',
  swarmmind: 'S:/SwarmMind',
  kernel:    'S:/kernel-lane',
};

function nowIso() { return new Date().toISOString(); }

function parseArgs(argv) {
  const out = { lane: null, apply: false, pollSeconds: 20, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--lane' && argv[i + 1]) { out.lane = String(argv[i + 1]).toLowerCase(); i++; continue; }
    if (a === '--apply') { out.apply = true; continue; }
    if (a === '--poll-seconds' && argv[i + 1]) { out.pollSeconds = Math.max(1, Number(argv[i + 1]) || out.pollSeconds); i++; continue; }
    if (a === '--json') { out.json = true; continue; }
  }
  return out;
}

function guessLane(repoRoot) {
  const lower = String(repoRoot || '').toLowerCase();
  if (lower.includes('archivist')) return 'archivist';
  if (lower.includes('kernel-lane')) return 'kernel';
  if (lower.includes('self-organizing') || lower.includes('library')) return 'library';
  if (lower.includes('swarmmind')) return 'swarmmind';
  return 'archivist';
}

function safeReadJson(filePath) {
  try {
    return { ok: true, value: JSON.parse(fs.readFileSync(filePath, 'utf8')) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

class RelayDaemon {
  constructor(options = {}) {
    this.repoRoot = options.repoRoot || path.resolve(__dirname, '..');
    this.lane = options.lane || guessLane(this.repoRoot);
    this.dryRun = options.dryRun !== undefined ? !!options.dryRun : true;
    this.outboxDir = path.join(this.repoRoot, 'lanes', this.lane, 'outbox');
    this.deliveredDir = path.join(this.outboxDir, 'delivered');
  }

  deliverOutbox() {
    if (!fs.existsSync(this.outboxDir)) {
      return { scanned: 0, delivered: 0, errors: [] };
    }

    const entries = fs.readdirSync(this.outboxDir, { withFileTypes: true });
    const jsonFiles = entries.filter(e => e.isFile() && e.name.endsWith('.json'));

    const results = { scanned: jsonFiles.length, delivered: 0, errors: [], details: [] };

    for (const ent of jsonFiles) {
      const filePath = path.join(this.outboxDir, ent.name);
      const read = safeReadJson(filePath);
      if (!read.ok) {
        results.errors.push({ file: ent.name, error: read.error });
        continue;
      }

      const msg = read.value;
      const targetLane = msg.to;
      if (!targetLane || !CANONICAL_INBOX[targetLane]) {
        results.errors.push({ file: ent.name, error: `Unknown target lane: ${targetLane}` });
        continue;
      }

      const targetDir = CANONICAL_INBOX[targetLane];
      const targetPath = path.join(targetDir, ent.name);

      if (!this.dryRun) {
        try {
          if (!fs.existsSync(targetDir)) {
            fs.mkdirSync(targetDir, { recursive: true });
          }
          fs.writeFileSync(targetPath, JSON.stringify(msg, null, 2), 'utf8');
          fs.unlinkSync(filePath);
          results.delivered++;
          results.details.push({ file: ent.name, from: this.lane, to: targetLane, target: targetPath });
        } catch (err) {
          results.errors.push({ file: ent.name, error: err.message });
        }
      } else {
        results.details.push({ file: ent.name, from: this.lane, to: targetLane, target: targetPath, dry_run: true });
      }
    }

    return results;
  }

  collectIncoming() {
    const otherLanes = Object.keys(CANONICAL_INBOX).filter(l => l !== this.lane);
    const results = { collected: 0, errors: [], details: [] };

    for (const otherLane of otherLanes) {
      const otherOutbox = path.join(LANE_ROOTS[otherLane], 'lanes', otherLane, 'outbox');
      if (!fs.existsSync(otherOutbox)) continue;

      const entries = fs.readdirSync(otherOutbox, { withFileTypes: true });
      const jsonFiles = entries.filter(e => e.isFile() && e.name.endsWith('.json'));

      for (const ent of jsonFiles) {
        const filePath = path.join(otherOutbox, ent.name);
        const read = safeReadJson(filePath);
        if (!read.ok) continue;

        const msg = read.value;
        if (msg.to !== this.lane) continue;

        const targetDir = CANONICAL_INBOX[this.lane];
        const targetPath = path.join(targetDir, ent.name);

        if (!this.dryRun) {
          try {
            if (!fs.existsSync(targetDir)) {
              fs.mkdirSync(targetDir, { recursive: true });
            }
            fs.writeFileSync(targetPath, JSON.stringify(msg, null, 2), 'utf8');
            fs.unlinkSync(filePath);
            results.collected++;
            results.details.push({ file: ent.name, from: otherLane, to: this.lane, target: targetPath });
          } catch (err) {
            results.errors.push({ file: ent.name, error: err.message });
          }
        } else {
          results.details.push({ file: ent.name, from: otherLane, to: this.lane, target: targetPath, dry_run: true });
        }
      }
    }

    return results;
  }

  collectCrossLaneInbox() {
    const otherLanes = Object.keys(CANONICAL_INBOX).filter(l => l !== this.lane);
    const results = { collected: 0, errors: [], details: [] };

    for (const otherLane of otherLanes) {
      const crossInbox = path.join(LANE_ROOTS[otherLane], 'lanes', this.lane, 'inbox');
      if (!fs.existsSync(crossInbox)) continue;

      const entries = fs.readdirSync(crossInbox, { withFileTypes: true });
      const jsonFiles = entries.filter(e => {
        if (!e.isFile() || !e.name.endsWith('.json')) return false;
        const lower = e.name.toLowerCase();
        return !lower.startsWith('heartbeat');
      });

      for (const ent of jsonFiles) {
        const filePath = path.join(crossInbox, ent.name);
        const targetDir = CANONICAL_INBOX[this.lane];
        const targetPath = path.join(targetDir, ent.name);

        if (!this.dryRun) {
          try {
            if (!fs.existsSync(targetDir)) {
              fs.mkdirSync(targetDir, { recursive: true });
            }
            fs.writeFileSync(targetPath, JSON.stringify(safeReadJson(filePath).value || {}, null, 2), 'utf8');
            fs.unlinkSync(filePath);
            results.collected++;
            results.details.push({ file: ent.name, from: otherLane + '/lanes/' + this.lane + '/inbox', to: this.lane, target: targetPath });
          } catch (err) {
            results.errors.push({ file: ent.name, error: err.message });
          }
        } else {
          results.details.push({ file: ent.name, from: otherLane + '/lanes/' + this.lane + '/inbox', to: this.lane, dry_run: true });
        }
      }
    }

    return results;
  }

  runOnce() {
    const outbound = this.deliverOutbox();
    const incoming = this.collectIncoming();
    const crossInbox = this.collectCrossLaneInbox();

    return {
      lane: this.lane,
      dry_run: this.dryRun,
      timestamp: nowIso(),
      outbound,
      incoming,
      cross_inbox: crossInbox,
    };
  }
}

async function runCli() {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = path.resolve(__dirname, '..');
  const lane = args.lane || guessLane(repoRoot);
  const daemon = new RelayDaemon({
    repoRoot,
    lane,
    dryRun: !args.apply,
  });

  const result = daemon.runOnce();
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`[relay-daemon] lane=${result.lane} dry_run=${result.dry_run}`);
    console.log(`  outbound: scanned=${result.outbound.scanned} delivered=${result.outbound.delivered}`);
    if (result.outbound.errors.length > 0) {
      for (const e of result.outbound.errors) console.log(`    ERROR: ${e.file}: ${e.error}`);
    }
    console.log(`  incoming: collected=${result.incoming.collected}`);
    console.log(`  cross_inbox: collected=${result.cross_inbox.collected}`);
    if (result.incoming.errors.length > 0 || result.cross_inbox.errors.length > 0) {
      for (const e of [...result.incoming.errors, ...result.cross_inbox.errors]) console.log(`    ERROR: ${e.file}: ${e.error}`);
    }
  }
}

if (require.main === module) {
  runCli().catch(err => { console.error(`[relay-daemon] FATAL: ${err.message}`); process.exit(1); });
}

module.exports = { RelayDaemon, CANONICAL_INBOX, LANE_ROOTS };
