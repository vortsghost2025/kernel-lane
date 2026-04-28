# Constraint Catalog

**Version:** 1.0  
**Last Updated:** 2026-04-28  
**Workstream:** Discovery (Workstream 1)  
**Status:** Active  

---

## Overview

This catalog contains all identified constraints that limit system optimization, organized by domain and impact. Each constraint includes: definition, evidence, impact assessment, and remediation status.

## Quick Statistics

- **Total Constraints:** 23
- **Verified:** 15 (65%)
- **In Progress:** 5 (22%)
- **Proposed:** 3 (13%)
- **Resolved:** 0 (0%)

---

## Constraint Classification

### Domain Categories

| Domain | Description | Constraints |
|--------|-------------|-------------|
| **Architecture** | System structure and composition | 6 |
| **Performance** | Speed, efficiency, scalability | 5 |
| **Security** | Protection and access control | 4 |
| **Governance** | Rules, processes, compliance | 5 |
| **Reliability** | Fault tolerance, recovery | 3 |

### Impact Levels

| Level | Definition | Criteria | Count |
|-------|------------|----------|-------|
| **Critical** | Blocks production or creates security risk | Must fix immediately | 3 |
| **High** | Significant impact on functionality or performance | Fix in Phase 2 | 8 |
| **Medium** | Moderate impact, affects efficiency | Fix in Phase 2 or 3 | 7 |
| **Low** | Minor impact, can be deferred | Fix as needed | 5 |

---

## Constraint Inventory

### CRITICAL Constraints

#### C001: Path Traversal Vulnerability
- **Domain:** Security
- **Status:** Verified
- **Impact:** Critical
- **Lane:** Archivist, Library, SwarmMind
- **Description:** Current path validation uses regex patterns that can be bypassed, allowing arbitrary file system access
- **Evidence:** Code review (system-code-review-20260428.json), security audit
- **Root Cause:** `execution-gate.js` uses `fs.existsSync()` with user-controlled paths without canonical resolution
- **Remediation:** Replace regex with `path.resolve()` + `startsWith()` validation
- **Est. Effort:** 2 person-days
- **Owner:** Library
- **Dependencies:** None
- **Created:** 2026-04-28
- **Priority Score:** 9.5/10

#### C002: Atomic Write Failure on Windows
- **Domain:** Reliability, Performance
- **Status:** Verified
- **Impact:** Critical
- **Lane:** Kernel
- **Description:** File writes on Windows can corrupt data due to lack of atomic operations
- **Evidence:** Test failures, data corruption incidents
- **Root Cause:** Direct file overwrite without proper locking or atomic rename
- **Remediation:** Implement cross-platform atomic write with lease-based locking
- **Est. Effort:** 4 person-days
- **Owner:** Kernel
- **Dependencies:** None
- **Created:** 2026-04-28
- **Priority Score:** 9.0/10

#### C003: Trust Store Inconsistency
- **Domain:** Security
- **Status:** Verified
- **Impact:** Critical
- **Lane:** All lanes
- **Description:** Trust store files can diverge across lanes, enabling message forgery
- **Evidence:** Trust consistency tests show potential divergence scenarios
- **Root Cause:** No runtime verification of trust store synchronization
- **Remediation:** Implement automatic trust store sync and divergence detection
- **Est. Effort:** 3 person-days
- **Owner:** Library (with all lanes)
- **Dependencies:** C007
- **Created:** 2026-04-28
- **Priority Score:** 8.8/10

---

### HIGH Constraints

#### C004: Tauri Command Injection
- **Domain:** Security
- **Status:** Verified
- **Impact:** High
- **Lane:** Archivist
- **Description:** User-controlled input passed to Tauri invoke() without sanitization
- **Evidence:** Code review identifies multiple injection points
- **Root Cause:** Missing input validation and command allowlist
- **Remediation:** Implement command validation layer and sanitize all inputs
- **Est. Effort:** 2 person-days
- **Owner:** Archivist
- **Dependencies:** None
- **Created:** 2026-04-28
- **Priority Score:** 8.5/10

