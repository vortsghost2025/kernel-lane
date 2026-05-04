"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execSync } = require("child_process");
const os = require("os");

const LANES = {
  archivist: {
    local: "S:/Archivist-Agent/lanes/archivist/inbox",
    remote: null,
    type: "local"
  },
  library: {
    local: null,
    remote: "we4free@100.95.40.99:/home/we4free/agent/repos/self-organizing-library/lanes/library/inbox",
    type: "scp",
    host_key: "SHA256:lKHs/aqPAjZ2NSJUvdWmoKmewfVC7NjyhHxXbI3kymw"
  },
  swarmmind: {
    local: null,
    remote: "we4free@100.95.40.99:/home/we4free/agent/repos/SwarmMind/lanes/swarmmind/inbox",
    type: "scp",
    host_key: "SHA256:lKHs/aqPAjZ2NSJUvdWmoKmewfVC7NjyhHxXbI3kymw"
  }
};

const TRANSFER_LOG = "S:/kernel-lane/lanes/kernel/state/transfer_log.jsonl";
const LOCK_DIR = "S:/kernel-lane/lanes/kernel/state/locks";
const REQUIRED_PROVENANCE_FIELDS = ["agent", "model_id", "lane", "generated_at", "platform", "host"];

function sha256File(filePath) {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function appendTransferLog(entry) {
  const dir = path.dirname(TRANSFER_LOG);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(TRANSFER_LOG, JSON.stringify(entry) + "\n");
}

function acquireLock(name) {
  if (!fs.existsSync(LOCK_DIR)) fs.mkdirSync(LOCK_DIR, { recursive: true });
  const lockPath = path.join(LOCK_DIR, `${name}.lock`);
  const maxWait = 30000;
  const interval = 200;
  let waited = 0;

  while (waited < maxWait) {
    try {
      const fd = fs.openSync(lockPath, "wx");
      fs.writeSync(fd, JSON.stringify({
        pid: process.pid,
        acquired_at: new Date().toISOString(),
        host: os.hostname()
      }));
      fs.closeSync(fd);
      return lockPath;
    } catch (e) {
      if (e.code === "EEXIST") {
        const stat = fs.statSync(lockPath);
        const age = Date.now() - stat.mtimeMs;
        if (age > 120000) {
          fs.unlinkSync(lockPath);
          continue;
        }
        const now = Date.now();
        if (now - stat.mtimeMs > 60000) {
          try { fs.unlinkSync(lockPath); } catch (_) {}
          continue;
        }
      } else {
        throw e;
      }
    }
    execSync(`timeout /t 1 /nobreak >nul 2>&1 || sleep 1`, { stdio: "pipe", shell: true });
    waited += interval;
  }
  throw new Error(`Lock acquisition timeout for ${name} after ${maxWait}ms`);
}

function releaseLock(lockPath) {
  try { fs.unlinkSync(lockPath); } catch (_) {}
}

function checkProvenance(filePath) {
  const content = fs.readFileSync(filePath, "utf8");
  const missing = [];
  let msg;
  try { msg = JSON.parse(content); } catch { return { ok: false, missing: ["valid_json"] }; }

  if (!msg.key_id || msg.key_id === "") missing.push("key_id (ratified)");
  if (!msg.signature || msg.signature === "") missing.push("signature");

  const body = content.toLowerCase();
  for (const field of REQUIRED_PROVENANCE_FIELDS) {
    if (!body.includes(`${field.toLowerCase()}:`)) missing.push(field);
  }
  return { ok: missing.length === 0, missing };
}

function verifyRemoteHash(scpTarget, localFile, expectedHash) {
  const remoteCheck = `ssh -o ConnectTimeout=5 ${scpTarget.split(":")[0]} "sha256sum '${scpTarget.split(":")[1]}/${path.basename(localFile)}'" 2>&1`;
  try {
    const result = execSync(remoteCheck, { encoding: "utf8", timeout: 15000 });
    const remoteHash = result.split(" ")[0];
    return remoteHash === expectedHash;
  } catch (e) {
    return null;
  }
}

function writeAck(targetInbox, sourceFile) {
  const base = path.basename(sourceFile, ".json");
  const ack = {
    ack_for: base,
    ack_type: "delivery_received",
    acked_by: "kernel",
    acked_at: new Date().toISOString(),
    key_id: "127b44d2bb294ad9"
  };

  if (targetInbox.startsWith("S:/") || targetInbox.startsWith("/mnt/")) {
    const ackPath = path.join(targetInbox, `${base}_ack.json`);
    fs.writeFileSync(ackPath, JSON.stringify(ack, null, 2));
  } else {
    const tmpAck = path.join(os.tmpdir(), `${base}_ack.json`);
    fs.writeFileSync(tmpAck, JSON.stringify(ack, null, 2));
    try {
      execSync(`scp -o ConnectTimeout=5 "${tmpAck}" "${targetInbox}/"`, { stdio: "pipe" });
    } finally {
      try { fs.unlinkSync(tmpAck); } catch (_) {}
    }
  }
}

function deliver(laneName, filePath, options = {}) {
  const lane = LANES[laneName];
  if (!lane) {
    console.error(`Unknown lane: ${laneName}. Valid: ${Object.keys(LANES).join(", ")}`);
    process.exit(1);
  }

  const resolved = path.resolve(process.cwd(), filePath);
  if (!fs.existsSync(resolved)) {
    console.error(`File not found: ${resolved}`);
    process.exit(1);
  }

  if (!options.skipProvenance) {
    const prov = checkProvenance(resolved);
    if (!prov.ok) {
      console.error(`PROVENANCE CHECK FAILED. Missing: ${prov.missing.join(", ")}`);
      console.error("Fix before sending. Use --skip-provenance to override.");
      process.exit(1);
    }
  }

  const lock = acquireLock(`send-${laneName}`);
  try {
    const fileHash = sha256File(resolved);
    const fileSize = fs.statSync(resolved).size;
    const startTime = Date.now();

    let scpArgs = `-o ConnectTimeout=5 -o StrictHostKeyChecking=accept-new`;
    if (lane.host_key && lane.host_key !== "SHA256:placeholder") {
      scpArgs += ` -o HostKeyAlgorithms=ssh-ed25519 -o HostKeyAlias=${laneName}`;
    }
    if (options.bandwidth) {
      scpArgs += ` -l ${options.bandwidth}`;
    }

    let deliveryStatus = "sent";
    let verifyResult = null;

    if (lane.type === "local") {
      const dest = path.join(lane.local, path.basename(resolved));
      fs.copyFileSync(resolved, dest);
      console.log(`[send] ${laneName}: ${dest}`);
    } else {
      execSync(`scp ${scpArgs} "${resolved}" "${lane.remote}/"`, { stdio: "inherit" });
      console.log(`[send] ${laneName}: scp -> ${lane.remote}`);

      verifyResult = verifyRemoteHash(lane.remote, resolved, fileHash);
      if (verifyResult === false) {
        deliveryStatus = "hash_mismatch";
        console.error(`[send] WARNING: Remote hash mismatch for ${laneName}!`);
      } else if (verifyResult === null) {
        deliveryStatus = "sent_unverified";
        console.log(`[send] ${laneName}: hash verification unavailable`);
      } else {
        deliveryStatus = "verified";
        console.log(`[send] ${laneName}: hash verified OK`);
      }
    }

    const elapsed = Date.now() - startTime;
    const inboxPath = lane.type === "local" ? lane.local : lane.remote;
    writeAck(inboxPath, resolved);

    const outboxCopy = path.join("S:/kernel-lane/lanes/kernel/outbox", path.basename(resolved));
    fs.copyFileSync(resolved, outboxCopy);

    appendTransferLog({
      timestamp: new Date().toISOString(),
      from: "kernel",
      to: laneName,
      file: path.basename(resolved),
      sha256: fileHash,
      size: fileSize,
      status: deliveryStatus,
      elapsed_ms: elapsed,
      method: lane.type,
      key_id: "127b44d2bb294ad9"
    });

    console.log(`[send] Complete. ${deliveryStatus}. ${elapsed}ms. Outbox: ${outboxCopy}`);
  } finally {
    releaseLock(lock);
  }
}

function main() {
  const args = process.argv.slice(2);
  const skipProv = args.includes("--skip-provenance");
  if (skipProv) args.splice(args.indexOf("--skip-provenance"), 1);

  const bwIdx = args.indexOf("--bandwidth");
  const bandwidth = bwIdx !== -1 ? args[bwIdx + 1] : null;
  if (bwIdx !== -1) { args.splice(bwIdx, 2); }

  const [laneName, filePath] = args;
  if (!laneName || !filePath) {
    console.log("Usage: node scripts/send-lane.js <lane|--all> <message.json>");
    console.log("  Options:");
    console.log("    --skip-provenance    Skip provenance check (not recommended)");
    console.log("    --bandwidth <kbps>   Throttle SCP bandwidth");
    console.log("  Lanes: " + Object.keys(LANES).join(", "));
    process.exit(2);
  }

  const options = { skipProvenance, bandwidth };

  if (laneName === "--all") {
    for (const lane of Object.keys(LANES)) {
      deliver(lane, filePath, options);
    }
  } else {
    deliver(laneName, filePath, options);
  }
}

if (require.main === module) main();
