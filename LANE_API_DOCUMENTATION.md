# Lane Interaction API Documentation

## Version: 1.0  
## Generated: 2026-04-28  
## Status: Complete  

---

## Overview

This document provides comprehensive API documentation for all lane-to-lane interactions in the 4-lane Rosetta Stone system.

---

## 1. Authentication & Authorization

### 1.1 Cryptographic Identity

Each lane has a unique RSA-2048 key pair for message signing:

**Key Identification:**
```javascript
{
  "key_id": "<md5_hash_of_DER_encoded_SPKI>",
  "algorithm": "RS256",
  "public_key_pem": "-----BEGIN PUBLIC KEY-----\n..."
}
```

**Lane Keys:**
| Lane | Key ID | Purpose |
|------|--------|---------|
| Archivist | `45a318fe5e226407` | Governance root signing |
| Library | `b1eba056729bbe9a` | Verification authority |
| SwarmMind | `ecb12bdacf826701` | Task execution signing |
| Kernel | `6d220ff8f1ef5b05` | Artifact attestation |

### 1.2 Message Signing

**Signature Format (JWS RS256):**
```
eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJ...<signature>
```

**Verification Process:**
1. Extract `key_id` from JWS header
2. Look up public key in `trust-store.json`
3. Verify signature using RSA-PKCS1-v1_5
4. Validate payload integrity

### 1.3 Required Fields for Signed Messages

```json
{
  "schema_version": "1.3",
  "task_id": "unique-uuid",
  "idempotency_key": "sha256-hash",
  "from": "source-lane",
  "to": "target-lane",
  "timestamp": "2026-04-28T12:00:00-04:00",
  "signature": "<JWS-RS256>",
  "key_id": "<matching-key-id>"
}
```

---

## 2. Message Schema (v1.3)

### 2.1 Core Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `schema_version` | string | Yes | Must be "1.3" |
| `task_id` | string | Yes | UUID format |
| `idempotency_key` | string | Yes | SHA-256 hash |
| `from` | string | Yes | Source lane ID |
| `to` | string | Yes | Target lane ID |
| `type` | enum | Yes | task, response, heartbeat, escalation, handoff |
| `task_kind` | enum | Yes | proposal, review, amendment, ratification |
| `priority` | enum | Yes | P0, P1, P2, P3 |
| `subject` | string | Yes | One-line summary |
| `body` | string | Yes | Full content |
| `timestamp` | ISO-8601 | Yes | Message creation time |
| `requires_action` | boolean | Yes | Whether action needed |

### 2.2 Payload Structure

```json
{
  "payload": {
    "mode": "inline|path|chunked",
    "compression": "none|gzip",
    "path": null,
    "chunk": {
      "index": 0,
      "count": 1,
      "group_id": null
    }
  }
}
```

### 2.3 Execution Context

```json
{
  "execution": {
    "mode": "manual|session_task|watcher",
    "engine": "kilo|opencode|other",
    "actor": "lane|subagent|watcher",
    "session_id": null,
    "parent_id": null
  }
}
```

### 2.4 Lease & Ownership

```json
{
  "lease": {
    "owner": "lane-id",
    "acquired_at": "ISO-8601",
    "expires_at": null,
    "renew_count": 0,
    "max_renewals": 3
  }
}
```

### 2.5 Evidence Requirements

```json
{
  "evidence": {
    "required": true,
    "evidence_path": null,
    "verified": false,
    "verified_by": null,
    "verified_at": null
  },
  "evidence_exchange": {
    "artifact_path": null,
    "artifact_type": "log|artifact|report",
    "delivered_at": null
  }
}
```

### 2.6 Heartbeat Monitoring

```json
{
  "heartbeat": {
    "interval_seconds": 300,
    "last_heartbeat_at": "ISO-8601",
    "timeout_seconds": 900,
    "status": "pending|in_progress|done|failed|escalated|timed_out"
  }
}
```

### 2.7 Convergence Gate

```json
{
  "convergence_gate": {
    "claim": "Single sentence",
    "evidence": "path/to/evidence",
    "verified_by": "archivist|library|swarmmind|kernel|self|user",
    "contradictions": [],
    "status": "proven|unproven|conflicted|blocked"
  }
}
```

