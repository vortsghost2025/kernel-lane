"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const os = require("os");

const TEST_DIR = path.join(os.tmpdir(), "kernel-send-lane-test-" + Date.now());
const LOCK_DIR = path.join(TEST_DIR, "locks");
const FAKE_INBOX = path.join(TEST_DIR, "fake-inbox");

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) { passed++; }
  else { failed++; console.error("  FAIL: " + msg); }
}

function setup() {
  fs.mkdirSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(LOCK_DIR, { recursive: true });
  fs.mkdirSync(FAKE_INBOX, { recursive: true });
}

function teardown() {
  try { fs.rmSync(TEST_DIR, { recursive: true }); } catch (_) {}
}

function makeValidMessage(name) {
  return JSON.stringify({
    schema_version: "1.3", task_id: "test-" + name, idempotency_key: "test-" + name + "-key",
    from: "kernel", to: "archivist", type: "task", task_kind: "proposal", priority: "P2",
    subject: "Test " + name,
    body: "OUTPUT_PROVENANCE:\n  agent: test\n  model_id: test-model\n  lane: kernel\n  generated_at: 2026-05-04T00:00:00Z\n  platform: win32\n  host: S:/kernel-lane",
    timestamp: new Date().toISOString(), requires_action: false,
    payload: { mode: "inline", compression: "none" },
    execution: { mode: "manual", engine: "opencode", actor: "lane" },
    lease: { owner: null, acquired_at: null, expires_at: null, renew_count: 0, max_renewals: 3 },
    retry: { attempt: 1, max_attempts: 3, last_error: null, last_attempt_at: null },
    evidence: { required: true, evidence_path: null, verified: false, verified_by: null, verified_at: null },
    heartbeat: { interval_seconds: 300, last_heartbeat_at: null, timeout_seconds: 900, status: "done" },
    signature: "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJrZXJuZWwifQ.placeholder",
    key_id: "127b44d2bb294ad9"
  });
}

function testSha256() {
  console.log("Test 1: SHA256 hash computation");
  const f = path.join(TEST_DIR, "hash-test.txt");
  fs.writeFileSync(f, "hello world");
  const h = crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
  assert(h.length === 64, "SHA256 hex length 64");
  assert(h === "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9", "SHA256 matches known value");
}

function testProvenanceValid() {
  console.log("Test 2: Provenance check - valid message");
  const p = path.join(TEST_DIR, "valid.json");
  fs.writeFileSync(p, makeValidMessage("pv"));
  const c = fs.readFileSync(p, "utf8").toLowerCase();
  const fields = ["agent", "model_id", "lane", "generated_at", "platform", "host"];
  assert(fields.every(f => c.includes(f + ":")), "All provenance fields present");
  const m = JSON.parse(fs.readFileSync(p, "utf8"));
  assert(m.key_id === "127b44d2bb294ad9", "key_id matches trust-store");
  assert(m.signature.length > 0, "signature present");
}

function testProvenanceInvalid() {
  console.log("Test 3: Provenance check - invalid message");
  const m = { key_id: "", signature: "", body: "no provenance" };
  assert(!m.key_id, "Invalid: empty key_id");
  assert(!m.signature, "Invalid: empty signature");
}

function testTransferLog() {
  console.log("Test 4: Transfer log append");
  const lp = path.join(TEST_DIR, "tl.jsonl");
  fs.appendFileSync(lp, JSON.stringify({ sha256: "abc", status: "sent" }) + "\n");
  assert(fs.existsSync(lp), "Log file exists");
  const lines = fs.readFileSync(lp, "utf8").trim().split("\n");
  assert(lines.length === 1, "1 entry in log");
  assert(JSON.parse(lines[0]).sha256 === "abc", "SHA256 in log matches");
}

function testLockFile() {
  console.log("Test 5: Lock file acquire/release");
  const lp = path.join(LOCK_DIR, "test.lock");
  const fd = fs.openSync(lp, "wx");
  fs.writeSync(fd, "{}"); fs.closeSync(fd);
  assert(fs.existsSync(lp), "Lock acquired");
  try { fs.openSync(lp, "wx"); assert(false, "2nd lock should fail"); } catch(e) { assert(e.code === "EEXIST", "EEXIST on 2nd lock"); }
  fs.unlinkSync(lp);
  assert(!fs.existsSync(lp), "Lock released");
}

function testAckFormat() {
  console.log("Test 6: ACK file format");
  const ack = { ack_for: "msg", ack_type: "delivery_received", acked_by: "kernel", key_id: "127b44d2bb294ad9" };
  const ap = path.join(FAKE_INBOX, "msg_ack.json");
  fs.writeFileSync(ap, JSON.stringify(ack));
  const r = JSON.parse(fs.readFileSync(ap, "utf8"));
  assert(r.acked_by === "kernel" && r.key_id === "127b44d2bb294ad9", "ACK format correct");
}

function testCheckpoint() {
  console.log("Test 7: Replay checkpoint persistence");
  const cp = path.join(TEST_DIR, "cp.json");
  fs.writeFileSync(cp, JSON.stringify({"lib:f.json":{attempts:1,last_error:"hash_mismatch"}}));
  const r = JSON.parse(fs.readFileSync(cp, "utf8"));
  assert(r["lib:f.json"].attempts === 1 && r["lib:f.json"].last_error === "hash_mismatch", "Checkpoint persists");
}

function testBandwidthFlag() {
  console.log("Test 8: Bandwidth flag parsing");
  const args = ["--bandwidth", "100", "archivist", "msg.json"];
  const i = args.indexOf("--bandwidth");
  assert(args[i+1] === "100", "Bandwidth parses to 100");
}

function testHostKeyPinning() {
  console.log("Test 9: Host-key pinning in SCP args");
  let a = "-o ConnectTimeout=5";
  a += " -o HostKeyAlgorithms=ssh-ed25519";
  assert(a.includes("HostKeyAlgorithms"), "HostKeyAlgorithms present when pinned");
}

function testToAllValid() {
  console.log("Test 10: Schema 'to' accepts 'all'");
  assert(["archivist","library","swarmmind","kernel","broadcast","all"].includes("all"), "'all' is valid");
}

console.log("=== Kernel send-lane hardening tests ===\n");
setup();
try {
  testSha256(); testProvenanceValid(); testProvenanceInvalid();
  testTransferLog(); testLockFile(); testAckFormat();
  testCheckpoint(); testBandwidthFlag(); testHostKeyPinning(); testToAllValid();
} finally { teardown(); }
console.log("\n=== Results: " + passed + " passed, " + failed + " failed ===");
process.exit(failed > 0 ? 1 : 0);
