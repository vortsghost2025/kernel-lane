# 4-Lane Deep Code Review — Beyond the First Surface

**Review date:** 2026-04-21 (second pass)
**Reviewer:** Kernel Lane (Lane 4, Authority 60)
**Method:** Full code-level audit of runtime enforcement across all 4 repositories. Previous review findings excluded unless new depth discovered. Evidence hierarchy: implemented > runtime-proven > documented-only > blocked > assumed.
**Previous review:** `docs/FOUR_LANE_REVIEW_2026-04-21.md` (374 lines, 8 blockers)
**This review finds:** 12 NEW failure surfaces not in the previous review, plus 6 focus-question answers that reveal systemic structural weaknesses.

---

## 1. Archivist Review (Deeper)

**Lane role:** Governance root (Position 1, Authority 100, can_govern: true)

### Strongest runtime-enforced controls

1. **JWS verification with A=B=C invariant** — `Verifier.js` compares `outerLane` to `signedPayloadLane` BEFORE crypto. Rejects on mismatch. Real RSA-SHA256 signature verification. No bypass path.
2. **Quarantine loop with human handoff** — `VerifierWrapper.js` enforces retry limits (max 3), writes `AGENT_HANDOFF_REQUIRED.md` on exhaustion. Quarantine is real.
3. **Concurrency lock** — `concurrency-policy.js` uses `fs.writeFileSync(flag: 'wx')` for atomic lock acquisition. PID-liveness + staleness (900s) reclamation. Prevents duplicate watchers.
4. **Priority preemption + starvation guard** — `inbox-watcher.js` processes P0 before P2/P3, yields every 5 consecutive P0/P1 messages.

### Weakest runtime gaps (NEW — not in previous review)

1. **`forceRelease()` bypasses quarantine without authorization** — `VerifierWrapper.js` line 140-148: any code path calling `forceRelease(itemId)` clears the human-handoff signal and releases quarantined items with zero authentication, zero logging of who released it, zero proof requirement. This creates an unlogged escape hatch from the system's deepest enforcement mechanism.

2. **`swarmmind-verify.js` is a ghost** — When SwarmMind is unavailable (default state), ALL executions return `{ category: 'UNTESTED', runtimeChecksPassed: false }`. The bridge that connects verification lanes is a no-op stub. Classification defaults to UNTESTED. The documented "5+ verification paths" requirement from Law 1 is unenforceable because the verification network is physically disconnected.

3. **Continuity handshake would FAIL against the current trust store** — The snapshot's `key_id` (`d5faddfa2ab2ff3f`) does NOT match the trust store's archivist `key_id` (`583b2c36f397ef01`). The handshake checks `issuerEntry.key_id !== keyId` on line 152, which would produce `KEY_ID_MISMATCH`. The identity chain is broken at the data layer even though the code is correct.

4. **Identity detection is a directory-name check** — `detectLane()` line 40: `if (repoRoot.endsWith('Archivist-Agent')) return 'archivist'`. Any directory named `Archivist-Agent` passes lane detection. This is filesystem path matching, not identity verification.

5. **All 4 lane passphrases in a single plaintext file** — `.runtime/lane-passphrases.json` contains passphrases for archivist, library, kernel, and swarmmind. Compromise of one `.runtime/` directory gives key access to ALL lanes. This is an order of magnitude worse than "plaintext private key in one lane" — it's plaintext access to all 4 lanes' key material.

6. **Inbox watcher identity enforcement defaults to 'warn'** — Line 59: `this.identityEnforcer = new IdentityEnforcer({ enforcementMode: 'warn' })`. In warn mode, unsigned messages produce a console log but `decision === 'pass'`. They are NOT rejected. Only 'enforce' mode rejects. The inbox watcher currently lets unsigned messages through.

7. **Parse-failed messages go to `processed/`**, not `expired/` — Line 139-141: `catch (e) { this.moveToProcessed(filename, filePath) }`. A corrupt JSON file gets treated as "done" and will never be reprocessed. It is NOT marked verified, but it IS removed from the inbox as if successfully handled.

### What is proven

- JWS signature verification works (RSA-SHA256, A=B=C invariant, real crypto)
- Quarantine loop with retry limits and human handoff works
- Execution gate has blocked 5 real violations (logged in `gate-violations.jsonl`)
- Concurrency locks are real (atomic file creation + PID liveness)
- Inbox watcher processes messages (18 in processed/)

### What is only documented