---

## 3. Communication Protocols

### 3.1 Directory Structure

**Source Lane (Sender):**
```
lanes/<lane-id>/
├── outbox/                 # Messages to send
│   └── <message-id>.json
```

**Target Lane (Receiver):**
```
lanes/<lane-id>/
├── inbox/
│   ├── action-required/    # P0 items
│   ├── in-progress/        # Currently processing
│   ├── processed/          # Completed
│   ├── blocked/            # Rejected
│   └── quarantine/         # Suspicious
```

### 3.2 Message Flow

#### 3.2.1 Standard Message

```
1. Sender creates message M
2. Sign M with sender's private key
3. Write M to sender's outbox/
4. Copy M to target's inbox/action-required/ (if P0) or inbox/
5. Target validates signature
6. Target validates schema
7. Target processes M
8. Target moves M to inbox/processed/
9. Target creates response R
10. Target sends R via same flow
```

#### 3.2.2 Priority Handling

| Priority | Directory | SLA |
|----------|-----------|-----|
| P0 | action-required/ | Immediate (< 5 min) |
| P1 | inbox/ | Same day |
| P2 | inbox/ | 3 days |
| P3 | inbox/ | 7 days |

### 3.3 Idempotency

**Idempotency Key Generation:**
```javascript
const idempotencyKey = crypto.createHash('sha256')
  .update(taskId + from + to + subject)
  .digest('hex');
```

**Deduplication:**
- Check `idempotency_key` against processed messages
- Return cached response if duplicate detected
- Log duplicate attempts for audit

---

## 4. Endpoint Specifications

### 4.1 Task Submission

**Endpoint Type:** File-based (no HTTP)

**Request Format:**
```json
{
  "schema_version": "1.3",
  "task_id": "task-12345",
  "type": "task",
  "task_kind": "review",
  "from": "kernel",
  "to": "library",
  "priority": "P0",
  "subject": "Review optimization artifact",
  "body": "Please review the attached artifact...",
  "timestamp": "2026-04-28T12:00:00-04:00",
  "requires_action": true,
  "evidence": {
    "required": true,
    "evidence_path": "lanes/kernel/outbox/artifact.json"
  }
}
```

**Response Format:**
```json
{
  "schema_version": "1.3",
  "task_id": "task-12345",
  "type": "response",
  "from": "library",
  "to": "kernel",
  "subject": "Re: Review optimization artifact",
  "body": "Artifact reviewed and approved",
  "convergence_gate": {
    "claim": "Artifact meets requirements",
    "evidence": "lanes/library/outbox/review-result.json",
    "status": "proven"
  }
}
```

### 4.2 Heartbeat

**Request Format:**
```json
{
  "schema_version": "1.3",
  "task_id": "heartbeat-<lane>",
  "type": "heartbeat",
  "from": "<lane>",
  "to": "<lane>",
  "priority": "P3",
  "subject": "Heartbeat from <lane>",
  "body": "{\"lane\":\"<lane>\",\"status\":\"alive\"}",
  "timestamp": "2026-04-28T12:00:00-04:00",
  "heartbeat": {
    "interval_seconds": 300,
    "status": "done"
  }
}
```

**Validation Rules:**
- Must arrive within `interval_seconds + timeout_seconds`
- Missing 3 consecutive heartbeats = lane considered stale
- Stale lanes reported to Archivist

### 4.3 Escalation

**Request Format:**
```json
{
  "schema_version": "1.3",
  "task_id": "escalation-123",
  "type": "escalation",
  "task_kind": "review",
  "from": "library",
  "to": "archivist",
  "priority": "P0",
  "subject": "Escalation: Unresolved contradiction",
  "body": "Description of issue...",
  "contradictions": [
    {
      "from": "library",
      "claim": "...",
      "evidence": "..."
    }
  ]
}
```

**Response Requirements:**
- Archivist must respond within 24 hours
- Response must include resolution plan
- If rejected, must provide justification

---

## 5. Validation Rules

### 5.1 Schema Validation