#### C005: Schema-Behavior Mismatch (NFM-019)
- **Domain:** Architecture, Governance
- **Status:** Verified
- **Impact:** High
- **Lane:** All lanes
- **Description:** Message schemas don't match actual operational vocabulary
- **Evidence:** System code review, validation failures
- **Root Cause:** Schema evolution without behavior updates
- **Remediation:** Align schemas with actual usage, add versioning
- **Est. Effort:** 3 person-days
- **Owner:** SwarmMind (coordination)
- **Dependencies:** None
- **Created:** 2026-04-28
- **Priority Score:** 8.0/10

#### C006: LANE_REGISTRY Message Loss
- **Domain:** Architecture, Reliability
- **Status:** Verified
- **Impact:** High
- **Lane:** SwarmMind
- **Description:** Generic task executor uses incorrect registry causing message routing failures
- **Evidence:** Observed message loss in testing
- **Root Cause:** Hardcoded registry mismatch
- **Remediation:** Fix LANE_REGISTRY consistency, add validation
- **Est. Effort:** 1 person-day
- **Owner:** SwarmMind
- **Dependencies:** None
- **Created:** 2026-04-28
- **Priority Score:** 7.5/10

#### C007: No Timestamp Freshness Checks
- **Domain:** Security, Reliability
- **Status:** Verified
- **Impact:** High
- **Lane:** All lanes
- **Description:** Messages can be replayed without detection
- **Evidence:** Security audit identifies missing timestamp validation
- **Root Cause:** No time window validation on message processing
- **Remediation:** Add timestamp checks with tolerance windows
- **Est. Effort:** 2 person-days
- **Owner:** Library
- **Dependencies:** None
- **Created:** 2026-04-28
- **Priority Score:** 7.3/10

#### C008: Incomplete Delegation Contract (Level 2+)
- **Domain:** Security, Architecture
- **Status:** Verified
- **Impact:** High
- **Lane:** All lanes
- **Description:** Subagent read-scope not enforced for security posture Level 2+
- **Evidence:** Design review identifies missing boundary checks
- **Root Cause:** Security features incomplete for multi-operator scenarios
- **Remediation:** Implement read-scope filters and boundary enforcement
- **Est. Effort:** 4 person-days
- **Owner:** SwarmMind (architecture)
- **Dependencies:** C003
- **Created:** 2026-04-28
- **Priority Score:** 7.0/10

---

### MEDIUM Constraints

#### C009: Hardcoded Paths in Scripts
- **Domain:** Architecture, Reliability
- **Status:** Verified
- **Impact:** Medium
- **Lane:** All lanes (partial)
- **Description:** Some scripts still use hardcoded paths instead of LaneDiscovery
- **Evidence:** Code review (system-code-review-20260428.json)
- **Root Cause:** Incomplete migration to LaneDiscovery pattern
- **Remediation:** Replace all hardcoded paths with canonical paths
- **Est. Effort:** 2 person-days
- **Owner:** All lanes (shared)
- **Dependencies:** None
- **Created:** 2026-04-28
- **Priority Score:** 6.0/10

#### C010: Field Name Inconsistency (system_status vs system_state)
- **Domain:** Architecture
- **Status:** Verified
- **Impact:** Medium
- **Lane:** All lanes
- **Description:** Inconsistent field naming across system state files
- **Evidence:** Cross-lane comparison shows variations
- **Root Cause:** No naming convention enforcement
- **Remediation:** Standardize on `system_status`, add aliases
- **Est. Effort:** 1 person-day
- **Owner:** Library
- **Dependencies:** None
- **Created:** 2026-04-28
- **Priority Score:** 5.5/10

#### C011: CSP Bypass in Tauri
- **Domain:** Security
- **Status:** Verified
- **Impact:** Medium
- **Lane:** Archivist
- **Description:** Tauri bridge can bypass Content-Security-Policy
- **Evidence:** Security testing shows invoke bypasses CSP
- **Root Cause:** Tauri design allows privileged operations
- **Remediation:** Strengthen CSP, add pre-invoke security checks
- **Est. Effort:** 1 person-day
- **Owner:** Archivist
- **Dependencies:** C004
- **Created:** 2026-04-28
- **Priority Score:** 5.0/10

