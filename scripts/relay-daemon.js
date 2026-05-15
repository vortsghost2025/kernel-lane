#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const { LaneDiscovery } = require('./util/lane-discovery');
const { ClaimCommitGuard } = require('./claim-commit-guard');
const { ContradictionAdjudicator } = require('./contradiction-adjudicator');
const discovery = new LaneDiscovery();

function runStoreJournalAppend(laneRoot, lane, event, subject, taskId) {
  var scriptPath = path.join(laneRoot, 'scripts', 'store-journal.js');
  if (!fs.existsSync(scriptPath)) return;
  try {
    var execSync = require('child_process').execSync;
    var agent = (process.env.AGENT_INSTANCE_ID || 'relay-daemon');
    var safeSubject = String(subject || 'unknown').replace(/"/g, '').slice(0, 80);
    var safeTaskId = String(taskId || 'unknown').replace(/"/g, '').slice(0, 60);
    execSync('node "' + scriptPath + '" append --lane ' + lane +
      ' --event ' + event +
      ' --agent "' + agent + '"' +
      ' --subject "' + safeSubject + '"' +
      ' --task_id "' + safeTaskId + '"', { cwd: laneRoot, timeout: 10000 });
  } catch (e) {}
}
const ALL_LANES = ['archivist', 'library', 'swarmmind', 'kernel'];
const claimGuard = new ClaimCommitGuard({ repoRoot: path.resolve(__dirname, '..') });

function getInboxDir(laneId) { return discovery.getInbox(laneId); }
function getOutboxDir(laneId) { return discovery.getOutbox(laneId); }
function getLaneRoot(laneId) { return discovery.getLocalPath(laneId); }

const LANE_ROOTS = {};
ALL_LANES.forEach(laneId => { LANE_ROOTS[laneId] = discovery.getLocalPath(laneId); });

function nowIso() { return new Date().toISOString(); }

function parseArgs(argv) {
  const out = { lane: null, apply: false, watch: false, pollSeconds: 20, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--lane' && argv[i + 1]) { out.lane = String(argv[i + 1]).toLowerCase(); i++; continue; }
    if (a === '--apply') { out.apply = true; continue; }
    if (a === '--watch') { out.watch = true; continue; }
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
    this.tickCount = 0;
    this.adjudicatorInterval = options.adjudicatorInterval || 50;
    this.adjudicatorLogDir = path.join(this.repoRoot, 'logs');
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
      let targetLanes;
      if (msg.to === 'all' || msg.to === 'broadcast') {
        targetLanes = ALL_LANES.filter(l => l !== this.lane);
      } else if (msg.to && ALL_LANES.includes(msg.to)) {
        targetLanes = [msg.to];
      } else {
        results.errors.push({ file: ent.name, error: `Unknown target lane: ${msg.to}` });
        continue;
      }

      const claimCheck = claimGuard.checkOutboxMessage(msg, this.repoRoot, this.outboxDir);
      if (!claimCheck.allowed) {
        const uncommitted = claimCheck.details
          .filter(d => d.status === 'uncommitted' || d.status === 'missing')
          .map(d => d.path);
        results.errors.push({ file: ent.name, error: `premature_claim: ${uncommitted.join(', ')}`, claim_guard: claimCheck });
        continue;
      }

      let allDelivered = true;
      for (const targetLane of targetLanes) {
        const targetDir = getInboxDir(targetLane);
        const targetPath = path.join(targetDir, ent.name);

        if (!this.dryRun) {
          try {
            if (!fs.existsSync(targetDir)) {
              fs.mkdirSync(targetDir, { recursive: true });
            }
            fs.writeFileSync(targetPath, JSON.stringify(msg, null, 2), 'utf8');
            results.delivered++;
            results.details.push({ file: ent.name, from: this.lane, to: targetLane, target: targetPath });
            runStoreJournalAppend(this.repoRoot, this.lane, 'message_delivered', msg.subject || msg.task_id, msg.task_id);
          } catch (err) {
            results.errors.push({ file: ent.name, error: `${targetLane}: ${err.message}` });
            allDelivered = false;
          }
        } else {
          results.details.push({ file: ent.name, from: this.lane, to: targetLane, target: targetPath, dry_run: true });
        }
      }

      if (!this.dryRun && allDelivered) {
        try {
          const deliveredDir = path.join(this.outboxDir, 'delivered');
          if (!fs.existsSync(deliveredDir)) fs.mkdirSync(deliveredDir, { recursive: true });
          const archivePath = path.join(deliveredDir, ent.name);
          fs.renameSync(filePath, archivePath);
        } catch (err) {
          fs.unlinkSync(filePath);
        }
      }
    }

    return results;
  }

  collectIncoming() {
    const otherLanes = ALL_LANES.filter(l => l !== this.lane);
    const results = { collected: 0, errors: [], details: [] };

    for (const otherLane of otherLanes) {
      const otherOutbox = getOutboxDir(otherLane);
      if (!fs.existsSync(otherOutbox)) continue;

      const entries = fs.readdirSync(otherOutbox, { withFileTypes: true });
      const jsonFiles = entries.filter(e => e.isFile() && e.name.endsWith('.json'));

      for (const ent of jsonFiles) {
        const filePath = path.join(otherOutbox, ent.name);
        const read = safeReadJson(filePath);
        if (!read.ok) continue;

        const msg = read.value;
      if (msg.to !== this.lane) continue;

      const targetDir = getInboxDir(this.lane);
    const targetPath = path.join(targetDir, ent.name);

    if (!this.dryRun) {
      try {
        if (fs.existsSync(targetPath)) {
          fs.unlinkSync(filePath);
          results.collected++;
          results.details.push({ file: ent.name, from: otherLane, to: this.lane, target: targetPath, skipped: 'already_exists' });
          continue;
        }
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
    const otherLanes = ALL_LANES.filter(l => l !== this.lane);
    const results = { collected: 0, errors: [], details: [] };

    for (const otherLane of otherLanes) {
      const crossInbox = path.join(getLaneRoot(otherLane), 'lanes', this.lane, 'inbox');
      if (!fs.existsSync(crossInbox)) continue;

      const entries = fs.readdirSync(crossInbox, { withFileTypes: true });
      const jsonFiles = entries.filter(e => {
        if (!e.isFile() || !e.name.endsWith('.json')) return false;
        const lower = e.name.toLowerCase();
        return !lower.startsWith('heartbeat');
      });

      for (const ent of jsonFiles) {
        const filePath = path.join(crossInbox, ent.name);
      const targetDir = getInboxDir(this.lane);
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
    this.tickCount++;
    const outbound = this.deliverOutbox();
    const incoming = this.collectIncoming();
    const crossInbox = this.collectCrossLaneInbox();

    let adjudication = null;
    if (this.tickCount % this.adjudicatorInterval === 0) {
      try {
        const adjudicator = new ContradictionAdjudicator({
          repoRoot: this.repoRoot,
          dryRun: this.dryRun,
        });
        adjudication = adjudicator.run();
        if (!this.dryRun && adjudication) {
          if (!fs.existsSync(this.adjudicatorLogDir)) {
            fs.mkdirSync(this.adjudicatorLogDir, { recursive: true });
          }
          const logPath = path.join(this.adjudicatorLogDir, 'contradiction-adjudicator.json');
          fs.writeFileSync(logPath, JSON.stringify(adjudication, null, 2), 'utf8');
        }
      } catch (err) {
        adjudication = { error: err.message };
      }
    }

    return {
      lane: this.lane,
      dry_run: this.dryRun,
      tick: this.tickCount,
      timestamp: nowIso(),
      outbound,
      incoming,
      cross_inbox: crossInbox,
      adjudication,
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

  if (args.watch) {
    console.log(`[relay-daemon] lane=${lane} watching every ${args.pollSeconds}s`);
    const tick = () => {
      try {
        const result = daemon.runOnce();
        const out = result.outbound;
        const inc = result.incoming;
        const cx = result.cross_inbox;
          if (out.delivered > 0 || inc.collected > 0 || cx.collected > 0) {
            console.log(`[relay-daemon] lane=${lane} tick=${result.tick} outbound: delivered=${out.delivered} incoming: collected=${inc.collected} cross_inbox: collected=${cx.collected}`);
          }
          if (result.adjudication) {
            const adj = result.adjudication;
            const stats = adj.stats || {};
            console.log(`[relay-daemon] adjudication: edges=${stats.total_edges || 0} contradicts=${stats.contradicts_edges || 0} adjudicated=${stats.adjudicated || 0}${adj.error ? ' ERROR=' + adj.error : ''}`);
          }
      } catch (err) {
        console.error(`[relay-daemon] tick error: ${err.message}`);
      }
    };
    tick();
    setInterval(tick, args.pollSeconds * 1000);
  } else {
    const result = daemon.runOnce();
    if (args.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`[relay-daemon] lane=${result.lane} dry_run=${result.dry_run}`);
      console.log(` outbound: scanned=${result.outbound.scanned} delivered=${result.outbound.delivered}`);
      if (result.outbound.errors.length > 0) {
        for (const e of result.outbound.errors) console.log(` ERROR: ${e.file}: ${e.error}`);
      }
      console.log(` incoming: collected=${result.incoming.collected}`);
      console.log(` cross_inbox: collected=${result.cross_inbox.collected}`);
      if (result.incoming.errors.length > 0 || result.cross_inbox.errors.length > 0) {
        for (const e of [...result.incoming.errors, ...result.cross_inbox.errors]) console.log(` ERROR: ${e.file}: ${e.error}`);
      }
    }
  }
}

if (require.main === module) {
  runCli().catch(err => { console.error(`[relay-daemon] FATAL: ${err.message}`); process.exit(1); });
}

// TaskChainEngine is NOT embedded in relay-daemon because it is a full inbox
// processor that competes with lane-worker's own processing. Run it as a
// standalone CLI from runner-v3.sh or a systemd timer instead:
//   node scripts/task-chain-engine.js --lane <lane> --apply
//   node scripts/task-chain-engine.js --lane archivist --apply --max-chain-depth 5

module.exports = { RelayDaemon, ALL_LANES };
