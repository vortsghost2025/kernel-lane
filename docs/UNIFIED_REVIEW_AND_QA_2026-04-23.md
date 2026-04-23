# Unified 4-Lane Code Review & Operator Q&A

**Date:** 2026-04-23
**Reviewer:** Kernel Lane (Lane 4, Authority 60)
**Scope:** All 4 lanes individually + as unified system, cross-referencing prior reviews (FOUR_LANE_REVIEW_2026-04-21, FOUR_LANE_REVIEW_DEEP_2026-04-21) and current session findings
**Total findings:** 136 (13 P0, 31 P1, 46 P2, 46 P3)

---

## PART 1: UNIFIED CROSS-LANE CODE REVIEW

### 1.1 System Architecture Summary

| Lane | Position | Authority | can_govern | Repo | Git? | Tests? |
|------|----------|-----------|------------|------|------|--------|
| Archivist | 1 | 100 | true | S:/Archivist-Agent | YES | Partial (Rust unit tests, some fail) |
| Library | 2 | 90 | false | S:/self-organizing-library | YES | ZERO (Next.js app untested) |
| SwarmMind | 3 | 80 | false | S:/SwarmMind | **NO** | Stub-only |
| Kernel | 4 | 60 | false | S:/kernel-lane | YES | Partial (recovery-test-suite) |

**Critical structural deficit:** SwarmMind has no git repository. Zero version control. This means any change is irreversible, untraceable, and unauditable. This alone makes SwarmMind the weakest lane operationally, despite having the strongest verification code.

### 1.2 Cross-Lane Issue Matrix

Issues that affect multiple lanes or the system as a whole:

