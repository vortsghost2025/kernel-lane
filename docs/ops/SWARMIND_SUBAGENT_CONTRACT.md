# SwarmMind Subagent Contract

**Version:** 1.0  
**Date:** 2026-04-26  
**Status:** Active  
**Applies to:** Any lane dispatching tasks to SwarmMind (or any lane running `generic-task-executor.js`)

---

## 1. Purpose

This document is the operational contract for treating SwarmMind as a bounded-execution subagent. It codifies what we learned the hard way so future lanes don't relearn these edges.

**The core pattern:** A parent lane dispatches a signed, schema-compliant task message → the target lane's `lane-worker` admits it → `generic-task-executor` executes it → a signed response is delivered back to the parent's inbox.

---

## 2. Message Schema

Every cross-lane task MUST include all required fields or it gets quarantined as `SCHEMA_INVALID`:

```json
{
  "id": "task-report-<timestamp><random>",
  "task_id": "task-report-<timestamp><random>",
  "idempotency_key": "report-<timestamp>",
  "from": "archivist",
  "to": "swarmmind",
  "timestamp": "2026-04-26T12:00:00.000Z",
  "priority": "P2",
  "type": "task",
  "subject": "Human-readable subject",
  "schema_version": "1.3",
  "task_kind": "<MUST be valid enum — see §3>",
  "requires_action": true,
  "body": "<execution instruction — see §4>",
  "execution": { "mode": "session_task", "engine": "opencode", "actor": "archivist" },
  "payload": { "mode": "inline", "compression": "none" },
  "lease": { "owner": "archivist", "acquired_at": "<ISO timestamp>" },
  "retry": { "attempt": 1, "max_attempts": 1 },
  "evidence": { "required": false, "verified": true, "artifact_type": "report" },
  "evidence_exchange": { "artifact_path": null, "artifact_type": "report", "delivered_at": null },
  "heartbeat": { "status": "pending", "last_heartbeat_at": "<ISO timestamp>", "interval_seconds": 300, "timeout_seconds": 900 }
}
```

### Required Fields Checklist

- [ ] `id` and `task_id` — must be unique, same value recommended
- [ ] `idempotency_key` — must be unique per dispatch
- [ ] `from` / `to` — valid lane names (archivist, kernel, library, swarmmind)
- [ ] `schema_version` — must be `"1.3"`
- [ ] `task_kind` — **MUST be a valid enum value (§3)** — this is the #1 cause of quarantine
- [ ] `type` — valid enum: task, response, heartbeat, escalation, handoff, ack, alert, notification, status
- [ ] `execution` — with mode, engine, actor
- [ ] `payload` — with mode and compression
- [ ] `lease` — with owner and acquired_at
- [ ] `retry` — with attempt and max_attempts
- [ ] `evidence` — with required, verified, artifact_type
- [ ] `evidence_exchange` — with artifact_path, artifact_type, delivered_at
- [ ] `heartbeat` — with status, last_heartbeat_at, interval_seconds, timeout_seconds

**Messages missing any field → quarantined. No exceptions.**

---

## 3. Allowed Verbs (task_kind Enum)

**`task_kind` has 12 valid values. "task" is NOT one of them.**

| task_kind | Purpose | Executor Behavior |
|-----------|---------|-------------------|
| `status` | Request lane status report | Returns inbox counts, trust store key_id, system_state |
| `report` | Request information / file read | Routes to file read or consistency check based on body |
| `review` | Request audit / consistency check | Runs cross-lane consistency check |
| `ack` | Acknowledgment (no action) | Returns acknowledged, no execution |
| `done` | Completion signal | No execution, logged |
| `proposal` | Propose a change | Acknowledged (no autonomous mutation) |
| `amendment` | Amend a proposal | Acknowledged |
| `ratification` | Ratify a decision | Acknowledged |
| `handoff` | Session handoff | Acknowledged |
| `alert` | Alert / warning | Acknowledged with priority escalation |
| `notification` | Informational | Acknowledged |
| `heartbeat` | Keepalive | Returns status |

**The trap we hit:** `task_kind: "task"` → `SCHEMA_INVALID` → quarantine. The word "task" is a valid `type` but NOT a valid `task_kind`. Use `report` or `status` for work requests.

---

## 4. Execution Verbs (Body Parsing)

The executor parses `msg.body` for instruction verbs. These are the supported commands:

### 4.1 Status Report
```
task_kind: "status"
body: "report status"  (or any body when task_kind=status)
```
Returns: inbox counts (processed, quarantine, blocked, action-required), trust store key_id, system_state.

