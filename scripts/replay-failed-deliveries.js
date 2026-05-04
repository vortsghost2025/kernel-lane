"use strict";

const fs = require("fs");
const path = require("path");

const TRANSFER_LOG = "S:/kernel-lane/lanes/kernel/state/transfer_log.jsonl";
const REPLAY_CHECKPOINT = "S:/kernel-lane/lanes/kernel/state/replay-checkpoint.json";
const MAX_REPLAY_ATTEMPTS = 3;
const RETRY_DELAY_MS = 5000;

function readTransferLog() {
  if (!fs.existsSync(TRANSFER_LOG)) return [];
  const lines = fs.readFileSync(TRANSFER_LOG, "utf8").trim().split("\n");
  return lines.filter(l => l.trim()).map(l => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

function readCheckpoint() {
  if (!fs.existsSync(REPLAY_CHECKPOINT)) return {};
  try { return JSON.parse(fs.readFileSync(REPLAY_CHECKPOINT, "utf8")); }
  catch { return {}; }
}

function writeCheckpoint(data) {
  const dir = path.dirname(REPLAY_CHECKPOINT);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(REPLAY_CHECKPOINT, JSON.stringify(data, null, 2));
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function replayFailed() {
  const log = readTransferLog();
  const checkpoint = readCheckpoint();

  const failed = log.filter(entry =>
    entry.status === "hash_mismatch" ||
    entry.status === "sent_unverified" ||
    entry.status === "error"
  );

  if (failed.length === 0) {
    console.log("[replay] No failed transfers found in log.");
    return { replayed: 0, succeeded: 0, remaining: 0 };
  }

  console.log(`[replay] Found ${failed.length} failed/unverified transfers.`);

  let succeeded = 0;
  let remaining = 0;

  for (const entry of failed) {
    const key = `${entry.to}:${entry.file}`;
    const attempts = checkpoint[key]?.attempts || 0;

    if (attempts >= MAX_REPLAY_ATTEMPTS) {
      console.log(`[replay] SKIP ${key} — max attempts (${attempts}) reached`);
      remaining++;
      continue;
    }

    const outboxPath = path.join("S:/kernel-lane/lanes/kernel/outbox", entry.file);
    if (!fs.existsSync(outboxPath)) {
      console.log(`[replay] SKIP ${key} — file not in outbox: ${outboxPath}`);
      checkpoint[key] = { attempts: attempts + 1, last_error: "file_missing", last_attempt: new Date().toISOString() };
      continue;
    }

    console.log(`[replay] Attempt ${attempts + 1}/${MAX_REPLAY_ATTEMPTS}: ${key}`);
    checkpoint[key] = { attempts: attempts + 1, last_attempt: new Date().toISOString() };

    try {
      const { execSync } = require("child_process");
      const laneName = entry.to;
      const remoteMap = {
        library: "we4free@100.95.40.99:/home/we4free/agent/repos/self-organizing-library/lanes/library/inbox",
        swarmmind: "we4free@100.95.40.99:/home/we4free/agent/repos/SwarmMind/lanes/swarmmind/inbox"
      };

      if (laneName === "archivist") {
        const dest = path.join("S:/Archivist-Agent/lanes/archivist/inbox", entry.file);
        fs.copyFileSync(outboxPath, dest);
        console.log(`[replay] ${key}: local copy OK`);
        succeeded++;
        checkpoint[key].status = "replayed_ok";
      } else if (remoteMap[laneName]) {
        execSync(`scp -o ConnectTimeout=5 "${outboxPath}" "${remoteMap[laneName]}/"`, { stdio: "pipe" });
        console.log(`[replay] ${key}: SCP OK`);
        succeeded++;
        checkpoint[key].status = "replayed_ok";
      } else {
        console.log(`[replay] ${key}: unknown lane ${laneName}`);
        checkpoint[key].last_error = "unknown_lane";
        remaining++;
      }
    } catch (e) {
      console.error(`[replay] ${key}: FAILED — ${e.message}`);
      checkpoint[key].last_error = e.message;
      remaining++;
    }

    if (failed.indexOf(entry) < failed.length - 1) {
      await sleep(RETRY_DELAY_MS);
    }
  }

  writeCheckpoint(checkpoint);
  console.log(`[replay] Done. succeeded=${succeeded} remaining=${remaining}`);
  return { replayed: failed.length, succeeded, remaining };
}

function listFailed() {
  const log = readTransferLog();
  const failed = log.filter(e =>
    e.status === "hash_mismatch" || e.status === "sent_unverified" || e.status === "error"
  );
  if (failed.length === 0) {
    console.log("[replay] No failed transfers.");
    return;
  }
  console.log(`[replay] ${failed.length} failed/unverified transfers:`);
  for (const f of failed) {
    console.log(`  ${f.to}:${f.file} status=${f.status} sha256=${f.sha256?.slice(0, 12)}...`);
  }
}

async function main() {
  const cmd = process.argv[2] || "replay";

  if (cmd === "list") {
    listFailed();
  } else if (cmd === "replay") {
    await replayFailed();
  } else if (cmd === "reset") {
    writeCheckpoint({});
    console.log("[replay] Checkpoint reset.");
  } else {
    console.log("Usage: node scripts/replay-failed-deliveries.js [replay|list|reset]");
    console.log("  replay   Re-attempt failed deliveries (default)");
    console.log("  list     List failed deliveries without replaying");
    console.log("  reset    Clear replay checkpoint (allows re-attempting maxed-out entries)");
    process.exit(2);
  }
}

if (require.main === module) main();