| # | Cross-Lane Issue | Affected Lanes | Severity | Status |
|---|------------------|---------------|----------|--------|
| X1 | **Key ID derivation: 3-5 different algorithms** | All 4 | P0 | Root cause of key_id convergence conflict |
| X2 | **stableStringify: 4 independent copies with subtle differences** | All 4 | P1 | Same input → different hash → different key_id |
| X3 | **Zero outbound message signing** | All 4 | P0 | Signer.js exists in 3 lanes, never called |
| X4 | **Identity enforcement: 2 lanes warn, 2 lanes don't check** | All 4 | P0 | Unsigned messages processed as legitimate |
| X5 | **.trust/ → .identity/ migration incomplete/differing** | Kernel, SwarmMind | P1 | Kernel .identity/ missing, paths inconsistent |
| X6 | **SwarmMind path identity crisis** | All 4 | P1 | S:/SwarmMind/ vs S:/SwarmMind Self-Optimizing Multi-Agent AI System/ |
| X7 | **Trust store key_id mismatch** | Archivist, Kernel | P0 | Snapshot key_id ≠ trust store key_id |
| X8 | **All-lane passphrase file** | Archivist (host) | P0 | Single plaintext file gives all 4 keys |
| X9 | **No CI/CD pipelines** | All 4 | P1 | Zero automated build/test validation |
| X10 | **Fake evidence promotion** | Kernel | P0 | Test-Path only, null metrics pass |
| X11 | **Null metrics bypass regression** | Kernel | P0 | PowerShell $null comparison semantics |
| X12 | **No file integrity protection for governance/config** | All 4 | P1 | AGENTS.md already overwritten once |
| X13 | **Lease enforcement inconsistent** | SwarmMind only | P1 | 3 of 4 lanes ignore lease fields |
| X14 | **Scheduled tasks mostly broken/unconfirmed** | All except Kernel | P2 | Only Kernel has confirmed persistence |
| X15 | **Parse-failed messages → processed/** | Archivist, potentially others | P1 | Corrupt messages treated as "done" |
| X16 | **Private key material handling varies** | All 4 | P0 | No uniform protection; some keys on disk with default perms |
| X17 | **Library AGENTS.md wrong canonical path for Kernel** | Library | P1 | kernel-lane vs kernel |
| X18 | **Heartbeat schema non-compliance** | Kernel, Library | P1 | Missing fields, invalid enum values |
| X19 | **No global message ordering** | All 4 | P2 | Causal ordering not enforced cross-lane |
| X20 | **Governance = documentation theater** | All 4 | P0 | 7 Laws have zero Node.js runtime enforcement |

### 1.3 Key ID Derivation: The Root Cause

This is the single most damaging cross-lane inconsistency. Five different algorithms produce different key_ids for the same key material:

| Location | Algorithm | Output for same PEM |
|----------|-----------|-------------------|
| `KeyManager.js` | SHA-256 of PEM content (includes headers) | Hash A |
| `canonical-trust-resolver.js` | SHA-256 of canonical-PEM (stripped headers/whitespace) | Hash B |
| `sign-outbox-message.js` | SHA-256 of DER buffer | Hash C |
| `create-signed-message.js` | SHA-256 of modulus+exponent hex | Hash D |
| `identity-self-healing.js` | SHA-256 of fingerprint string | Hash E |

**Impact:** Library proved the canonical-PEM method (Hash B) is correct. SwarmMind and Kernel proposed rotating to Hash A (`1a7741b8d353abee`). This created the key_id convergence conflict that dominated governance for days. The fix is trivial — unify to one algorithm — but the impact cascades through every trust store entry, every identity snapshot, every signed message.

### 1.4 What Each Lane Does Well

| Lane | Proven Strength | Evidence |
|------|----------------|----------|
| Archivist | JWS verification (A=B=C invariant), quarantine loop, concurrency locks | 18 processed messages, 5 gate violations logged |
| Library | SchemaValidator (structural), canonical delivery (outbound), Next.js app compiles | deliverMessage writes to absolute paths |
| SwarmMind | Strongest verifier code, governed-start chain, lease enforcement, negative tests | test-hardening-drill.js covers wrong lane/key/tamper/revoked |
| Kernel | Concurrency locks, regression checking (when non-null), CUDA build pipeline, scheduled tasks | Heartbeat timestamps current, recovery test suite passes |

### 1.5 What Each Lane Fails At

| Lane | Critical Failure | Root Cause |
|------|-----------------|------------|
| Archivist | All-lane key compromise via single file, governance unenforced in code | Operational deployment gap between law and code |
| Library | Zero test coverage, SSR crash, infinite re-render, no auth on API routes | Frontend built without engineering rigor |
| SwarmMind | No git, all agents are stubs, SeccompSimulator is no-op | Hackathon demo never replaced with production code |
| Kernel | Fake evidence promotion, null metrics bypass, no message signing | PowerShell null semantics + missing content validation |

### 1.6 Unified Risk Ranking (System-Wide)

| Rank | Risk | Severity | Lanes | Attack Feasibility |
|------|------|----------|-------|-------------------|
| 1 | All-lane key compromise via lane-passphrases.json | CRITICAL | Archivist (affects all) | Trivial — read one file |
| 2 | Unauthenticated cross-lane communication | CRITICAL | All 4 | Trivial — write JSON to inbox |
| 3 | Fake evidence → "proven" convergence | CRITICAL | Kernel | Easy — empty file passes gates |
| 4 | Key ID derivation inconsistency | HIGH | All 4 | Already happening — caused convergence conflict |
| 5 | Null metrics bypass regression check | HIGH | Kernel | Easy — any kernel producing no stdout |
| 6 | SwarmMind no git repository | HIGH | SwarmMind | Already real — zero audit trail |
| 7 | Library SSR crash + infinite re-render | HIGH | Library | Trivial — page load triggers |
| 8 | No API auth on any Library route | HIGH | Library | Trivial — unauthenticated HTTP |
| 9 | Governance unenforced in runtime code | HIGH | All 4 | Structural — 7 Laws have no code |
| 10 | Private key material on disk with varying protection | HIGH | All 4 | Filesystem read |

---

## PART 2: OPERATOR QUESTIONS & ANSWERS

These are the questions you should be asking — derived from all findings across both review passes and the current session. Each question maps to one or more tasks.

### Q1: How do we unify the key ID derivation algorithm across all lanes?

**Answer:** Adopt the canonical-PEM SHA-256 method that Library already proved correct. This means:
1. Standardize on `SHA-256(canonical_pem)` where canonical_pem = PEM with headers stripped, whitespace normalized
2. Delete or redirect the 4 other derivation functions
3. Re-derive all key_ids in all trust stores using the canonical method
4. Re-generate identity snapshots with correct key_ids
5. Update the convergence conflict resolution to reflect that Library's proof was correct

**Task:** Create a `deriveKeyId(pem)` shared module, deploy to all lanes, run reconciliation.

### Q2: How do we eliminate the all-lane key compromise vector?

**Answer:** Remove `.runtime/lane-passphrases.json` immediately. Replace with one of:
- (a) Per-lane environment variables (`LANE_PASSPHRASE`) set by the operator per session
- (b) OS keyring integration (Windows Credential Manager, macOS Keychain)
- (c) Per-lane encrypted key files with separate passphrases, never colocated

**Task:** Delete the combined passphrase file. Implement per-lane passphrase injection via environment variable. Each lane reads `process.env.LANE_PASSPHRASE` at startup, never stores it.

### Q3: How do we make cross-lane communication actually authenticated?

**Answer:** Two-phase approach:
1. **Immediate (this session):** Wire `identity-enforcer.js` into all 4 inbox watchers in `enforce` mode (not `warn`). This rejects unsigned messages.
2. **Next phase:** Wire `Signer.js` into all outbound message paths. Every message written to any outbox must be signed before delivery.

**Task Phase 1:** Update all 4 inbox watchers to call identity-enforcer in enforce mode. Unsigned messages → `expired/`, not `processed/`.

**Task Phase 2:** Add signing step to `deliverMessage()`, `promote-release.ps1`, `reject-release.ps1`, and all outbox writers.

### Q4: How do we fix the fake evidence promotion vulnerability?

**Answer:** Three changes to `promote-release.ps1`:
1. **Require non-null metrics:** If `$metrics.metrics` is null or empty, exit with error — do not create convergence.json
2. **Add SHA-256 content checksums:** Hash every evidence file. Store hashes in convergence.json. Downstream consumers verify hashes.
3. **Fix "proven" definition:** On Windows without nsys, status must be `"proven_conditional"` or `"proven_minus_nsys"`, never `"proven"`. The RELEASE_CONTRACT.md definition of "proven = all 5" must not be redefined by code.

**Task:** Patch `promote-release.ps1` with content validation, checksum generation, and corrected status labeling.

### Q5: How do we fix the null metrics regression bypass?

**Answer:** In `run-benchmarks.ps1`:
1. After benchmark execution, check if `$result.metrics.latency_ms` is null → if so, set `regression_check.passed = false` with reason "no metrics produced"
2. Replace `$null -gt threshold` with explicit null check: `if ($null -eq $metrics) { FAIL }`
3. Remove baseline bypass for first runs — require a baseline file to exist, or require `--allow-first-run` flag

**Task:** Patch `run-benchmarks.ps1` with explicit null checks and first-run safeguard.

### Q6: How do we fix SwarmMind's lack of git?

**Answer:**
1. `cd S:/SwarmMind && git init && git add -A && git commit -m "initial: SwarmMind codebase"`
2. Resolve the path identity crisis: decide whether the canonical location is `S:/SwarmMind/` or `S:/SwarmMind Self-Optimizing Multi-Agent AI System/`. Update all AGENTS.md files to match.
3. Add `.gitignore` for `.identity/private.pem`, `.runtime/`, `node_modules/`

**Task:** Initialize git repo in S:/SwarmMind/, add .gitignore, make initial commit. Update canonical path in all lane AGENTS.md files.

### Q7: How do we fix the Library's critical frontend bugs?

**Answer:**
1. **SSR crash:** Add `typeof document === 'undefined' ? null : createPortal(...)` guard in SearchModal.tsx
2. **Infinite re-render:** Move force simulation out of useEffect + setState cycle. Use `useRef` for simulation state, only sync to React state on animation frame boundaries with a dirty flag.
3. **No auth:** Add middleware.ts with session token validation for all `/api/*` routes
4. **SQL injection:** Replace `LIKE '%term%'` with FTS5 full-text search or at minimum parameterized queries without leading wildcards

**Task:** Patch SearchModal.tsx, graph/page.tsx, add API middleware, replace LIKE queries.

### Q8: How do we make stableStringify consistent across lanes?

**Answer:**
1. Create a single `stableStringify.js` in a shared location (e.g., `S:/kernel-lane/src/attestation/stableStringify.js` as canonical)
2. All other copies become re-exports: `module.exports = require('path-to-canonical')`
3. Add tests: same input → same output across all 4 instances
4. Use this as the basis for key ID derivation (Q1)

**Task:** Canonicalize one stableStringify implementation, replace all copies with re-exports.

### Q9: How do we add file integrity protection for governance/config?

**Answer:**
1. Extend `post-compact-audit.js` to hash: AGENTS.md, .identity/keys.json, trust-store.json, config/targets.json, CONVERGENCE_PROTOCOL.md
2. Store hashes in `.compact-audit/FILE_HASHES.json`
3. On startup, compare current file hashes against stored hashes. Mismatch → quarantine + alert
4. Add pre-commit hooks (or at minimum pre-write checks) for these files

**Task:** Expand post-compact-audit hash coverage. Add startup integrity check.

### Q10: How do we actually enforce governance in runtime code?

**Answer:** This is the largest undertaking. The 7 Laws of GOVERNANCE.md have zero Node.js enforcement. Priority order:
1. **Invariant 1 (Veto = immediate halt):** Add veto detection to inbox watchers. If a message has `type: "escalation"` with veto payload, all watchers halt processing.
2. **Invariant 2 (Drift limit 20% = freeze):** Wire UDS scoring into a runtime check. If drift > 20%, write active-blocker.json and halt.
3. **Law 1 (5+ verification paths):** Currently impossible — SwarmMind verify bridge returns UNTESTED. Build real verification bridges.
4. **CPS dynamic adjustment:** Build the CPS calculator. Log events. Adjust authority dynamically.

This is a multi-session effort. Start with Invariants 1 and 2.

**Task:** Implement veto detection in all 4 inbox watchers. Implement drift threshold check in heartbeat cycle.

### Q11: How do we fix Archivist's unprocessed inbox backlog?

**Answer:** Archivist has ~37 unprocessed items. The inbox watcher exists but may not be running. Options:
1. Start the Archivist inbox watcher (it's a scheduled task that may be broken)
2. Manually triage: sort by priority, process P0 items first, archive stale P2/P3 items
3. Check if `schtasks` registration is still broken for Archivist (it was in the previous review)

**Task:** Run Archivist inbox watcher. Triage P0 items. Fix scheduled task registration if broken.

### Q12: How do we fix the trust store key_id mismatch?

**Answer:**
1. This is a consequence of Q1 (key ID derivation inconsistency)
2. Once the canonical algorithm is adopted, re-derive all key_ids
3. Replace trust-store.json entries with correctly-derived key_ids
4. Regenerate identity snapshots with matching key_ids
5. Verify continuity handshake passes with new key_ids

**Task:** After Q1 is complete, run trust store reconciliation across all lanes.

### Q13: How do we protect private key material uniformly?

**Answer:**
1. All `.identity/private.pem` files: chmod 600 (or Windows equivalent — restrict to user only)
2. `gen-archivist-key.js` must set file permissions on write
3. SwarmMind's private.pem must be gitignored AND file-permissioned
4. Never store passphrases in plaintext files
5. Long-term: move to OS keystore integration

**Task:** Set restrictive file permissions on all private.pem files. Fix gen-archivist-key.js to set permissions on creation. Add .gitignore entries.

### Q14: How do we fix the Library's zero test coverage?

**Answer:**
1. Add Vitest + @testing-library/react to Library
2. Priority tests: SearchModal SSR guard, graph page render cycle, API route input validation, schema validation
3. Add `npm test` to package.json scripts
4. Target: 50% coverage of critical paths within 2 sessions

**Task:** Install Vitest. Write tests for the 4 P0 bugs (SearchModal, graph page, search API, schema). These tests should fail before fixes and pass after.

### Q15: How do we resolve the SwarmMind path identity crisis?

**Answer:**
1. `S:/SwarmMind/` is the actual codebase (87 entries, real files)
2. `S:/SwarmMind Self-Optimizing Multi-Agent AI System/` is the canonical path per AGENTS.md but contains minimal stubs
3. Decision: canonicalize `S:/SwarmMind/` as the real path. The spaced path creates problems with schtasks, shell commands, and cross-lane references.
4. Update all AGENTS.md files to use `S:/SwarmMind/` as canonical
5. Consider migrating the stub content from the spaced path into the real repo, then archiving the spaced path

**Task:** Update canonical path in all AGENTS.md files to `S:/SwarmMind/`. Migrate any unique content from the spaced directory.

### Q16: How do we fix heartbeat schema compliance?

**Answer:**
1. Kernel's heartbeat uses `status: "alive"` — not in the allowed enum (pending|in_progress|done|failed|escalated|timed_out)
2. Library's heartbeat uses `status: "active"` — same issue
3. Both missing 17+ required v1.1 fields
4. Fix: generate heartbeat from the v1.1 schema template. Fill all required fields.

**Task:** Rewrite heartbeat generation in Kernel and Library to comply with v1.1 schema.

### Q17: How do we fix the "proven" status contradiction between code and contract?

**Answer:**
1. RELEASE_CONTRACT.md says "proven = all 5 evidence types present"
2. `promote-release.ps1` says "proven = all available evidence types" (4 of 5 on Windows)
3. Resolution: code must not redefine the contract. On Windows without nsys:
   - Status = `"provisional"` or `"proven_conditional"`
   - Add `evidence_types_missing: ["nsys_profile"]`
   - Document platform limitation explicitly in convergence.json
4. Alternatively: update RELEASE_CONTRACT.md to define a Windows-specific tier

**Task:** Patch promote-release.ps1 to use "provisional" status when nsys is missing. Update RELEASE_CONTRACT.md to define the tier.

### Q18: How do we add lease enforcement to all lanes?

**Answer:**
1. SwarmMind's lease implementation is the reference: `_canAcquire()`, `_acquire()`, `_renew()`, expiry check
2. Extract into a shared `file-lease-manager.js` module
3. Wire into Archivist, Library, and Kernel inbox watchers
4. Before processing any message, acquire lease. After processing, move to processed/ (which implicitly releases).

**Task:** Extract SwarmMind's lease logic into shared module. Integrate into 3 remaining watchers.

### Q19: How do we fix parse-failed messages going to processed/ instead of expired/?

**Answer:**
1. In Archivist's inbox-watcher.js (and any other lane with this pattern):
   - Change the catch block from `moveToProcessed()` to `moveToExpired()` or `moveToQuarantine()`
   - Log the parse error with the filename and error message
   - Do NOT treat a corrupt/unparseable message as successfully handled

**Task:** Patch all inbox watchers: parse failures → expired/ or quarantine/, never processed/.

### Q20: What is the minimum viable set of fixes to make this system trustworthy?

**Answer:** The following 8 fixes would eliminate the most critical attack surfaces:

| # | Fix | P0 | Effort |
|---|-----|-----|--------|
| 1 | Delete lane-passphrases.json, use env vars | Yes | Low |
| 2 | Unify key ID derivation to canonical-PEM | Yes | Medium |
| 3 | Wire identity enforcement to reject mode | Yes | Low |
| 4 | Patch promote-release.ps1 content validation | Yes | Medium |
| 5 | Patch run-benchmarks.ps1 null metrics check | Yes | Low |
| 6 | Initialize git in SwarmMind | No (P1) | Low |
| 7 | Fix Library SSR crash + infinite re-render | Yes | Low |
| 8 | Set file permissions on all private.pem | Yes | Low |

These 8 fixes close the most dangerous attack paths: key compromise, message forgery, fake evidence, and the most visible frontend crashes. Everything else is important but secondary.

---

## PART 3: TASK EXECUTION PLAN

### Priority Order (P0 first, then P1, by feasibility)

| Phase | Task | Question | Files to Modify | Estimated Effort |
|-------|------|----------|----------------|-----------------|
| 1 | Delete lane-passphrases.json | Q2 | S:/Archivist-Agent/.runtime/lane-passphrases.json | 5 min |
| 2 | Unify key ID derivation | Q1, Q8, Q12 | KeyManager.js, canonical-trust-resolver.js, sign-outbox-message.js, create-signed-message.js, identity-self-healing.js, stableStringify copies | 60 min |
| 3 | Wire identity enforcement to reject mode | Q3 | All 4 inbox watchers | 30 min |
| 4 | Patch promote-release.ps1 | Q4, Q17 | S:/kernel-lane/scripts/promote-release.ps1 | 30 min |
| 5 | Patch run-benchmarks.ps1 | Q5 | S:/kernel-lane/scripts/run-benchmarks.ps1 | 15 min |
| 6 | Fix Library SSR crash | Q7 | S:/self-organizing-library/src/components/SearchModal.tsx | 10 min |
| 7 | Fix Library infinite re-render | Q7 | S:/self-organizing-library/src/app/graph/page.tsx | 15 min |
| 8 | Set file permissions on private.pem | Q13 | All .identity/private.pem files | 10 min |
| 9 | Initialize git in SwarmMind | Q6 | S:/SwarmMind/ | 10 min |
| 10 | Resolve SwarmMind path | Q15 | All AGENTS.md files | 20 min |
| 11 | Fix parse-failed message routing | Q19 | All inbox watchers | 15 min |
| 12 | Fix heartbeat schema | Q16 | Kernel + Library heartbeat generators | 20 min |
| 13 | Add file integrity checks | Q9 | post-compact-audit.js | 30 min |
| 14 | Fix Library API auth | Q7 | S:/self-organizing-library/src/middleware.ts | 30 min |
| 15 | Add Library tests | Q14 | S:/self-organizing-library/ | 60 min |

---

## Convergence Gate

```json
{
  "claim": "Unified 4-lane code review completed with 136 findings (13 P0) and 20 operator questions with actionable answers and execution plan",
  "evidence": "docs/UNIFIED_REVIEW_AND_QA_2026-04-23.md",
  "verified_by": "self",
  "contradictions": [
    "Key ID derivation: 5 algorithms produce different results for same key (root cause of convergence conflict)",
    "RELEASE_CONTRACT.md defines proven=5of5, promote-release.ps1 gives proven=4of5 on Windows",
    "Library AGENTS.md says kernel-lane canonical path, actual directory is kernel"
  ],
  "status": "proven"
}
```