**Required Checks:**
```javascript
const requiredFields = [
  'schema_version', 'task_id', 'idempotency_key',
  'from', 'to', 'type', 'task_kind', 'priority',
  'subject', 'body', 'timestamp'
];

function validateSchema(message) {
  for (const field of requiredFields) {
    if (!message.hasOwnProperty(field)) {
      return { valid: false, error: `Missing field: ${field}` };
    }
  }
  
  if (message.schema_version !== '1.3') {
    return { valid: false, error: 'Unsupported schema version' };
  }
  
  return { valid: true };
}
```

### 5.2 Signature Validation

```javascript
function verifySignature(message, publicKey) {
  const { signature, key_id, ...payload } = message;
  
  // Verify key_id matches registered key
  if (key_id !== publicKey.key_id) {
    return { valid: false, error: 'Key ID mismatch' };
  }
  
  // Verify JWS signature
  const verified = jws.verify(signature, 'RS256', publicKey.pem);
  
  return {
    valid: verified,
    error: verified ? null : 'Invalid signature'
  };
}
```

### 5.3 Domain Validation (Post-Execution)

```javascript
function validateDomain(message) {
  // Check if execution artifact is observable
  if (message.evidence && message.evidence.evidence_path) {
    const observable = fs.existsSync(message.evidence.evidence_path);
    
    if (!observable) {
      return {
        valid: false,
        error: 'artifact not observable',
        domain: 'INVALID_DOMAIN'
      };
    }
  }
  
  return { valid: true };
}
```

---

## 6. Error Handling

### 6.1 Error Categories

| Code | Category | Description |
|------|----------|-------------|
| 1000 | Schema | Invalid message structure |
| 1001 | Signature | Cryptographic verification failed |
| 1002 | Domain | Post-execution validation failed |
| 1003 | Quarantine | Suspicious content |
| 1004 | Rejection | Business rule violation |

### 6.2 Quarantine Conditions

Messages are quarantined when:
- Invalid schema (cannot be parsed)
- Suspicious content patterns detected
- Failed multiple validation attempts
- Unknown sender

### 6.3 Blocking Conditions

Messages are blocked when:
- Valid schema but business rule violation
- Missing required evidence
- Invalid signature
- Expired timestamp

---

## 7. Monitoring & Observability

### 7.1 Metrics

**Queue Metrics:**
- `inbox_depth`: Messages pending processing
- `processing_time`: Average time to process
- `error_rate`: Failed validations / total
- `throughput`: Messages per minute

**Health Metrics:**
- `heartbeat_status`: alive/stale/dead
- `last_message_time`: ISO-8601 timestamp
- `contradiction_count`: Active contradictions
- `drift_score`: CPS convergence metric

### 7.2 Logging

**Required Log Fields:**
```json
{
  "timestamp": "ISO-8601",
  "lane": "<lane-id>",
  "message_id": "<task-id>",
  "operation": "receive|process|send|error",
  "status": "success|failure",
  "duration_ms": 123,
  "error_code": null,
  "trace_id": "<correlation-id>"
}
```

---

## 8. Security Considerations

### 8.1 Trust Boundaries

**Level 1 (Local Development):**
- Single operator
- Full cross-lane read access
- Relaxed permission checks

**Level 2 (Multi-Operator):**
- Multiple operators
- Restricted cross-lane access
- Enforced permission boundaries

**Level 3 (Production):**
- Hardened environment
- Hardware-backed keys
- Full audit logging
- Network segmentation

### 8.2 Key Management

**Key Rotation:**
1. Generate new key pair
2. Add to trust store with new key_id
3. Phase out old key (grace period)
4. Remove old key from trust store
5. Update all lane references

**Key Revocation:**
- Immediate: Remove from trust store
- Notify all lanes
- Reject messages signed with revoked key
- Generate incident report

### 8.3 Attack Vectors

| Vector | Mitigation |
|--------|------------|
| Replay Attack | Timestamp validation + nonce |
| Man-in-the-Middle | Certificate pinning |
| Key Compromise | Hardware security module |
| Path Traversal | Canonical path resolution |
| Command Injection | Input sanitization + allowlist |

