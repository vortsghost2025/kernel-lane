# 4-Lane System Review — Execution Reality Audit

**Review date:** 2026-04-21
**Reviewer:** Kernel Lane (Lane 4, Authority 70)
**Method:** Runtime evidence inspection across all 4 repositories. No documentation claims accepted without code/execution proof.

---

## 1. Archivist Review

**Lane role:** Governance root (Position 1, Authority 100, can_govern: true)

**Strongest implemented controls:**
1. **JWS signature verification** — `Verifier.js` + `VerifierWrapper.js` implement RSA-SHA256 JWS verification with A=B=C lane consistency enforcement. This is the deepest verification in the entire system.
2. **Execution gate** — `execution-gate.js` has 5 real violation entries in `gate-violations.jsonl`. This is the only enforcement mechanism that has produced real rejection events.
3. **Continuity handshake** — `continuity_handshake.js` implements full 9-step verification: load snapshot, parse JWS, verify signature, check expiry, check revocations, compare lanes.
4. **Inbox watcher** — 18 processed messages in `processed/`. Actually running.

**Weakest runtime gaps:**
1. **CPS scoring is documentation-only.** `CPS_ENFORCEMENT.md` references Rust code (`constitution.rs`, `cps_check.rs`) that does NOT exist. No `cps_log.jsonl` anywhere. Baseline score of 19 is declared but never computed or enforced at runtime.
2. **Plaintext private key.** `.identity/keys.json` contains raw Ed25519 private key — directly violates `constitutional_constraints.yaml` (`never_export_private_key: true`).
3. **Ed25519/RS256 algorithm mismatch.** `.identity/keys.json` declares Ed25519 keypair but `snapshot.jws` uses RS256. The signing system and identity key system are inconsistent.
4. **Trust store incomplete.** `.trust/keys.json` only has the `swarmmind` key. Missing `archivist` and `library` keys despite `validate-system-anchor.js` requiring all three.
5. **No `.pem` files exist.** `KeyManager.js` expects `.pem` files. Zero found in the entire repository.

**Governance risks:**
- ALL 7 governance files (GOVERNANCE.md, COVENANT.md, CPS_ENFORCEMENT.md, VERIFICATION_LANES.md, CHECKPOINTS.md, RECIPROCAL_ACCOUNTABILITY.md, constitutional_constraints.yaml) are advisory/documentation-only. None are parsed or enforced by running code.
- AGENTS.md line 11 explicitly admits: "Full enforcement depends on host/runtime or operator compliance."
- Session lock expired (`2026-04-19`) with no code checking or enforcing expiry.

**What is actually proven:**
- JWS signature verification works (RSA-SHA256, A=B=C invariant)
- Execution gate has blocked real violations (5 entries)
- Inbox watcher processes messages (18 processed)
- Heartbeat is active and recently updated

**What is only documented:**
- CPS scoring and enforcement
- Constitutional constraints (declared but no runtime checker)
- Session lock enforcement
- Rust-based enforcement code (`constitution.rs`, `cps_check.rs`)
- Governance file enforcement of any kind

**Top 3 fixes:**
1. Remove plaintext private key from `.identity/keys.json` and resolve Ed25519/RS256 algorithm mismatch
2. Complete trust store (register archivist + library keys) or remove the claim that 3-key verification is enforced
3. Either implement CPS runtime scoring or remove the claim that CPS is enforced

---

## 2. Library Review

**Lane role:** Persistent systems (Position 2, Authority 90, can_govern: false)

**Strongest implemented controls:**
1. **Schema validator** — `SchemaValidator` class validates JSON structure with required fields, enums, types, and ranges
2. **Message delivery** — `SchemaValidator.deliverMessage()` writes to canonical paths (was added to fix the mirror-path bug)
3. **Attestation pipeline** — Code structure exists for attestation verification (initialize, sign, verify)

**Weakest runtime gaps:**
1. **Inbox watcher marks invalid messages as "verified".** When a message fails schema validation, the watcher still logs it with `verified: true` in some code paths. "Verified" means "file exists and was processed" not "structurally valid and identity-confirmed."
2. **Attestation pipeline never initialized.** The attestation code exists but `ATTESTATION_STATE.json` has never been created. No attestation has ever been performed.
3. **Execution gate always open.** The execution gate check in the Library's startup always passes because there are no active blockers registered for the Library lane.
4. **3 contradictory identity sources.** `LANE_REGISTRY.json`, `RUNTIME_STATE.json`, and `.identity/snapshot.json` disagree on lane attributes (name, authority, position vary across files).
5. **Heartbeat `messages_processed: 0`** despite processed messages existing — counter not integrated.