### 4.2 File Read
```
task_kind: "report"
body: "read file lanes/broadcast/system_state.json"
body: "read file S:/SwarmMind/lanes/broadcast/trust-store.json"
body: "file: config/allowed_roots.json"
```
Returns: file contents (up to 50KB), or directory listing (up to 100 entries).

**Path resolution:**
- Relative paths resolved against the target lane's root (e.g., `S:/SwarmMind`)
- Absolute paths allowed if under any of the 4 lane roots
- Paths are normalized for Windows (backslashes → forward slashes) before comparison
- Paths outside all lane roots → rejected with error

### 4.3 Script Run
```
task_kind: "report"
body: "run script recovery-test-suite"
body: "run script cross-lane-consistency-check.js"
body: "script: heartbeat"
```
Returns: stdout (up to 50KB), exit code, and stderr on failure.

**Constraints:**
- Only scripts in the target lane's `scripts/` directory
- 30-second timeout
- 50KB max output
- CWD set to lane root

### 4.4 Consistency Check
```
task_kind: "review"
body: "consistency check"
body: "audit"
```
Returns: output of `cross-lane-consistency-check.js` (60s timeout, 100KB max).

### 4.5 Fallback (Ack)
Any `task_kind` or `body` not matching above → acknowledged, no execution, list of supported verbs returned.

---

## 5. Safety Limits

| Limit | Value | Rationale |
|-------|-------|-----------|
| File read max | 50 KB | Prevent context flooding |
| Directory listing max | 100 entries | Bounded enumeration |
| Script timeout | 30 seconds | Prevent hanging |
| Script output max | 50 KB | Bounded response |
| Consistency check timeout | 60 seconds | Longer script, still bounded |
| Consistency check output max | 100 KB | Large but bounded |
| Script scope | `scripts/*.js` only | No arbitrary command execution |
| Path scope | Lane roots only | No path traversal beyond S:/\{lane\} |
| Response evidence.required | `false` | Auto-executed tasks skip artifact resolution |
| Response artifact_path | `null` | No cross-lane artifact resolution needed |

### What the Executor CANNOT Do

- ❌ Write or modify files (read-only)
- ❌ Execute arbitrary commands (only `scripts/*.js`)
- ❌ Access paths outside the 4 lane roots
- ❌ Mutate governance documents
- ❌ Initiate cross-lane messages (only responds to sender)
- ❌ Run indefinitely (all operations timeout)

---

## 6. Dispatch Procedure

### From Archivist (or any parent lane) to SwarmMind:

```bash
# 1. Create the task message
node -e "
const { createSignedMessage } = require('./scripts/create-signed-message.js');
const fs = require('fs');
const ts = Date.now();
const task = {
  id: 'task-report-' + ts,
  task_id: 'task-report-' + ts,
  idempotency_key: 'report-' + ts,
  from: 'archivist',
  to: 'swarmmind',
  timestamp: new Date().toISOString(),
  priority: 'P2',
  type: 'task',
  subject: 'Read system state',
  schema_version: '1.3',
  task_kind: 'report',          // ← MUST be valid enum
  requires_action: true,
  body: 'read file lanes/broadcast/system_state.json',
  execution: { mode: 'session_task', engine: 'opencode', actor: 'archivist' },
  payload: { mode: 'inline', compression: 'none' },
  lease: { owner: 'archivist', acquired_at: new Date().toISOString() },
  retry: { attempt: 1, max_attempts: 1 },
  evidence: { required: false, verified: true, artifact_type: 'report' },
  evidence_exchange: { artifact_path: null, artifact_type: 'report', delivered_at: null },
  heartbeat: { status: 'pending', last_heartbeat_at: new Date().toISOString(), interval_seconds: 300, timeout_seconds: 900 },
};
const signed = createSignedMessage(task, 'archivist');
fs.writeFileSync('S:/SwarmMind/lanes/swarmmind/inbox/' + task.id + '.json', JSON.stringify(signed, null, 2));
console.log('Dispatched:', task.id);
"

# 2. Run the pipeline on the target lane
node S:/SwarmMind/scripts/lane-worker.js --lane swarmmind --apply
node S:/SwarmMind/scripts/generic-task-executor.js swarmmind --apply

# 3. Read the response from your inbox
# Response file: S:/Archivist-Agent/lanes/archivist/inbox/response-{task_id}.json
```

### Critical: `--apply` Flag

**Without `--apply`, both scripts run in `dry_run=true` — they report what they WOULD do but take no action.** Always include `--apply` for real execution.

---

## 7. Restart Procedure