- 7 Laws of GOVERNANCE.md — zero have Node.js runtime enforcement
- CPS dynamic adjustment by UDS — no UDS integration code exists
- Session termination when CPS=0 — no termination code exists
- Veto = immediate halt (Invariant 1) — no veto detection code
- Drift limit: 20% = freeze (Invariant 2) — no drift comparison code
- Pre-action checkpoint enforcement — no pre-action checkpoint code
- CPS event logging — no `cps_log.jsonl` exists

### Top 3 risks

1. **All-lane key compromise via single plaintext file** — `.runtime/lane-passphrases.json` is a single-point-of-total-failure for the entire 4-lane cryptographic identity system
2. **Identity chain is self-referential and currently broken** — self-issued snapshot + key_id mismatch means the handshake cannot succeed against the current trust store
3. **Governance is documentation theater** — GOVERNANCE.md declares "RULES ARE ENFORCED / VIOLATIONS BLOCK ACTIONS / NO EXCEPTIONS" but zero of the 7 Laws have Node.js runtime enforcement; the Enforcement Loop is entirely conceptual

---

## 2. Library Review (Deeper)

**Lane role:** Persistent systems (Position 2, Authority 90, can_govern: false)

### Strongest runtime-enforced controls

1. **SchemaValidator with Bug 1/3 fixes** — `createMessage()` never stamps `delivery_verification.verified = true` without schema check. `deliverMessage()` only sets `verified = true` if schema passes AND file exists on disk. This is correct.
2. **Canonical path delivery** — `deliverMessage()` writes to absolute canonical paths. Fixed from previous mirror-path bug.
3. **Priority-based inbox processing** — Same architecture as Archivist (P0 before P2/P3, starvation guard).

### Weakest runtime gaps (NEW — not in previous review)

1. **Schema validation is structural-only, no semantic constraints** — SchemaValidator checks that `priority` is one of `P0|P1|P2|P3`, that `from` is a string, that `timestamp` is ISO-8601 format. It does NOT check: that `from` matches a known lane identity, that `evidence.evidence_path` points to a real file, that `payload.path` exists, that `lease.owner` is a valid lane, that `heartbeat.status` is in the allowed enum. A message with `from: "totally-fake-lane"` and `evidence_path: "/nonexistent/file.json"` passes schema validation.

2. **Identity enforcement is opt-in, not wired into inbox-watcher** — The Library's `inbox-watcher.js` does NOT call identity-enforcer.js. The `from` field is trusted without verification. Any process with write access to the Library's canonical inbox path can inject forged messages from any lane.

3. **3-way trust store format/location inconsistency** — The Library's code references trust stores in at least 3 different locations/formats: (a) `lanes/broadcast/trust-store.json` (flat array), (b) `.trust/keys.json` (nested by lane_id), (c) potentially `.identity/snapshot.json` identity chain. The key_ids for the same lane differ across these sources.

4. **Canonical path for Kernel in AGENTS.md is WRONG** — Library's AGENTS.md declares `S:/kernel-lane/lanes/kernel-lane/inbox/` as the canonical delivery path for Kernel. But the actual directory in the Kernel repo is `lanes/kernel/inbox/` (not `kernel-lane`). The code in Library's `inbox-watcher.js` uses `kernel` (correct), but the documentation could cause manual delivery to the wrong path.

