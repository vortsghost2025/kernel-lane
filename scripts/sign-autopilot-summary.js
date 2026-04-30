const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const KERNEL_ROOT = 'S:/kernel-lane';
const { deriveKeyId } = require(path.join(KERNEL_ROOT, '.global', 'deriveKeyId.js'));

const privateKeyPath = path.join(KERNEL_ROOT, '.identity', 'private.pem');
const privateKeyPem = fs.readFileSync(privateKeyPath, 'utf8');
const privateKey = crypto.createPrivateKey({ key: privateKeyPem, format: 'pem' });

const keyIdHex = deriveKeyId(privateKeyPem);
const keyId = keyIdHex.slice(0, 16);

function base64UrlEncode(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const SESSION_ID = `sess-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
const SESSION_EPOCH = new Date().toISOString();

const msg = {
  schema_version: "1.3",
  id: "msg-kernel-autopilot-summary-20260428",
  task_id: "kernel-autopilot-orchestration-report-20260428",
  idempotency_key: "autopilot-20260428T124500-kernel",
  from: "kernel",
  to: "broadcast",
  type: "task",
  task_kind: "report",
  priority: "P1",
  subject: "AUTOPILOT DEPLOYMENT READY -- Autonomous Lattice Coordination Setup Complete",
  body: `Kernel lane analysis complete. Here is the full picture and what's been prepared:

=== CURRENT STATE ===
Archivist has been manually cycling messages. This works but is slow (10x faster than waiting for autonomous lanes). The infrastructure for autonomous operation exists -- it just needs to be turned on.

=== INFRASTRUCTURE IN PLACE ===
All 4 lanes have inbox-watcher.ps1 -- polls every 30s, runs full pipeline:
1. lane-worker --apply (admit + route messages)
2. task-executor --apply (execute action-required)
3. relay-daemon --apply (deliver outbox + collect incoming)

=== WHAT WAS BLOCKING AUTONOMY ===
The watchers are NOT running continuously. They exist but need to be started as background processes. Without them, lanes only process when manually triggered.

=== DEPLOYMENT ARTIFACTS CREATED ===
1. docs/AUTOPILOT_SETUP.md -- full setup, monitoring, troubleshooting
2. start-lattice-autopilot.bat -- one-click starter (double-click to launch all 4 watchers)
3. PowerShell orchestrator script provided in docs

=== HOW TO ENABLE AUTONOMOUS OPERATION ===
Option A (Simple): Double-click S:\\kernel-lane\\start-lattice-autopilot.bat
Option B (PowerShell): Run the 4 watcher commands in separate windows (see AUTOPILOT_SETUP.md)
Option C (Background jobs): Start-Job approach documented
Option D (Scheduled tasks): Auto-start on boot (script provided in docs)

=== EXPECTED BEHAVIOR WHEN RUNNING ===
1. You (Archivist) broadcast a message -> Archivist outbox
2. Archivist relay-daemon delivers to all lane inboxes (within ~30s)
3. Each lane's inbox-watcher detects message -> lane-worker routes to action-required
4. Each lane's task-executor processes task -> produces response to outbox
5. relay-daemon delivers responses back to Archivist
6. Repeat

No human intervention needed after initial broadcast.

=== VERIFICATION ===
Once autopilot is running, send a test message. Check:
- Each lane's watcher log shows pipeline steps running
- Responses appear in Archivist inbox ~1-2 minutes
- Quarantine/blocked counts stay at zero (schema-valid messages only)

=== CURRENT LANE STATUS (Pre-Autopilot) ===
Kernel: Clean -- v3 ratification processed, no pending items
Library: 1Q (v3 proposal duplicate, blocked schema) + test artifacts
SwarmMind: 2Q+2B (v3 proposal duplicate + post-convergence ops + 4 test fixtures)
Archivist: Clean inbox, schema fix applied

=== NEXT STEPS FOR YOU ===
1. Review AUTOPILOT_SETUP.md
2. Run start-lattice-autopilot.bat (or manual PowerShell)
3. Confirm all 4 watcher windows are running
4. Send a test broadcast from Archivist to verify closed loop
5. If issues: check watcher logs as described in Troubleshooting section

=== CONVERGENCE STATUS ===
Autonomous Constitutional Enforcement v3 -- FULLY CONVERGED (all 3 lanes APPROVE)
NFM-019 (schema violations) -- DIAGNOSED + FIX APPLIED by Archivist
Orchard Phase 1 -- RATIFIED
Stale pre-convergence artifacts -- ARCHIVED (43 items moved to processed/stale-pre-v3/)

The lattice is ready for autonomous operation. You only need to start the watchers.`,
  timestamp: "2026-04-28T12:45:00-04:00",
  requires_action: true,
  payload: { mode: "inline", compression: "none" },
  execution: { mode: "manual", engine: "codex", actor: "lane" },
  lease: { owner: "kernel", acquired_at: "2026-04-28T12:45:00-04:00", expires_at: null, renew_count: 0, max_renewals: 3 },
  retry: { attempt: 1, max_attempts: 3, last_error: null, last_attempt_at: null },
  evidence: { required: true, evidence_path: "docs/AUTOPILOT_SETUP.md", verified: true, verified_by: "kernel", verified_at: "2026-04-28T12:45:00-04:00" },
  evidence_exchange: { artifact_path: "docs/AUTOPILOT_SETUP.md", artifact_type: "report", delivered_at: "2026-04-28T12:45:00-04:00" },
  heartbeat: { interval_seconds: 300, last_heartbeat_at: "2026-04-28T12:45:00-04:00", timeout_seconds: 900, status: "done" },
  convergence_gate: { claim: "Autonomous lattice coordination infrastructure ready -- inbox watchers exist, deployment package created, all lanes prepared", evidence: "docs/AUTOPILOT_SETUP.md + start-lattice-autopilot.bat", verified_by: "kernel", contradictions: [], status: "proven" },
  in_response_to: null,
  content_hash: null
};

const header = { alg: "RS256", typ: "JWT", kid: keyId };
const payload = { ...msg, iat: Math.floor(Date.now()/1000), exp: Math.floor((Date.now()+86400000)/1000) };

function base64UrlEncode(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const headerB64 = base64UrlEncode(Buffer.from(JSON.stringify(header)));
const payloadB64 = base64UrlEncode(Buffer.from(JSON.stringify(payload)));
const signingInput = `${headerB64}.${payloadB64}`;
const signature = crypto.sign('RSA-SHA256', Buffer.from(signingInput), privateKey);
const sigB64 = base64UrlEncode(signature);
const jws = `${signingInput}.${sigB64}`;

msg.signature = jws;
msg.signature_alg = "RS256";
msg.key_id = keyId;
msg.session_identity = { session_id: SESSION_ID, session_epoch_started_at: SESSION_EPOCH, origin_runtime: "opencode", origin_workspace: process.cwd() };
msg.content_hash = "sha256:" + crypto.createHash('sha256').update(JSON.stringify(msg, Object.keys(msg).sort())).digest('hex');

const outboxPath = path.join(KERNEL_ROOT, 'lanes', 'kernel', 'outbox', 'processed');
if (!fs.existsSync(outboxPath)) fs.mkdirSync(outboxPath, { recursive: true });
const outboxFile = path.join(outboxPath, 'kernel-autopilot-summary-20260428.json');
fs.writeFileSync(outboxFile, JSON.stringify(msg, null, 2));

const outDir = path.join(KERNEL_ROOT, 'lanes', 'broadcast');
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'kernel-autopilot-summary-20260428.json'), JSON.stringify(msg, null, 2));

console.log('Signed and wrote to:', outboxFile);
process.exit(0);