#### C012: hasCompletionProof Duplication
- **Domain:** Architecture
- **Status:** Verified
- **Impact:** Medium
- **Lane:** SwarmMind
- **Description:** hasCompletionCheck duplicated across multiple files
- **Evidence:** Code review finds 3+ implementations
- **Root Cause:** No central canonical implementation
- **Remediation:** Consolidate to single canonical implementation
- **Est. Effort:** 1 person-day
- **Owner:** SwarmMind
- **Dependencies:** None
- **Created:** 2026-04-28
- **Priority Score:** 4.5/10

#### C013: Schema Enums Too Narrow
- **Domain:** Architecture
- **Status:** Verified
- **Impact:** Medium
- **Lane:** SwarmMind
- **Description:** Schema enumerations don't cover all operational vocabulary
- **Evidence:** Runtime encounters values not in schemas
- **Root Cause:** Schemas not updated with new operations
- **Remediation:** Expand enums, add extensibility mechanism
- **Est. Effort:** 1.5 person-days
- **Owner:** SwarmMind
- **Dependencies:** C005
- **Created:** 2026-04-28
- **Priority Score:** 4.0/10

---

### LOW Constraints

#### C014: Race Conditions in Inbox Watcher
- **Domain:** Reliability
- **Status:** Proposed
- **Impact:** Low
- **Lane:** All lanes
- **Description:** TOCTOU issues in inbox file processing
- **Evidence:** Theoretical analysis, no observed failures
- **Root Cause:** File check then use without atomicity
- **Remediation:** Use file locking or atomic operations
- **Est. Effort:** 2 person-days
- **Owner:** Kernel (coordination)
- **Dependencies:** C002
- **Created:** 2026-04-28
- **Priority Score:** 3.0/10

#### C015: Key ID Derivation Ambiguity
- **Domain:** Security
- **Status:** Proposed
- **Impact:** Low
- **Lane:** All lanes
- **Description:** MD5-based key IDs may have collision risk
- **Evidence:** Cryptographic analysis (theoretical)
- **Root Cause:** MD5 not collision-resistant
- **Remediation:** Consider SHA-256 truncation or other scheme
- **Est. Effort:** 1 person-day (research)
- **Owner:** Archivist
- **Dependencies:** None
- **Created:** 2026-04-28
- **Priority Score:** 2.5/10

#### C016-023: Additional Proposed Constraints
- **Status:** Under investigation
- **Details:** See discovery backlog

---

## Constraint Metadata Schema

Each constraint entry includes:

```json
{
  "id": "C001",
  "title": "Path Traversal Vulnerability",
  "domain": "Security",
  "status": "Verified | In Progress | Proposed | Resolved",
  "impact": "Critical | High | Medium | Low",
  "lanes": ["Archivist", "Library"],
  "description": "...",
  "evidence": "...",
  "root_cause": "...",
  "remediation": "...",
  "estimated_effort": "X person-days",
  "owner": "lane",
  "dependencies": ["C002"],
  "created": "2026-04-28",
  "resolved": null,
  "priority_score": 9.5
}
```

---

## Validation Status

| Status | Meaning | Count |
|--------|---------|-------|
| **Verified** | Confirmed through testing/analysis | 15 |
| **In Progress** | Being investigated/validated | 5 |
| **Proposed** | Identified but not validated | 3 |
| **Resolved** | Fixed and verified | 0 |

---

## Remediation Tracking

### Current Phase 1 (Ongoing)
- C002: Atomic write (Kernel) - In Progress
- C001: Path traversal (Library) - Pending
- C004: Tauri injection (Archivist) - Pending

### Phase 2 Candidates
- C003: Trust store sync - High priority
- C005: Schema alignment - High priority
- C006: LANE_REGISTRY fix - High priority
- C007: Timestamp checks - Medium priority
- C008: Delegation contract - Medium priority

### Deferred
- C014+: Low priority constraints

---

## Usage

This catalog drives:
1. **Prioritization** (Workstream 2)
2. **Pilot selection** (Workstream 3)
3. **Resource allocation** (Governance)
4. **Progress tracking** (All workstreams)

**Last Updated:** 2026-04-28  
**Next Review:** 2026-05-12 (Phase 2 Kickoff)
