# 4-Lane Rosetta Stone System - Architecture Documentation

## Version: 1.0  
## Date: 2026-04-28  
## Status: Active  

---

## SYSTEM OVERVIEW

The Rosetta Stone system is a 4-lane constitutional governance architecture designed for multi-agent AI coordination. It implements a self-correcting loop that detects failures and refines constraints to achieve stable behavior across distributed agents.

### Core Philosophies
1. **Structure Over Identity** - External governance files override agent preferences
2. **Verification Over Assumption** - Claims require evidence and validation
3. **Correction Is Mandatory** - Agreement is optional, correction is required
4. **Failure Reveals Constraints** - Persistent instability indicates missing or mis-specified constraints

---

## LANE ROLES & RESPONSIBILITIES

### 1. Archivist Lane (Authority: 100)
**Position:** Constitutional Coordinator  
**Role:** Governance root and system coordinator  

**Responsibilities:**
- Maintains constitutional framework (BOOTSTRAP.md, COVENANT.md, GOVERNANCE.md)
- Coordinates cross-lane consensus and escalation
- Enforces authority hierarchy
- Manages system-wide state reconciliation
- Approves ratification of governance changes

**Key Interfaces:**
- Tauri desktop application for folder scanning and classification
- Rust backend with vanilla HTML/CSS/JS frontend
- Cryptographic identity attestation (RSA-2048, HMAC-SHA256)

**Files:**
- `S:/Archivist-Agent/`
- `S:/Archivist-Agent/lanes/archivist/`

---

### 2. Library Lane (Authority: 90)
**Position:** Verification Surface  
**Role:** Runtime evidence verification and enforcement  

**Responsibilities:**
- Verifies claims against runtime evidence
- Enforces convergence gate requirements
- Validates cryptographic signatures
- Ensures schema compliance
- Provides verdicts on system state

**Key Interfaces:**
- Verification domain gate
- Execution gate with bounded operations
- Trust store validation
- Schema validation engine

**Files:**
- `S:/self-organizing-library/`
- `S:/self-organizing-library/lanes/library/`

---

### 3. SwarmMind Lane (Authority: 60)
**Position:** Optimization & Robustness Surface  
**Role:** Cross-lane optimization, audit, and synchronization  

**Responsibilities:**
- Optimization across all lanes
- Cross-lane robustness testing
- Audit and synchronization
- Delegated subagent execution (SBC v2.0)
- Mail standardization and diagnostics

**Key Interfaces:**
- Generic task executor
- Lane worker coordination
- Completion proof verification
- Subagent contract enforcement

**Files:**
- `S:/SwarmMind/`
- `S:/SwarmMind/lanes/swarmmind/`

---

### 4. Kernel Lane (Authority: 60)
**Position:** Execution Surface  
**Role:** Optimization artifacts and benchmarking  

**Responsibilities:**
- Produce optimization artifacts with runtime evidence
- GPU-optimized builds and benchmarks
- Profiling data generation
- Regression enforcement
- Atomic write utilities

**Constraints:**
- Cannot govern (can_govern: false)
- Evidence-first rules apply
- Must include: built artifact, benchmark report, nsys profile, ncu report

**Key Interfaces:**
- Execution gate
- Code version hashing
- Atomic write utilities
- Cross-lane consistency checking

**Files:**
- `S:/kernel-lane/`
- `S:/kernel-lane/lanes/kernel/`

---

## COMMUNICATION PROTOCOLS

### Cross-Lane Messaging
**Pattern:** Inbox/Outbox with cryptographic signing  
**Format:** JSON schema v1.3  
**Signing:** JWS RS256 with DER fingerprint key IDs  

**Directory Structure:**
```
S:/<lane-name>/lanes/<lane-id>/
├── inbox/
│   ├── action-required/    # Urgent tasks
│   ├── in-progress/        # Currently processing
│   ├── processed/          # Completed
│   ├── blocked/            # Rejected
│   ├── quarantine/         # Suspicious
│   └── heartbeat-<lane>.json
├── outbox/                # Messages to other lanes
└── processed/             # Local copies of sent messages
```