After ANY change to these files, the inbox-watcher must be restarted:

### Files Requiring Restart
- `scripts/inbox-watcher.ps1`
- `scripts/lane-worker.js`
- `scripts/generic-task-executor.js`
- `scripts/identity-enforcer.js`
- `scripts/SchemaValidator.js`

### Restart Steps (Windows)

```powershell
# 1. Kill existing watcher processes
Get-Process -Name powershell | Where-Object {
  $_.CommandLine -match 'inbox-watcher'
} | Stop-Process -Force

# 2. End the scheduled task
schtasks /End /TN "SwarmMindWatcher"

# 3. Wait 2 seconds
Start-Sleep -Seconds 2

# 4. Restart the scheduled task
schtasks /Run /TN "SwarmMindWatcher"

# 5. Verify it's running
Get-Process -Name powershell | Where-Object {
  $_.CommandLine -match 'inbox-watcher'
}
```

### Why Restart Is Mandatory

- PowerShell processes load script content at startup
- File changes on disk are NOT picked up by running processes
- The `@args` splatting bug (now fixed) caused silent dry_run — old processes still run the old code
- **A running watcher with stale code = invisible dry_run mode**

---

## 8. Failure Modes

| ID | Failure | Detection | Recovery |
|----|---------|-----------|----------|
| SBC-001 | `task_kind="task"` → SCHEMA_INVALID quarantine | Quarantine directory count increases | Re-dispatch with valid task_kind enum value |
| SBC-002 | Unsigned message → rejected by identity-enforcer | lane-worker logs signature error | Sign with `createSignedMessage(msg, lane)` |
| SBC-003 | Missing required fields → SCHEMA_INVALID | Quarantine + SchemaValidator error | Add all 14 required fields from §2 |
| SBC-004 | Path outside lane roots → file read error | Response body: "path outside allowed roots" | Use relative path or ensure path starts with lane root |
| SBC-005 | Windows backslash path → root mismatch | Same as SBC-004 | Already fixed: paths normalized to `/` before check |
| SBC-006 | Script timeout (30s) | Response with exit_code=null, error="timed out" | Fix the script or increase timeout in executor |
| SBC-007 | Stale watcher running old code | Tasks not processing, no errors logged | Restart watcher (§7) |
| SBC-008 | `--apply` not passed | Scripts report actions but take none | Always use `--apply` for real execution |
| SBC-009 | Script not found | Response: "Script not found: <path>" | Script must exist in target lane's `scripts/` dir |
| SBC-010 | File > 50KB | Response truncated with "TRUNCATED" notice | Accept truncation or request specific line ranges |

---

## 9. Pipeline Flow Diagram

```
Parent Lane                    Target Lane (SwarmMind)
──────────                     ──────────────────────
1. Create signed task
2. Write to target inbox/
                               3. lane-worker --apply
                                  ├─ Validate signature
                                  ├─ Validate schema
                                  ├─ Route: action-required/
                                  └─ OR quarantine/
                               4. generic-task-executor --apply
                                  ├─ Move: action-required/ → in-progress/
                                  ├─ Parse body for verb
                                  ├─ Execute (read/run/check)
                                  ├─ Create signed response
                                  ├─ Deliver to parent inbox/
                                  └─ Move: in-progress/ → processed/
5. Read response from inbox/
```

---

## 10. Response Format

Responses are delivered to the parent lane's inbox as `response-{original_task_id}.json`:

```json
{
  "schema_version": "1.3",
  "task_id": "response-task-report-1777228520735",
  "from": "swarmmind",
  "to": "archivist",
  "type": "response",
  "task_kind": "report",
  "subject": "Re: Read system state",
  "body": "File S:/SwarmMind/...: 303 bytes",
  "requires_action": false,
  "_original_task_id": "task-report-1777228520735",
  "_execution_result": {
    "type": "file",
    "path": "S:/SwarmMind/lanes/broadcast/system_state.json",
    "size": 303,
    "content": "{ ... }"
  }
}
```

The `_execution_result` field contains the structured output. The `body` field contains the human-readable summary.

---

## 11. Enforcement Checklist

Before dispatching any cross-lane task:

- [ ] `task_kind` is a valid enum value (NOT "task")
- [ ] Message is signed via `createSignedMessage()`
- [ ] All 14 required fields present
- [ ] `body` contains a recognized verb (read file, run script, consistency check, report status)
- [ ] `--apply` flag included on pipeline commands
- [ ] Target lane's watcher is running current code (restart if scripts changed)

---

*This contract is self-enforcing: violations result in quarantine, not silent failure. The system protects itself.*
