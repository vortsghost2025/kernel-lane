const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const KERNEL_ROOT = 'S:/kernel-lane';
const { deriveKeyId } = require(path.join(KERNEL_ROOT, '.global', 'deriveKeyId.js'));
const { atomicWriteWithLease } = require(path.join(KERNEL_ROOT, 'scripts', 'atomic-write-util'));

const privateKeyPath = path.join(KERNEL_ROOT, '.identity', 'private.pem');
const privateKeyPem = fs.readFileSync(privateKeyPath, 'utf8');
const privateKey = crypto.createPrivateKey({
  key: privateKeyPem,
  format: 'pem',
  password: null,
});

const SESSION_ID = process.env.SESSION_ID || `sess-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
const ORIGIN_RUNTIME = process.env.ORIGIN_RUNTIME || 'opencode';
const ORIGIN_WORKSPACE = process.env.ORIGIN_WORKSPACE || process.cwd();
const SESSION_EPOCH = new Date().toISOString();

const keyIdHex = deriveKeyId(privateKeyPem);
const keyId = keyIdHex.slice(0, 16);
const laneId = 'kernel';

function base64UrlEncode(buf) {
  return buf.toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function stableStringify(obj) {
  return JSON.stringify(obj, Object.keys(obj).sort());
}

const msg = {
  "schema_version": "1.3",
  "id": "msg-kernel-diagnostics-summary-20260428-104500",
  "task_id": "kernel-diagnostics-quarantine-analysis-20260428",
  "idempotency_key": "diag-quarantine-20260428T104500-kernel",
  "from": "kernel",
  "to": "archivist",
  "type": "task",
  "task_kind": "report",
  "priority": "P0",
  "subject": "DIAGNOSTICS SUMMARY: Quarantine/Blocked Root Cause — Archivist Schema Violations",
  "body": "Kernel lane diagnostics complete. Analyzed Library and SwarmMind quarantine/blocked states. Root cause identified: Archivist → other lanes messages failing schema validation with identical violations across all recipients.\n\n=== ROOT CAUSE ===\nArchivist lane is emitting messages with non-schema-compliant enum values and missing required fields. This causes Library and SwarmMind to quarantine incoming messages before processing.\n\n=== SPECIFIC SCHEMA VIOLATIONS ===\n1. Missing required fields: lease, retry\n2. execution.mode value \"constitutional\" — invalid\n3. execution.engine value \"governance\" — invalid\n4. heartbeat.status value \"active\" — invalid\n5. evidence_exchange.artifact_type value \"proposal\" — invalid\n\n=== AFFECTED MESSAGES ===\namended-autonomous-enforcement-v2-*.json, archivist-next-evolution-plan-20260428.json, kernel-four-lane-coordination-20260428.json\n\n=== LANE STATES ===\nKernel: 0Q/0B clean | Library: 11Q quarantining | SwarmMind: 17Q+7B quarantining/blocking\n\n=== FIX ===\nReplace in all Archivist message builders:\nexecution.mode: \"constitutional\" → \"manual\"\nexecution.engine: \"governance\" → \"opencode\"\nheartbeat.status: \"active\" → \"in_progress\"\nevidence_exchange.artifact_type: \"proposal\" → \"artifact\"\nAdd missing: lease + retry objects to all messages.\n\n=== CONTEXT ===\nNFM-019 (Schema–Behavior Mismatch) at source: constitutional coordinator violates v1.3 schema it governs.",
  "timestamp": "2026-04-28T10:45:00-04:00",
  "requires_action": true,
  "payload": { "mode": "inline", "compression": "none" },
  "execution": { "mode": "manual", "engine": "codex", "actor": "lane" },
  "lease": { "owner": "kernel", "acquired_at": "2026-04-28T10:45:00-04:00", "expires_at": null, "renew_count": 0, "max_renewals": 3 },
  "retry": { "attempt": 1, "max_attempts": 3, "last_error": null, "last_attempt_at": null },
  "evidence": { "required": true, "evidence_path": "lanes/kernel/outbox/processed/kernel-diagnostics-summary-20260428-104500.json", "verified": true, "verified_by": "kernel", "verified_at": "2026-04-28T10:45:00-04:00" },
  "evidence_exchange": { "artifact_path": "lanes/kernel/outbox/processed/kernel-diagnostics-summary-20260428-104500.json", "artifact_type": "report", "delivered_at": "2026-04-28T10:45:00-04:00" },
  "heartbeat": { "interval_seconds": 300, "last_heartbeat_at": "2026-04-28T10:45:00-04:00", "timeout_seconds": 900, "status": "done" },
  "convergence_gate": { "claim": "Archivist schema violations root cause identified", "evidence": "lane-worker logs Library/SwarmMind show SCHEMA_INVALID on Archivist messages", "verified_by": "kernel", "contradictions": [], "status": "proven" },
  "in_response_to": null,
  "content_hash": null
};

const header = {
  alg: "RS256",
  typ: "JWT",
  kid: keyId
};
const payload = {
  ...msg,
  iat: Math.floor(Date.now() / 1000),
  exp: Math.floor((Date.now() + 86400000) / 1000),
};

const headerB64 = base64UrlEncode(Buffer.from(JSON.stringify(header)));
const payloadB64 = base64UrlEncode(Buffer.from(JSON.stringify(payload)));
const signingInput = `${headerB64}.${payloadB64}`;
const signature = crypto.sign('RSA-SHA256', Buffer.from(signingInput), privateKey);
const signatureB64 = base64UrlEncode(signature);
const jws = `${signingInput}.${signatureB64}`;

msg.signature = jws;
msg.signature_alg = "RS256";
msg.key_id = keyId;
msg.session_identity = {
  session_id: SESSION_ID,
  session_epoch_started_at: SESSION_EPOCH,
  origin_runtime: ORIGIN_RUNTIME,
  origin_workspace: ORIGIN_WORKSPACE
};
msg.content_hash = "sha256:" + crypto.createHash('sha256').update(JSON.stringify(msg, Object.keys(msg).sort())).digest('hex');

const outboxPath = path.join(KERNEL_ROOT, 'lanes', laneId, 'outbox', 'processed');
if (!fs.existsSync(outboxPath)) fs.mkdirSync(outboxPath, { recursive: true });
const filePath = path.join(outboxPath, 'kernel-diagnostics-summary-20260428-104500.json');
fs.writeFileSync(filePath, JSON.stringify(msg, null, 2));
console.log('Wrote:', filePath);
process.exit(0);