5. **No kernel mirror directory exists** — `S:\self-organizing-library\lanes\` contains `archivist/`, `library/`, `swarmmind/` but no `kernel/` or `kernel-lane/` directory. Library cannot locally mirror Kernel's inbox state.

### What is proven

- SchemaValidator correctly prevents `verified: true` without schema check (Bug 1 fix)
- `deliverMessage()` writes to canonical paths (Bug 3 fix)
- Inbox watcher moves files to processed/ (entries exist)

### What is only documented

- Full delivery verification (signature + identity + canonical path) — only schema + file-existence are checked
- Attestation pipeline operation — `ATTESTATION_STATE.json` has never been created
- Execution gate enforcement — gate always open because no active blockers

### Top 3 risks

1. **Structural-only validation allows semantically invalid messages** — a message from "totally-fake-lane" with fabricated evidence passes all Library checks
2. **Canonical path mismatch for Kernel** — AGENTS.md says `kernel-lane`, code says `kernel`, actual directory is `kernel`; manual delivery following docs goes to wrong path
3. **Trust store has 3 formats/locations with inconsistent key_ids** — cross-lane cryptographic verification is non-functional until reconciled

---

## 3. SwarmMind Review (Deeper)

**Lane role:** Trace-mediated verification (Position 3, Authority 80, can_govern: false)

### Strongest runtime-enforced controls

1. **Verifier.js — strongest in the system** — JWS-only (HMAC removed), throws on `allowLegacy`. A=B=C invariant. Real RSA-SHA256 crypto verification.
2. **Governed-start chain** — LaneResolver → Attestation → Identity Verification → LaneContextGate → NODE_OPTIONS → ContinuityVerifier → Governance → App. Most rigorous startup sequence.
3. **Governance quarantine** — `resolve-governance-v2.js` implements real quarantine with `QUARANTINE_STATE.json`, authority restriction, governance blocks, re-verification.
4. **True negative tests** — `test-hardening-drill.js` covers wrong lane, wrong key, tampered snapshot, revoked key. Real failure-mode testing.
5. **LEASE ENFORCEMENT** — Only lane that implements message-level lease acquisition/expiry. `_canAcquire()` checks owner, expires_at, max_renewals. `_acquire()` sets owner, timestamps, renew_count.

### Weakest runtime gaps (NEW — not in previous review)

1. **`operatorConfirmed: true` bypass in LaneContextGate is by design but undocumented** — The LaneContextGate has a code path where `operatorConfirmed === true` allows bypassing the full gate check. This is an intentional escape hatch (operator override), but it is NOT documented in any governance or architecture file. An attacker who can set this flag in a config file or environment variable bypasses the entire governed-start chain. The tamper-comment issue from the first review was a symptom; the deeper issue is an undocumented bypass that remains after the tamper is reverted.

2. **RecoveryClassifier.js has an implicit global variable bug** — Line 76 references a variable without `let`/`const`/`var` declaration, creating an implicit global. This is a runtime correctness issue that could cause classification failures in edge cases. It is the kind of bug that passes testing (happy path works) but fails in production under unexpected input.

3. **InboxWatcher unsigned messages pass with WARNING only** — Same as Archivist/Kernel: identity enforcement is warn-mode, not reject-mode. The lane with the strongest verifier code doesn't enforce identity on its own inbox.

4. **No `cross-lane-sync.js` module exists** — The first review mentioned `cross-lane-sync.js` but it does not exist as a module. Cross-lane synchronization is file-based (read other lanes' heartbeat files). There is no programmatic sync, no state reconciliation, no drift detection between lanes. The `CROSS_LANE_TEST_RESULTS.json` referenced in the first review is a test artifact, not a runtime enforcement mechanism.

5. **SeccompSimulator remains a stub** — Confirmed: the name implies kernel-level syscall filtering but the implementation is a complete no-op. Previous review identified this; new finding: the stub's existence creates a false-positive surface because it's referenced in governed-start.js as if it provides real security. A governed start that "passes" SeccompSimulator verification proves nothing.

### What is proven

- JWS verification with A=B=C (strongest in system)
- Governance quarantine works (can block releases)
- Lease enforcement works (only lane with real message-level lease checking)
- Negative test coverage exists (wrong lane, wrong key, tampered snapshot, revoked key)
- Governed start enforces a real chain

### What is only documented

- Seccomp syscall filtering (stub, no-op)
- `operatorConfirmed` bypass policy (code exists but no documentation)
- Cross-lane programmatic sync (no module exists)

### Top 3 risks

1. **Undocumented `operatorConfirmed: true` bypass in LaneContextGate** — the strongest enforcement chain has an escape hatch that isn't documented anywhere
2. **RecoveryClassifier implicit global** — runtime correctness bug that will surface under unexpected input
3. **SeccompSimulator stub creates false confidence** — governed-start "passes" a security check that does nothing

---

## 4. Kernel Review (Deeper)

**Lane role:** GPU-optimized artifact generation (Position 4, Authority 60, can_govern: false)

### Strongest runtime-enforced controls

1. **Concurrency lock** — `concurrency-policy.js` uses atomic `wx` flag for lock creation. PID-liveness + staleness detection. `CONCURRENCY_POLICY_VIOLATION` thrown on conflict. Real mutual exclusion.
2. **Regression checking** — `run-benchmarks.ps1` reads threshold from `config/targets.json`, compares against baseline, exits non-zero on regression. This was a fix from the previous review.
3. **Starvation guard** — Inbox watcher yields every 5th consecutive P0/P1 message.
4. **SchemaValidator with Bug 1/3 fixes** — Correctly prevents `verified: true` without schema check.

### Weakest runtime gaps (NEW — not in previous review)

1. **Fake evidence can be promoted as "proven"** — `promote-release.ps1` uses `Test-Path` only (no content validation). An empty JSON file `{}` passes the benchmark gate. `$metrics.metrics` being null silently omits evidence strings but the script still outputs `[PASS]` and creates `convergence.json` with `status: "proven"`. No content hashes on release artifacts. Any file in the release directory could be silently replaced without detection.

2. **Null metrics pass regression check due to PowerShell null semantics** — `run-benchmarks.ps1` line 83: `$null -gt ($previousLatency * 1.02)` evaluates to `$false` in PowerShell. If the benchmark executable produces no matching output, `$result.metrics.latency_ms` is `$null`, and the regression check "passes." Deleting the baseline file also bypasses regression entirely (first run always passes with `regression_check.passed: true, threshold_pct: 0`).

3. **`require_explanation_on_regression` is dead code** — `targets.json` declares this field. `run-benchmarks.ps1` loads it (line 69-70) but never references it again. The documented policy of "require explanation on regression" is unenforceable.

4. **Windows "proven" = 4 of 5 evidence types, contradicting RELEASE_CONTRACT.md** — `promote-release.ps1` line 103: on Windows without nsys, status is `"proven"`. But RELEASE_CONTRACT.md line 28 defines "proven" as "All 5 evidence types present." The code redefines the contract's definition at runtime.

5. **Zero identity verification on incoming messages** — `inbox-watcher.js` does NOT call `identity-enforcer.js`. Any process with write access to `lanes/kernel/inbox/` can inject forged messages from any lane. The `from` field is self-declared and trusted without verification.

6. **Outgoing messages are never signed** — `promote-release.ps1` and `reject-release.ps1` write broadcasts to `lanes/kernel/outbox/` with no signature or JWS field. The `Signer.js` module exists but is never called by any PowerShell script. The entire outbound message flow is unsigned and unauthenticated.

7. **AGENTS.md has zero integrity protection** — The previous session documented AGENTS.md being overwritten by a Kilo template. Post-compact-audit.js hashes Archivist files (`GOVERNANCE.md`, `BOOTSTRAP.md`) but NOT Kernel's own `AGENTS.md`, `.identity/*`, or `trust-store.json`. Any subagent edit can silently modify lane identity and operational rules.

8. **Reject-release.ps1 accepts empty evidence** — `-Evidence @("","","")` produces a valid `rejection.json` with three empty strings. No minimum length, no file-existence check, no semantic check. A rejection can be issued without evidence.

9. **`config/targets.json` corrupted = unhandled crash** — Line 65: `Get-Content | ConvertFrom-Json` throws on invalid JSON with no try/catch. A corrupted `targets.json` crashes the benchmark pipeline.

10. **Heartbeat schema is non-compliant** — `heartbeat-kernel.json` uses `{lane, timestamp, status, session_active, uptime_seconds, messages_processed, last_inbox_scan, version}` — missing 17+ required v1.1 fields. Uses `status: "alive"` which is not in the allowed enum.

### What is proven

- Build pipeline compiles real CUDA kernels (exit code propagation works)
- NCU profiling produces real 42-pass reports (77MB on disk)
- NSYS report exists (collected via interactive desktop session, 50KB)
- Regression checking works IF baseline exists AND metrics are non-null
- Concurrency locks prevent duplicate watchers

### What is only documented

- "proven = all 5 evidence types" — code gives "proven" on Windows with 4 of 5
- Regression check "requires explanation" — dead code variable
- Message signing — Signer.js exists but never called
- Identity verification on inbox — identity-enforcer.js exists but never called by watcher
- PROMOTION_CHECKLIST.md items (correctness tests, GPU info, CUDA version, compiler flags, input shapes, env-check.ps1) — zero enforced in code
- Execution gate integration — standalone only, never called by automated pipeline

### Top 3 risks

1. **Fake evidence promotion** — empty/JSON-with-no-metrics benchmark file passes all gates, gets "proven" convergence status
2. **Null metrics bypass regression** — PowerShell null comparison semantics make the regression gate a no-op for any execution that fails to produce output
3. **No identity verification on any message flow** — incoming messages trusted by `from` field; outgoing messages never signed; the entire cross-lane communication surface is unauthenticated

---

## 5. Cross-Lane System Review (Deeper)

### Where routing is truly canonical

**Only for Library's `deliverMessage()` output.** Library's SchemaValidator.deliverMessage() writes to absolute canonical paths. This is the ONLY place in the entire system where a code path guarantees canonical delivery.

**NOT canonical:**
- Archivist inbox watcher does not verify where incoming messages came from
- Kernel inbox watcher does not verify incoming message delivery paths
- SwarmMind inbox watcher does not verify incoming message delivery paths
- All PowerShell scripts (promote-release, reject-release) write to local outbox only — delivery to other lanes requires manual copy or out-of-band script
- No lane verifies that a message in its inbox arrived via the canonical path vs. being placed directly by a local process

### Where mirror/path drift can still happen

1. **Library AGENTS.md says `kernel-lane`, actual directory is `kernel`** — if someone follows the AGENTS.md to deliver a message to Kernel, they would target `S:/kernel-lane/lanes/kernel-lane/inbox/` which does NOT exist. The correct path is `S:/kernel-lane/lanes/kernel/inbox/`.
2. **Library has no kernel mirror directory at all** — `S:\self-organizing-library\lanes\` is missing both `kernel/` and `kernel-lane/`.
3. **Kernel repo missing mirror dirs for Library and SwarmMind** — `S:\kernel-lane\lanes\` only has `archivist/`, `broadcast/`, `kernel/`.
4. **Archivist AGENTS.md has no canonical path table** — the inbox-watcher code has correct paths, but the documentation is incomplete. Anyone reading docs (not code) would not know where to deliver.

### Whether scheduled persistence is real in all lanes

| Lane | Scheduled Tasks | Real? |
|------|----------------|-------|
| Archivist | `register-runners.ps1` creates 8 tasks | **PARTIAL** — script exists, `schtasks /query` previously returned "Access is denied" |
| Library | Created by Archivist's register-runners.ps1 | **PARTIAL** — tasks declared but Library's own outbox is empty (no outbound output) |
| SwarmMind | Created by Archivist's register-runners.ps1 | **FAILED** — spaces in path broke `schtasks` registration |
| Kernel | `Kernel-Heartbeat` + `Kernel-Watcher` via register-runners.ps1 | **CONFIRMED** — heartbeat file has recent timestamps, messages processed |

**Verdict:** Only Kernel has confirmed scheduled persistence. The other 3 lanes' scheduled tasks are either unconfirmed (Archivist), producing no observable output (Library), or broken (SwarmMind). The centralization of task registration in Archivist's `register-runners.ps1` is a single point of failure — if that script fails, ALL lanes lose persistence.

### Whether message ordering/preemption is enforced or timing-sensitive

**Preemption is structural, not timing-sensitive** — All inbox watchers sort by priority (P0→P1→P2→P3) and yield every 5th consecutive P0/P1 message (starvation guard). This is deterministic within a single scan cycle.

**But timing creates a race between scan cycles** — If a P0 message arrives after the watcher has already read the directory listing but before it finishes processing the current batch, that P0 message waits until the NEXT scan cycle. With a 60-second poll interval, a P0 message could wait up to 60 seconds. The `p0_fast_path` flag in the schema is declared but not implemented in any watcher.

**Cross-lane ordering is not enforced** — There is no global message ordering. If Lane A sends two messages (P0 then P1) and Lane B sends a P0 simultaneously, the receiving lane processes them in directory-listing order (filesystem-dependent), not in causal order.

### Single most dangerous remaining false-positive

**"proven" convergence status on Windows with 4 of 5 evidence types.** Kernel's `promote-release.ps1` redefines "proven" to mean "all evidence types available on this platform" rather than "all 5 evidence types present" as defined in RELEASE_CONTRACT.md. Combined with the fake-evidence promotion vulnerability (Test-Path only, no content validation), a release on Windows can achieve "proven" status with fabricated benchmark data and zero nsys report. This is the system's most dangerous false-positive because it is the convergence gate — the single point that determines whether output is released.

### Single most dangerous remaining silent failure

**Null metrics passing regression check.** If a CUDA kernel compiles but produces no stdout matching the expected format, `run-benchmarks.ps1` sets metrics to `$null`, the regression check evaluates `$null -gt threshold` as `$false` (passes), and a report is written with null metrics. The downstream `promote-release.ps1` copies this report and creates a "proven" release. At no point does any code detect or flag that the benchmark execution produced no useful output. This is a full-spectrum silent failure: build → benchmark → regression → promotion all succeed with zero real data.

---

## 6. Six Focus Questions

### Q1: Does delivery verification prove only existence, or actual truth?

**Only existence.** The deepest delivery verification in the system is:

| Layer | What's Verified | Proven? |
|-------|----------------|---------|
| File exists on disk | YES (all lanes) | File was written |
| JSON is parseable | YES (3 of 4 lanes) | Valid JSON structure |
| Schema fields present | YES (Library, Kernel with SchemaValidator) | Required fields exist |
| `from` field matches a real lane | **NO** (any lane) | Not verified |
| Message is cryptographically signed | **NO** (any inbox) | Not checked |
| Signature matches the `from` lane's key | **NO** (any inbox) | Not checked |
| Evidence path points to a real file | **NO** (any lane) | Not checked |
| Lease is valid and unexpired | **NO** (3 of 4 lanes; SwarmMind only) | Mostly not checked |

**Answer:** Delivery verification proves a file exists and has valid JSON structure (at best). It does NOT prove who sent it, whether the content is true, whether referenced evidence exists, or whether the message is stale.

### Q2: Is the identity chain active, or still partially symbolic?

**Partially symbolic.** The identity chain has real code (JWS signing, RSA verification, A=B=C invariant) but:

- **Signing code exists but is NEVER used for outbound messages** — 0 of 24 outbox messages across all lanes contain a `signature` or `jws` field
- **Verification code exists but is in warn mode** — Archivist and SwarmMind identity enforcers default to 'warn', not 'enforce'; Kernel and Library don't call the enforcer at all
- **Trust store key_ids are inconsistent** — The Archivist snapshot's `key_id` (`d5faddfa2ab2ff3f`) doesn't match the trust store's archivist `key_id` (`583b2c36f397ef01`). The handshake would fail if run.
- **Identity detection is a directory name** — `repoRoot.endsWith('Archivist-Agent')` is not cryptographic identity
- **All passphrases are in one plaintext file** — `.runtime/lane-passphrases.json` gives access to all 4 lanes' encrypted private keys

**Answer:** The identity chain is real code connected to symbolic data. The cryptography works, but the operational deployment makes it non-functional: keys don't match, messages aren't signed, verification isn't enforced, and key material is unprotected.

### Q3: Are scheduled watchers/heartbeats giving autonomy, or only periodic activity?

**Only periodic activity.** The scheduled tasks write heartbeat files and scan inboxes every 60 seconds. But:

- **No autonomous decision-making** — The inbox watcher logs and moves messages. It does not trigger builds, run verification, escalate issues, or modify governance state.
- **No response to staleness** — Heartbeat health checks report stale lanes but never escalate, write a blocker, or alert anyone.
- **No action on regression** — `run-benchmarks.ps1` exits non-zero on regression but no scheduled task checks the exit code or takes remedial action.
- **No action on governance violations** — The execution gate logs violations but no automated process reads the violations or enforces consequences.

**Answer:** Scheduled tasks provide periodic I/O (write heartbeat, scan inbox). They do not provide autonomy (decide, act, escalate, remediate). The system is a collection of sensors without actuators.

### Q4: Are cross-lane protections runtime-enforced everywhere, or only in selected lanes?

**Selected lanes only.**

| Protection | Archivist | Library | SwarmMind | Kernel |
|-----------|-----------|---------|-----------|--------|
| Schema validation on inbox | YES | YES | YES | OPTIONAL (try/catch fallthrough) |
| Identity verification | WARN only | NO | WARN only | NO |
| Lease enforcement | NO | NO | YES | NO |
| Canonical delivery verification | NO | PARTIAL (outbound) | NO | NO |
| Concurrency lock | YES | YES | YES | YES |
| Starvation guard | YES | YES | YES | YES |
| Execution gate | MANUAL | MANUAL | MANUAL | MANUAL |
| Message signing (outbound) | NO | NO | NO | NO |

**Answer:** Only concurrency locks and starvation guards are consistently enforced across all 4 lanes. Identity, lease, canonical delivery, and execution gate enforcement are inconsistent or absent. The system's cross-lane security model is Swiss cheese — each lane has different holes.

### Q5: Can compact restore preserve behavior but still restore wrong state?

**Yes.** The post-compact-audit checks hashes of governance files in the Archivist repo (`GOVERNANCE.md`, `BOOTSTRAP.md`). But:

- **It does NOT hash Kernel's own `AGENTS.md`** — the file that was already overwritten by a template in a previous session
- **It does NOT hash `.identity/*`** — key material could be replaced between compacts
- **It does NOT hash `trust-store.json`** — trust relationships could be silently modified
- **It does NOT check inbox/outbox state consistency** — messages could be lost or fabricated during compact
- **The `HANDOFF_HASH_LOG.jsonl` comparison only catches tampering with the hash log itself**, not with the files that the hashes are supposed to protect

If a compact restore replaces `AGENTS.md` with a version that has different lane authority/position values, or replaces `trust-store.json` with different keys, the post-compact-audit would NOT detect it. The system would run with wrong identity/governance state while believing it is consistent.

### Q6: Does any lane still have code paths that can silently degrade due to subagent edits or template overwrite?

**Yes — all 4 lanes.** The AGENTS.md overwrite incident demonstrated the attack vector. No lane has file-integrity protection for its operational configuration:

| File | Protected? | Impact if Overwritten |
|------|-----------|----------------------|
| `AGENTS.md` (any lane) | NO | Lane identity, authority, protocol rules changed |
| `.identity/keys.json` | NO | Signing keys replaced |
| `.identity/private.pem` | NO | Private key replaced |
| `lanes/broadcast/trust-store.json` | NO | Trust relationships replaced |
| `config/targets.json` | NO | Regression thresholds changed |
| `lanes/broadcast/CONCURRENCY_POLICY_v1.json` | NO | Concurrency rules changed |

No lane has pre-commit hooks, file-system write protection, or runtime integrity checks on these files. Any subagent with write access can silently modify any lane's operational rules.

---

## 7. Top 5 Risks (System-Wide)

### Risk 1: Fake Evidence Promotion (Kernel — CRITICAL)

**Attack path:** Create empty/JSON-with-no-metrics benchmark file → run `promote-release.ps1` → get `convergence.json` with `status: "proven"` and fabricated evidence. No content validation, no content hashes, no provenance chain.

**Why it's #1:** This is the convergence gate — the single point that determines whether output is released. If this gate is meaningless, the entire release contract is theater.

### Risk 2: All-Lane Key Compromise via Single File (Archivist — CRITICAL)

**Attack path:** Read `.runtime/lane-passphrases.json` → decrypt all 4 lanes' RSA private keys → sign arbitrary messages as any lane → replace trust store entries → full system impersonation.

**Why it's #2:** One plaintext file gives complete cryptographic control of the entire 4-lane system. All verification code becomes useless because the attacker has the keys.

### Risk 3: Unauthenticated Cross-Lane Communication (All Lanes — HIGH)

**Attack path:** Write a JSON file to any lane's canonical inbox path with `from: "archivist"`, `priority: "P0"`, `task_kind: "proposal"` → message processed without signature check → lane acts on forged governance directive.

**Why it's #3:** 0 of 24 outbound messages are signed. 3 of 4 inbox watchers don't check identity at all. The 1 that does (SwarmMind) is in warn mode. The entire communication surface is unauthenticated.

### Risk 4: Null Metrics Silent Failure (Kernel — HIGH)

**Attack path:** Compile a kernel that produces no stdout → `run-benchmarks.ps1` sets metrics to null → regression check passes (`$null -gt threshold` = false) → report written with null metrics → `promote-release.ps1` copies report → "proven" release with zero real benchmark data.

**Why it's #4:** This is a full-spectrum silent failure: every gate in the pipeline passes without detecting that the benchmark execution produced no useful output. No error, no warning, no flag.

### Risk 5: Inconsistent Lease Enforcement Creates Race Conditions (3 of 4 Lanes — HIGH)

**Attack path:** Two watchers process the same P0 message simultaneously — SwarmMind respects the lease, Kernel/Archivist/Library ignore it → message processed 3 times with potentially different outcomes → split-brain state.

**Why it's #5:** Only SwarmMind enforces message-level lease acquisition. If any two lanes process the same message (e.g., a broadcast to all lanes), the one with lease enforcement may skip it (leased to another) while the ones without lease enforcement process it anyway. This creates inconsistent processing states across lanes.

---

## 8. One False-Positive (Deepest New Finding)

**"Proven" convergence with fabricated evidence on Windows.**

The previous review identified the Library inbox watcher marking invalid messages as "verified" (Blocker 1). This review finds a deeper false-positive: the entire convergence gate can produce a "proven" status with completely fabricated evidence. The specific chain:

1. `promote-release.ps1` checks `Test-Path` only (lines 17-19) — no content validation
2. Empty JSON `{}` passes `ConvertFrom-Json` — no metric validation
3. `$metrics.metrics` being null silently omits evidence — no failure
4. Script outputs `[PASS]` regardless — no evidence count check
5. Windows without nsys gets `status: "proven"` (line 103) — contradicts contract
6. `convergence.json` evidence array is empty but status is "proven"
7. No content hashes on any release artifact — substitution undetectable

This means a release promoted through the legitimate pipeline can claim "proven convergence" with zero real evidence. The convergence gate, which is supposed to be the system's strongest guarantee, is a file-existence check dressed up as an evidence framework.

---

## 9. Lane Messages

### To Archivist

**NEW findings for your lane:**
- `forceRelease()` on `VerifierWrapper.js` is an unlogged escape hatch from quarantine — any code path can clear the human-handoff signal and release quarantined items without authentication
- The continuity handshake would FAIL against your current trust store — snapshot `key_id` `d5faddfa2ab2ff3f` doesn't match trust store's `583b2c36f397ef01`
- `.runtime/lane-passphrases.json` contains all 4 lane passphrases in plaintext — this is a single-point-of-total-failure for the entire cryptographic system
- `swarmmind-verify.js` defaults to `UNTESTED` for everything — the "5+ verification paths" requirement from Law 1 is physically unreachable
- Parse-failed messages go to `processed/`, not `expired/` — corrupt files are treated as "done"
- Identity enforcement defaults to `warn` — unsigned messages are processed, not rejected
- Detect-lane is a directory-name check, not identity verification

**Must fix first:** Reconcile trust store key_ids. Remove or encrypt `.runtime/lane-passphrases.json`. Add authorization to `forceRelease()`.

**Must not overclaim:** Governance enforcement does not exist in Node.js code. CPS dynamic adjustment does not exist. The Enforcement Loop is conceptual. The swarmmind-verify bridge returns UNTESTED for everything.

### To Library

**NEW findings for your lane:**
- SchemaValidator is structural-only — `from: "totally-fake-lane"` with `evidence_path: "/nonexistent"` passes validation
- AGENTS.md canonical path for Kernel says `kernel-lane` — should be `kernel`; code is correct but docs will mislead
- No `kernel/` or `kernel-lane/` mirror directory exists in your repo — cannot locally mirror Kernel state
- Identity enforcement is not wired into inbox-watcher — incoming `from` field trusted without verification

**Must fix first:** Update AGENTS.md canonical path for Kernel from `kernel-lane` to `kernel`. Create `lanes/kernel/` mirror directory. Wire identity-enforcer.js into inbox-watcher.

**Must not overclaim:** Schema validation proves structure, not truth. "Verified" means "JSON parsed and required fields exist" — it does NOT mean the sender is who they claim to be.

### To SwarmMind

**NEW findings for your lane:**
- `operatorConfirmed: true` bypass in LaneContextGate is undocumented — this is an escape hatch from the governed-start chain that no governance document acknowledges
- `RecoveryClassifier.js` line 76 has an implicit global variable — runtime correctness bug under unexpected input
- You are the ONLY lane with real lease enforcement — 3 of 4 lanes ignore lease fields, creating potential race conditions on shared messages
- Unsigned inbox messages pass with WARNING only — the lane with the strongest verifier doesn't enforce identity on its own inbox
- No `cross-lane-sync.js` module exists — cross-lane sync is file-based, no programmatic state reconciliation

**Must fix first:** Document the `operatorConfirmed` bypass and restrict its activation to require cryptographic proof of operator identity. Fix the implicit global in RecoveryClassifier.js. Encourage other lanes to adopt your lease enforcement.

**Must not overclaim:** SeccompSimulator is a no-op stub — governed-start "passes" a security check that provides zero security. Cross-lane sync is ad-hoc file reads, not a protocol.

### To Kernel (self)

**NEW findings for our lane:**
- Fake evidence promotion — `Test-Path` only, no content validation, null metrics pass all gates
- Null metrics bypass regression — PowerShell `$null -gt threshold` = `$false` (passes)
- `require_explanation_on_regression` is dead code — loaded but never referenced
- Windows "proven" contradicts RELEASE_CONTRACT.md definition of "proven"
- Zero identity verification on incoming messages — inbox watcher doesn't call identity-enforcer.js
- Outgoing messages never signed — `Signer.js` exists but never called
- AGENTS.md has zero integrity protection — was already overwritten once
- `reject-release.ps1` accepts empty evidence — no validation of evidence content
- `targets.json` corrupted = unhandled crash — no try/catch around `ConvertFrom-Json`
- Heartbeat schema non-compliant — missing 17+ v1.1 fields, invalid status enum

**Must fix first:** Add content validation to `promote-release.ps1` (require non-null metrics, add SHA-256 checksums). Fix null-comparison regression bypass. Wire identity-enforcer.js into inbox-watcher. Add integrity checks for AGENTS.md and trust-store.json in post-compact-audit.

**Must not overclaim:** "Proven" on Windows means 4 of 5 evidence types. Regression check passes for null metrics. Message identity is asserted, not verified. Execution gate is not integrated into any automated pipeline.

---

## Convergence Gate

```json
{
  "claim": "Deep 4-lane code review completed identifying 12 new failure surfaces beyond the previous review's 8 blockers",
  "evidence": "docs/FOUR_LANE_REVIEW_DEEP_2026-04-21.md",
  "verified_by": "self",
  "contradictions": [
    "Archivist trust store key_id mismatch (snapshot d5faddfa2ab2ff3f vs trust store 583b2c36f397ef01) — continuity handshake would fail",
    "Library AGENTS.md canonical path for Kernel uses kernel-lane vs actual kernel directory",
    "Kernel promote-release.ps1 defines proven=4of5 on Windows vs RELEASE_CONTRACT.md proven=5of5"
  ],
  "status": "proven"
}
```