**Delivery verification depth:**
- Schema validation: YES (structure only)
- Signature validation: NOT IMPLEMENTED in Library's own code (relies on SwarmMind's Verifier.js)
- Identity validation: PARTIAL (checks `from_lane` field exists, does not verify it against a trust store)
- Canonical delivery: PARTIAL (`deliverMessage()` writes to canonical paths but the watcher does not verify incoming messages arrived via canonical path)

**What "verified" currently means:**
- **File exists + was processed by inbox watcher.** It does NOT mean: schema valid, signature valid, identity confirmed, or canonical delivery verified.

**What is actually proven:**
- Inbox watcher moves files (processed/ has entries)
- Schema validator can check JSON structure
- Messages can be sent to canonical paths via `deliverMessage()`

**What is only documented:**
- Full delivery verification (signature + identity + canonical path)
- Attestation pipeline operation
- Execution gate enforcement

**Top 3 fixes:**
1. Fix inbox watcher to NOT mark messages as "verified" when they fail schema validation
2. Resolve the 3-way identity conflict (LANE_REGISTRY vs RUNTIME_STATE vs snapshot.json)
3. Initialize attestation pipeline or remove the claim that attestations are performed

---

## 3. SwarmMind Review

**Lane role:** Trace-mediated verification (Position 3, Authority 80, can_govern: false)

**Strongest implemented controls:**
1. **Verifier.js** — JWS-only (HMAC completely removed), throws on `allowLegacy` option. This is the strongest cryptographic verifier in the system.
2. **Governed start** — `governed-start.js` enforces a full chain: LaneResolver, Attestation, Identity Verification, LaneContextGate, NODE_OPTIONS, ContinuityVerifier, Governance, App. This is the most rigorous startup sequence across all lanes.
3. **Governance with quarantine** — `resolve-governance-v2.js` implements real quarantine with `QUARANTINE_STATE.json`, authority restriction, governance blocks, and re-verification for release.
4. **True negative tests** — `test-hardening-drill.js` tests wrong lane, wrong kid, tampered snapshot, revoked key. These are real failure-mode tests, not graceful skips.

**Weakest runtime gaps:**
1. **2 malformed inbox messages** — JSON with unescaped newlines in `body` field. These cause an infinite WARN loop in inbox-watcher.js every 60 seconds. This has been running for 1.5+ hours without resolution.
2. **SeccompSimulator is a STUB** — Placeholder only. No real seccomp-bpf enforcement. The name implies kernel-level syscall filtering but the implementation is a no-op.
3. **FilePermissionEnforcer whitelist bug** — Pattern `S:/SwarmMind/**` does not match the actual path `S:/SwarmMind Self-Optimizing Multi-Agent AI System/**` (spaces in path). This means file permission enforcement silently skips all files.
4. **LaneContextGate tampered** — Lines 487-488 contain `// tampered for test` comments. The gate that is supposed to prevent unauthorized lane context changes has been explicitly weakened for testing and never restored.
5. **Heartbeat stale** — `messages_processed: 0` despite having processed messages.

**Trust/identity gaps:**
- SwarmMind has the strongest verification code (Verifier.js with A=B=C)
- But the LaneContextGate has been tampered with for testing
- And the file permission enforcer's whitelist doesn't match the actual directory path
- The strongest verifier is undermined by the weakest configuration

**Cross-lane tests:**
- `test-hardening-drill.js` does TRUE verification (not graceful skips)
- `cross-lane-sync.js` produces `CROSS_LANE_TEST_RESULTS.json` but the depth of end-to-end verification is unclear

**What is actually proven:**
- JWS verification works (strongest in the system)
- Governance quarantine works (can block releases)
- Negative test coverage exists (wrong lane, wrong key, tampered snapshot)
- Governed start enforces a real chain

**What is only documented:**
- Seccomp syscall filtering (stub)
- File permission enforcement (broken by path mismatch)
- LaneContextGate integrity (tampered)