---

## 9. Compliance Requirements

### 9.1 Constitutional Hierarchy

```
Constitution (Highest)
  ↓
User Mandate
  ↓
Governance Rules
  ↓
Operational Procedures (Lowest)
```

### 9.2 Audit Requirements

**All messages must include:**
- Cryptographic proof of origin
- Timestamp
- Evidence chain
- Verification status

**Retention:**
- Messages: 7 years
- Audit logs: 10 years
- Keys: Until rotated + 1 year

---

## 10. Implementation Examples

### 10.1 Sending a Message

```javascript
const { signMessage } = require('./identity-enforcer');
const LaneDiscovery = require('./lane-discovery');

async function sendTask(targetLane, taskData) {
  const discovery = new LaneDiscovery();
  const targetInbox = discovery.getInbox(targetLane);
  
  const message = {
    schema_version: '1.3',
    task_id: `task-${Date.now()}`,
    type: 'task',
    task_kind: 'review',
    from: 'kernel',
    to: targetLane,
    priority: 'P0',
    subject: 'Optimization review',
    body: JSON.stringify(taskData),
    timestamp: new Date().toISOString(),
    requires_action: true
  };
  
  // Sign message
  const signed = await signMessage(message, 'kernel');
  
  // Write to target inbox
  const fs = require('fs').promises;
  const targetPath = path.join(targetInbox, `${signed.task_id}.json`);
  await fs.writeFile(targetPath, JSON.stringify(signed, null, 2));
  
  return signed;
}
```

### 10.2 Processing Messages

```javascript
const InboxWatcher = require('./inbox-watcher');

const watcher = new InboxWatcher({
  laneName: 'library',
  inboxPath: '/path/to/inbox'
});

watcher.on('message', async (message) => {
  try {
    // Validate
    const validation = await validateMessage(message);
    if (!validation.valid) {
      await quarantine(message, validation.error);
      return;
    }
    
    // Process
    const result = await processTask(message);
    
    // Respond
    const response = createResponse(message, result);
    await sendResponse(response);
    
    // Archive
    await archive(message, 'processed');
  } catch (error) {
    await archive(message, 'quarantine');
    logError(error);
  }
});

watcher.start();
```

---

## 11. Troubleshooting

### 11.1 Common Issues

| Issue | Cause | Solution |
|-------|-------|----------|
| Signature verification fails | Key mismatch | Sync trust store across lanes |
| Messages not processing | Invalid path | Use LaneDiscovery for paths |
| Stale heartbeats | Clock skew | Sync system time |
| Permission errors | File ownership | Check directory permissions |
| Schema validation fails | Version mismatch | Update to schema v1.3 |

### 11.2 Debug Commands

```bash
# Verify trust store
node scripts/verify-trust-store.js

# Check lane health
node scripts/check-lane-health.js

# Validate message
node scripts/validate-message.js <message-file>

# Sync all lanes
node scripts/sync-all-lanes.js
```

---

## 12. Version History

| Version | Date | Changes |
|---------|------|---------|
| 1.3 | 2026-04-28 | Current version - Full validation |
| 1.2 | 2026-04-27 | Added convergence gate |
| 1.1 | 2026-04-26 | Enhanced evidence exchange |
| 1.0 | 2026-04-25 | Initial release |

---

## 13. References

- [BOOTSTRAP.md](BOOTSTRAP.md) - System entry point
- [GOVERNANCE.md](GOVERNANCE.md) - Operational rules
- [COVENANT.md](COVENANT.md) - Foundational values
- [Paper F: Failure Modes](books/book-6-ensemble-intelligence-foundation.md) - Implementation learnings

---

## 14. Support

**Primary Contact:** Governance Root (Archivist)  
**Authority Level:** 100  
**Escalation:** Constitutional Council  

**Issue Tracking:**  
- Code review: `lanes/broadcast/system-code-review-20260428.json`
- Phase 1 status: `lanes/broadcast/phase1-ack-scoreboard.json`

---

*© 2026 Rosetta Stone System - Internal Use Only*  
*Document Classification: Governance*  
*Distribution: All Lanes*

---

*End of Document*
