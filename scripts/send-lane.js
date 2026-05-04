"use strict";

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const LANES = {
  archivist: {
    local: "S:/Archivist-Agent/lanes/archivist/inbox",
    remote: null,
    type: "local"
  },
  library: {
    local: null,
    remote: "we4free@100.95.40.99:/home/we4free/agent/repos/self-organizing-library/lanes/library/inbox",
    type: "scp"
  },
  swarmmind: {
    local: null,
    remote: "we4free@100.95.40.99:/home/we4free/agent/repos/SwarmMind/lanes/swarmmind/inbox",
    type: "scp"
  }
};

const REQUIRED_PROVENANCE_FIELDS = ["agent", "model_id", "lane", "generated_at", "platform", "host"];

function checkProvenance(filePath) {
  const content = fs.readFileSync(filePath, "utf8");
  const missing = [];
  for (const field of REQUIRED_PROVENANCE_FIELDS) {
    const re = new RegExp(`${field}:\\s*\\S+`, "i");
    if (!re.test(content)) {
      const jsonCheck = JSON.parse(content);
      if (!jsonCheck.signature && !jsonCheck.key_id) {
        missing.push(field);
      }
    }
  }
  const msg = JSON.parse(content);
  if (!msg.key_id || msg.key_id === "") missing.push("key_id (ratified)");
  if (!msg.signature || msg.signature === "") missing.push("signature");
  return { ok: missing.length === 0, missing };
}

function writeAck(targetInbox, sourceFile) {
  const base = path.basename(sourceFile, ".json");
  const ackPath = path.join(
    targetInbox.replace(/\/inbox.*/, "/inbox"),
    `${base}_ack.json`
  );
  const ack = {
    ack_for: base,
    ack_type: "delivery_received",
    acked_by: "kernel",
    acked_at: new Date().toISOString(),
    key_id: "127b44d2bb294ad9"
  };

  if (targetInbox.startsWith("S:/") || targetInbox.startsWith("/mnt/")) {
    fs.writeFileSync(ackPath, JSON.stringify(ack, null, 2));
  } else {
    const tmpAck = path.join(require("os").tmpdir(), `${base}_ack.json`);
    fs.writeFileSync(tmpAck, JSON.stringify(ack, null, 2));
    try {
      execSync(`scp -o ConnectTimeout=5 "${tmpAck}" "${targetInbox}/"`, { stdio: "pipe" });
    } finally {
      fs.unlinkSync(tmpAck);
    }
  }
  return ackPath;
}

function deliver(laneName, filePath) {
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

  const prov = checkProvenance(resolved);
  if (!prov.ok) {
    console.error(`PROVENANCE CHECK FAILED. Missing: ${prov.missing.join(", ")}`);
    console.error("Fix before sending. Use --skip-provenance to override (not recommended).");
    process.exit(1);
  }

  if (lane.type === "local") {
    const dest = path.join(lane.local, path.basename(resolved));
    fs.copyFileSync(resolved, dest);
    console.log(`[send] ${laneName}: ${dest}`);
  } else {
    execSync(`scp -o ConnectTimeout=5 "${resolved}" "${lane.remote}/"`, { stdio: "inherit" });
    console.log(`[send] ${laneName}: scp -> ${lane.remote}`);
  }

  const inboxPath = lane.type === "local" ? lane.local : lane.remote;
  writeAck(inboxPath, resolved);

  const outboxCopy = path.join("S:/kernel-lane/lanes/kernel/outbox", path.basename(resolved));
  fs.copyFileSync(resolved, outboxCopy);

  console.log(`[send] Complete. ACK written. Outbox copy: ${outboxCopy}`);
}

function main() {
  const args = process.argv.slice(2);
  const skipProv = args.includes("--skip-provenance");
  if (skipProv) args.splice(args.indexOf("--skip-provenance"), 1);

  const [laneName, filePath] = args;
  if (!laneName || !filePath) {
    console.log("Usage: node scripts/send-lane.js <archivist|library|swarmmind> <message.json>");
    console.log("       node scripts/send-lane.js --all <message.json>");
    console.log("       node scripts/send-lane.js --skip-provenance <lane> <message.json>");
    process.exit(2);
  }

  if (laneName === "--all") {
    for (const lane of Object.keys(LANES)) {
      deliver(lane, filePath);
    }
  } else {
    deliver(laneName, filePath);
  }
}

if (require.main === module) main();