**Top 3 fixes:**
1. Fix the 2 malformed inbox messages (unescaped newlines) to stop the infinite WARN loop
2. Fix `FilePermissionEnforcer` whitelist to match actual path with spaces
3. Remove `// tampered for test` from LaneContextGate and restore proper enforcement

---

## 4. Kernel Review

**Lane role:** GPU-optimized artifact generation (Position 4, Authority 70, can_govern: false)

**Strongest implemented controls:**
1. **Release promotion with convergence artifacts** — `promote-release.ps1` hard-requires artifact, benchmark report, and ncu report. Throws on missing. Writes `manifest.json` + `convergence.json` + broadcast. This is the most machine-enforceable release contract in the system.
2. **Build pipeline** — `build-kernels.ps1` compiles 6 `.cu` files to 5 `.exe` + 1 `.ptx`. Auto-imports MSVC environment. Verified working with real build outputs on disk.
3. **NCU profiling** — Full 42-pass profiling works headless. 81MB report on disk with real kernel analysis data.
4. **Benchmark pipeline** — Captures latency and throughput from executable stdout. Real metrics: 126.33ms latency, 8.1M ops/sec on RTX 5060.
5. **Rejection path** — `reject-release.ps1` writes `rejection.json` + broadcast (never executed but implemented correctly).

**Weakest runtime gaps:**
1. **NSYS profiling impossible from headless sessions.** Windows session isolation blocks the nsys daemon's named-pipe RPC. 120-second timeout. Both v2025.6.3 and v2026.2.1 affected. No workaround exists for headless operation. This blocks full convergence.
2. **Release contract mismatch.** `docs/RELEASE_CONTRACT.md` says nsys_report is required. `promote-release.ps1` makes it optional. The code is more lenient than the documented contract.
3. **Baseline regression enforcement NOT implemented.** `config/targets.json` declares 2% regression threshold but `run-benchmarks.ps1` has zero comparison logic. A 50% regression would pass without warning.
4. **Execution gate is dead code.** `execution-gate.js` exists but `lanes/broadcast/` directory does not. No `active-blocker.json` ever created. Gate has never been triggered.
5. **`config/targets.json` lane name remnant.** Still says `"lane": "kernel-lane"` instead of `"kernel"`.

**Profiling pipeline reality:**
- **ncu**: Works headless. Full `--set full` produces 42-pass reports. Takes ~34s (vs 0.39s normal) due to kernel launch serialization — expected and documented.
- **nsys**: Blocked by Windows session isolation. Daemon requires interactive desktop to accept agent dialog. Zero `.nsys-rep` files on disk despite multiple attempts. Helper scripts exist (`collect-nsys.ps1`, `fix-nsys-daemon.bat`) but require manual interactive execution.

**Convergence artifact quality:**
- `convergence.json`: Structurally valid. Contains real metrics (not placeholders). Status="partial" is honest — doesn't overclaim.
- `manifest.json`: Structurally valid. `nsys_report: null` is explicit about the gap. `speedup_vs_baseline: null` is correct (this IS the baseline).
- Evidence array contains verifiable claims: "benchmark: latency 126.33 ms", "ncu: full-profile-2026-04-21.ncu-rep"

**Whether release promotion is truly machine-enforceable:**
- YES for hard requirements (artifact, benchmark, ncu) — script throws on missing files
- PARTIALLY for soft requirements (nsys) — script warns but proceeds
- NO for regression enforcement — threshold declared but not checked in code
- The convergence artifact is the strongest part: it records what's proven vs. what's blocked, preventing silent gaps

**Whether lane identity is fully converged to `kernel`:**
- YES for directory structure — `lanes/kernel/` is the only lane directory, `lanes/kernel-lane/` is removed
- NO for `config/targets.json` — still says "kernel-lane"
- PARTIAL for outbox messages — the nsys feedback message uses a non-standard schema (missing 8 required v1.0 fields)

**Top 3 fixes:**
1. Implement baseline regression checking in `run-benchmarks.ps1` (read `config/targets.json` threshold, compare against previous report, block on regression)
2. Fix release contract documentation/code mismatch — either require nsys in `promote-release.ps1` or update `RELEASE_CONTRACT.md` to mark nsys as optional
3. Fix `config/targets.json` lane name from "kernel-lane" to "kernel"