**Message Schema (v1.3):**
- `schema_version`: "1.3"
- `task_id`: Unique identifier
- `idempotency_key`: SHA-256 hash for deduplication
- `from`, `to`: Lane identifiers
- `type`: task, response, heartbeat, escalation, handoff
- `task_kind`: proposal, review, amendment, ratification
- `priority`: P0, P1, P2, P3
- `subject`: One-line summary
- `body`: Full content
- `timestamp`: ISO-8601
- `requires_action`: Boolean
- `payload`: {mode, compression, path, chunk}
- `execution`: {mode, engine, actor, session_id, parent_id}
- `lease`: Ownership and timeout information
- `retry`: Attempt tracking
- `evidence`: Verification requirements and status
- `heartbeat`: Status and timing
- `watcher`: Inbox watcher configuration
- `delivery_verification`: Receipt confirmation

---

## CRYPTOGRAPHIC INFRASTRUCTURE

### Identity Management
**Algorithm:** RSA-2048  
**Signing:** JWS RS256  
**Key ID Derivation:** MD5 hash of DER-encoded SPKI (first 16 hex chars)  
**Trust Store:** JSON file with public keys per lane  

**Key Files:**
- `.identity/private.pem` - Private key (lane-specific)
- `.identity/public.pem` - Public key (lane-specific)
- `lanes/broadcast/trust-store.json` - All lane public keys

**Trust Store Schema:**
```json
{
  "<lane_id>": {
    "lane_id": "<lane_id>",
    "public_key_pem": "-----BEGIN PUBLIC KEY-----\n...",
    "algorithm": "RS256",
    "key_id": "<md5_hash>",
    "registered_at": "<ISO-8601>",
    "expires_at": null,
    "revoked_at": null
  }
}
```

---

## GOVERNANCE HIERARCHY

### Constitutional Layer (Highest)
- **BOOTSTRAP.md**: Single entry point, all logic routes through here
- **COVENANT.md**: Foundational values and beliefs
- **GOVERNANCE.md**: Operational rules and constraints

### Operational Layer
- Authority hierarchy (100/90/60/60)
- File ownership registry
- Lane boundaries and responsibilities

### Behavioral Layer (Lowest)
- What agents actually do
- Runtime behavior and execution

### Selection Layer
- CPS (Constraint Propagation Score) testing
- Drift detection and measurement
- Convergence phases

---

## DATA FLOW

### Normal Operation
```
1. Message Creation → Cryptographic Signing
   ↓
2. Write to Target Lane's Inbox (Canonical Path)
   ↓
3. Lane Processes Message (Priority: P0 > P1 > P2 > P3)
   ↓
4. Validation: Schema + Signature + Domain
   ↓
5. Execution or Quarantine
   ↓
6. Result to Outbox (with completion proof if required)
   ↓
7. Target Lane Processes Result
```

### Convergence Gate Flow
```
1. Proposal (task_kind: "proposal")
   ↓
2. Review (All lanes within domain expertise)
   ↓
3. Amend (Additive only, justify changes)
   ↓
4. Converge (No contradictions, path clear)
   ↓
5. Ratify (Archivist approves)
```

---

## TRUST RELATIONSHIPS

### Trust Boundaries
1. **Intra-Lane Trust**: Each lane trusts its own signed messages
2. **Inter-Lane Trust**: Cross-verification via trust store
3. **User Trust**: User input requires 2+ lane convergence for execution
4. **Subagent Trust**: Delegated execution with bounded permissions

### Trust Verification Levels
**Level 1 (Local Dev)**: Single operator, full access
- Subagent can read all lane roots
- Relaxed permission boundaries

**Level 2+ (Multi-Operator)**: 
- Subagent read-scope restricted to dispatcher's lane
- Enhanced permission checks
- Information boundary enforcement