---

## 5. Cross-Lane System Review

### How the 4 lanes connect today

```
Archivist ──(governance decisions)──> Library ──(intake reviews)──> Kernel
    |                                      |
    +──(onboarding, EULA feedback)─────────+
    |
    +──(onboarding, key registration)──> SwarmMind ──(verification, tests)──> Library/Kernel
```

**Actual connection paths:**
- Archivist → Library: governance decisions, scheduled task setup
- Archivist → SwarmMind: onboarding message, key registration
- Archivist → Kernel: onboarding, EULA feedback, scheduled task setup
- Library → Kernel: integration requirements, intake review (REJECT on v0.1.0)
- SwarmMind → Kernel: onboarding message
- Kernel → Archivist: nsys feedback message (non-standard schema)
- Kernel → SwarmMind: onboarding ACK
- Kernel → all lanes: release broadcast (v0.1.0)

### Where routing is now deterministic

1. **Canonical inbox paths** are declared in all AGENTS.md files
2. **Library's `deliverMessage()`** writes to canonical paths (fixed from mirror-path bug)
3. **Kernel's outbox broadcast** writes to `lanes/kernel/outbox/` and tracks messages

### Where mirror/path drift can still happen

1. **Archivist's inbox watcher does NOT verify canonical delivery.** Messages could be deposited in local mirror directories without detection.
2. **SwarmMind's file permission whitelist** doesn't match the actual path (spaces issue), so path-based enforcement is silently broken.
3. **Kernel's outbox nsys feedback message** was not delivered via canonical path — it's unclear if the Archivist ever received it.

### Whether scheduled persistence is real in all lanes

| Lane | Scheduled Tasks | Evidence |
|------|----------------|----------|
| Archivist | `register-runners.ps1` defines tasks | **UNCONFIRMED** — `schtasks /query` returned "Access is denied" |
| Library | Tasks created by Archivist (user confirmed) | **PARTIAL** — tasks created but Library's own outbox is empty (no outgoing messages logged) |
| SwarmMind | Tasks attempted by Archivist | **FAILED** — spaces in path broke schtasks registration |
| Kernel | `Kernel-Heartbeat` + `Kernel-Watcher` | **CONFIRMED** — heartbeat file updated with recent timestamps, 2 messages processed |

**Verdict:** Only Kernel has confirmed scheduled persistence. SwarmMind's tasks failed. Archivist's tasks are unconfirmed. Library's tasks were created but produce no observable output.

### Whether delivery verification is shallow or deep

| Verification Level | Archivist | Library | SwarmMind | Kernel |
|-------------------|-----------|---------|-----------|--------|
| File exists | YES | YES | YES | YES |
| Schema valid | YES | YES (but marks invalid as verified) | YES | NO (inbox watcher doesn't validate schema) |
| Signature valid | YES (Verifier.js) | NO (delegates to SwarmMind) | YES (Verifier.js) | NO |
| Identity valid | YES (A=B=C) | NO | YES (A=B=C) | NO |
| Canonical delivery | NO | PARTIAL (deliverMessage) | NO | NO |

**Verdict:** Delivery verification is **shallow** for 3 of 4 lanes. Only SwarmMind and Archivist have deep verification (JWS + A=B=C), and even they don't verify canonical delivery paths.

### What "verified" currently means across the system

**It means: file exists + was processed by inbox watcher.** It does NOT consistently mean schema valid, signature valid, identity confirmed, or canonical delivery verified. The exception is SwarmMind's Verifier.js which does real cryptographic verification — but even that is undermined by the tampered LaneContextGate and broken file permission whitelist.

### Weakest connection right now

**SwarmMind → rest of the system.** SwarmMind has the strongest verification code but:
1. Its inbox has 2 malformed messages causing infinite WARN loops
2. Its file permission whitelist doesn't match its own directory path
3. Its LaneContextGate has been tampered with for testing
4. Its scheduled tasks failed to register (spaces in path)

The lane that is supposed to verify the system cannot reliably verify itself.

### Next most dangerous false-positive

**"Verified" on processed inbox messages.** The Library inbox watcher marks messages as verified even when they fail schema validation. Combined with the Archivist's inbox watcher not checking canonical delivery, a message that:
1. Was placed in the wrong directory (mirror instead of canonical)
2. Has an invalid schema
3. Has a forged identity
4. Was never signed

...could still be marked "verified" and "processed" in the Library's records. This is the most dangerous false-positive because it makes the system appear to have deeper verification than it actually performs.

---

## 6. Most Important Questions to Ask Next

1. **Should the system accept "partial" convergence as a stable release state, or should all releases require "proven" (all 5 evidence types)?** This determines whether nsys is a hard blocker or an acceptable gap.

2. **Should "verified" in inbox processing require at minimum schema validation, or is file-existence sufficient for the current system stage?** This determines whether the Library inbox watcher bug is P0 or P2.

3. **Is the SwarmMind LaneContextGate tampering permanent (intentional architecture change) or temporary (needs to be reverted)?** This determines whether governed-start actually enforces lane context.

4. **Should CPS scoring be implemented in code or should all CPS documentation be removed as unenforceable?** This determines whether Archivist governance is real or symbolic.

5. **Should the trust store be completed (register all 4 lane keys) before any cross-lane message is considered "verified", or is partial trust acceptable?** This determines the security model.

6. **Should the nsys dependency be removed from the release contract entirely (making it documentation-only) given that Windows headless profiling is architecturally impossible?** This determines whether the contract matches reality.

---

## 7. Answers to Those Questions

1. **"Partial" should be acceptable for baseline releases but NOT for optimization releases.** A v0.1.0 baseline establishes initial measurements — nsys adds timeline context but isn't needed to prove the baseline exists. However, any release claiming a speedup (v0.2.0+) should require "proven" status because the system needs timeline evidence to verify the optimization didn't just shift work elsewhere.

2. **"Verified" should require at minimum schema validation.** File-existence-only verification is a false-positive factory. The Library inbox watcher bug is P0 — it should be fixed before any more messages are processed. If a message fails schema validation, it should be moved to `expired/` not `processed/`, and must never be marked `verified: true`.

3. **The LaneContextGate tampering MUST be reverted.** A verification gate that has been explicitly weakened for testing provides negative security value — it creates the appearance of enforcement without actual enforcement. This is worse than having no gate at all.

4. **CPS scoring should be removed from documentation until implemented in code.** Keeping documentation that describes nonexistent enforcement code (`constitution.rs`, `cps_check.rs`) is actively harmful — it creates a false governance surface. Either implement it or remove the claim.

5. **The trust store should be completed before cross-lane cryptographic verification is considered operational.** Currently only SwarmMind's key is registered. A system that verifies signatures against 1 of 4 keys provides only partial authentication. However, schema-level verification (without crypto) can proceed with the current trust store.

6. **nsys should be documented as "required where available, optional on Windows headless."** The contract should explicitly state: on Linux, nsys is required; on Windows headless sessions, nsys is blocked by OS limitations and convergence status reflects this as a known gap rather than a pipeline defect. This matches reality without weakening the contract.

---

## 8. Next Blockers

### Blocker 1: Library inbox watcher marks invalid messages as "verified"
- **Why it matters:** Creates false-positives. The most dangerous defect in the system because it makes verification appear deeper than it is.
- **What counts as done:** Inbox watcher only marks `verified: true` when schema validation passes; invalid messages go to `expired/`, not `processed/`.
- **Type:** code (Library lane)

### Blocker 2: SwarmMind LaneContextGate tampered for testing
- **Why it matters:** The governed-start chain is the system's strongest enforcement path. A tampered gate makes the entire chain unreliable.
- **What counts as done:** `// tampered for test` comments removed, gate restored to original enforcement logic, negative test passes.
- **Type:** code (SwarmMind lane)

### Blocker 3: CPS/governance documentation claims enforcement that doesn't exist
- **Why it matters:** Referenced Rust code (`constitution.rs`, `cps_check.rs`) does not exist. CPS baseline score of 19 is declared but never computed. This is a governance false-positive.
- **What counts as done:** Either CPS scoring is implemented in runnable code, OR all CPS enforcement documentation is clearly marked as "planned, not implemented" and the fake Rust file references are removed.
- **Type:** code + governance (Archivist lane)

### Blocker 4: SwarmMind malformed inbox messages causing infinite WARN loop
- **Why it matters:** 2 JSON files with unescaped newlines in `body` field trigger warnings every 60 seconds. This has been running for hours. It degrades log quality and masks real issues.
- **What counts as done:** Malformed messages fixed or moved to `expired/`; inbox watcher handles parse errors gracefully without infinite loops.
- **Type:** code + operator-gated (SwarmMind lane)

### Blocker 5: Kernel nsys report missing (blocks full convergence)
- **Why it matters:** v0.1.0 is stuck at "partial" convergence. Library has already REJECTED the intake review. Future optimization releases need "proven" status.
- **What counts as done:** `.nsys-rep` file exists in `profiles/nsys/`, re-promoted with nsys path, convergence status="proven".
- **Type:** operator-gated (requires interactive desktop session)

### Blocker 6: Baseline regression enforcement not implemented
- **Why it matters:** `config/targets.json` declares 2% threshold but nothing enforces it. A 50% regression would pass without warning.
- **What counts as done:** `run-benchmarks.ps1` reads threshold from config, compares new metrics against previous report, exits non-zero on regression.
- **Type:** code (Kernel lane)

### Blocker 7: Archivist plaintext private key + algorithm mismatch
- **Why it matters:** `.identity/keys.json` has a raw Ed25519 private key (security violation) and the JWS uses RS256 while keys.json declares Ed25519. This undermines the trust chain.
- **What counts as done:** Private key removed from disk, consistent algorithm used across signing and identity, trust store completed with all 4 lane keys.
- **Type:** code + governance (Archivist lane)

### Blocker 8: SwarmMind file permission whitelist path mismatch
- **Why it matters:** Pattern `S:/SwarmMind/**` doesn't match `S:/SwarmMind Self-Optimizing Multi-Agent AI System/**`. All file permission enforcement silently skips.
- **What counts as done:** Whitelist pattern matches actual directory path with spaces.
- **Type:** code (SwarmMind lane)

---

## 9. Messages for Each Lane

### Archivist

**Verify next:** Complete the trust store (register all 4 lane keys). Resolve the Ed25519/RS256 mismatch in the identity system. Confirm scheduled tasks are actually registered (schtacks access denied prevented verification).

**Must not overclaim:** CPS enforcement does not exist in code. Do not claim governance is enforced when it is advisory-only. Do not reference `constitution.rs` or `cps_check.rs` — they do not exist.

**Must not touch yet:** Do not modify other lanes' governance files without their explicit approval. Do not force-push to any lane's repository.

### Library

**Verify next:** Fix the inbox watcher so invalid messages are NOT marked "verified". Resolve the 3-way identity conflict (LANE_REGISTRY vs RUNTIME_STATE vs snapshot.json). Initialize the attestation pipeline or remove the claim.

**Must not overclaim:** "Verified" currently means "file exists and was processed" — it does NOT mean schema valid, signature valid, or identity confirmed. Do not claim delivery verification is deep when it is shallow.

**Must not touch yet:** Do not consume Kernel Lane releases until the adoption proposal is ratified. The current "partial" convergence is honest — do not inflate it.

### SwarmMind

**Verify next:** Fix the 2 malformed inbox messages (unescaped newlines in body field). Fix the FilePermissionEnforcer whitelist to match the actual path with spaces. Revert the LaneContextGate tampering.

**Must not overclaim:** SeccompSimulator is a stub — do not claim syscall filtering is enforced. File permission enforcement is broken by path mismatch — do not claim file permissions are verified.

**Must not touch yet:** Do not modify the Verifier.js A=B=C invariant without cross-lane coordination — it is the system's strongest verification and changes affect all lanes.

### Kernel

**Verify next:** Implement baseline regression checking in `run-benchmarks.ps1`. Fix `config/targets.json` lane name from "kernel-lane" to "kernel". Fix the outbox nsys feedback message to use v1.0 schema (8 missing required fields).

**Must not overclaim:** nsys profiling is impossible from headless sessions — do not claim it will be automated. The execution gate is dead code — do not claim gate enforcement is active. Regression threshold is declared but not enforced — do not claim regressions are blocked.

**Must not touch yet:** Do not re-promote v0.1.0 until nsys is either collected (interactive session) or the release contract is formally updated to make nsys optional on Windows headless.