---

## OPERATIONAL PROCEDURES

### Session Start Protocol
1. Read lane inbox first (before any other work)
2. Process by priority (P0 > P1 > P2 > P3)
3. Move completed messages to processed/
4. Log outbox entries
5. Verify no pending P0 items
6. Run post-compact audit (if applicable)

### After Context Compact
1. Run recovery test suite (11 tests must pass)
2. Check handoff hash against log
3. Quarantine if mismatch detected

### Message Sending
1. WRITE target canonical inbox path
2. LOG message copy to outbox
3. VERIFY delivery confirmation

### Heartbeat Protocol
1. OVERWRITE heartbeat file every 60 seconds max
2. Check other lanes' heartbeats (stale > 900s)
3. Report stale lanes to Archivist
4. Write "shutdown" status on session end

---

## FAILURE MODES & MITIGATION

### Critical Failures
- **NFM-001**: Process isolation failure → Use proper enforcement boundaries
- **NFM-002**: Self-state aliasing → Check runtime state before registry
- **NFM-014**: Atomic write silent failures → Use temp file + rename pattern
- **NFM-017**: Invalid PEM → Regenerate from source keys

### Security Gaps
- **NFM-019**: Schema-behavior mismatch → Align enums with operations
- **NFM-020**: Cross-lane observability → Use canonical paths
- **NFM-025**: Compromised keys → Implement key rotation
- **NFM-028**: Replay attacks → Add timestamp freshness checks

---

## PERFORMANCE CHARACTERISTICS

### Test Coverage
- Lane Worker Tests: 17/17 per lane
- Executor Tests: 64/64 per lane
- Convergence Tests: Continuous
- Recovery Tests: 10/11 (1 conflicted)

### Sync Verification
- File targets: 32+ verified
- Cross-lane checks: Continuous
- Drift detection: Active

---

## COMPLIANCE MATRIX

| Requirement | Archivist | Library | SwarmMind | Kernel | Status |
|------------|-----------|---------|-----------|--------|--------|
| Constitutional Layer | ✅ | ✅ | ✅ | ✅ | Met |
| Cryptographic Signing | ✅ | ✅ | ✅ | ✅ | Met |
| Schema Validation | ✅ | ✅ | ✅ | ✅ | Met |
| Path Standardization | ⚠️ | ✅ | ✅ | ✅ | Partial |
| Trust Store Sync | ⚠️ | ⚠️ | ⚠️ | ⚠️ | In Progress |
| Atomic Writes | ✅ | ✅ | ✅ | ⚠️ | Partial |
| Test Coverage | ✅ | ✅ | ✅ | ✅ | Met |

---

## DEPLOYMENT CONSIDERATIONS

### Pre-Deployment Checklist
- [ ] All trust stores synchronized
- [ ] Key IDs verified across lanes
- [ ] Path standardization complete
- [ ] Atomic writes validated on target OS
- [ ] Test suites passing (100%)
- [ ] Recovery procedures documented
- [ ] Rollback plan established

### Monitoring Requirements
- Heartbeat status (all lanes)
- Trust store consistency
- Message queue depths
- Test suite results
- Drift detection alerts
- Convergence phase status

---

## REFERENCES

1. **Paper A**: Rosetta Stone - Four Invariants
2. **Paper B**: Constraint Lattices and Stability  
3. **Paper C**: Phenotype Selection
4. **Paper D**: Drift, Identity, and Ensemble Coherence
5. **Paper E**: WE4FREE Framework (Implementation)
6. **Paper F**: Failure Modes and Self-Correction

**Framework**: WE4FREE (4-lane constitutional governance)  
**Version**: Production  
**License**: Internal Use  
**Maintainer**: Multi-lane coordination team

---

*Document Status: Active*  
*Last Updated: 2026-04-28*  
*Next Review: After Phase 1 completion*
