# SYSTEM_MAP.md

Audited: 2026-05-04 | Auditor: SwarmMind lane | Evidence: cross-repo hash/enum/authority comparison
Ratified: 2026-05-05 | Ratifier: Archivist lane | Version: 1.1 | Evidence: key convergence, authority resolution

---

## 0. Ratification Record (v1.1)

| Change | Before | After | Evidence |
|--------|--------|-------|----------|
| Trust store key IDs | 4 different stale sets | 4/4 aligned (see Section 3) | All .trust/keys.json + broadcast trust-store.json match |
| Library key | Passphrase lost (c5423f36603e1491) | Fresh keypair (a5a5f5c2edbee56a) | Windows .identity/ has working unencrypted pair |
| SwarmMind key | Windows had old pair (addb0afb8ee5c2ed) | Ubuntu pair installed (ec467e7103736c28) | PEMs from Ubuntu headless, cross-platform verify OK |
| Kernel key | No .identity/ on Windows | Ubuntu pair installed (d475d23aeed6c7b8) | PEMs from Ubuntu headless, .identity/ directory created |
| Authority values | 6 sources disagree | Position-descending model (see Section 2) | All .session-mode files now exist and agree |
| Unsigned processing | No policy | UNSIGNED_PROCESSING_POLICY.md: no unsigned allowed | All 4 lanes have working signing keys |
| Authority lane | Undefined | Sub-function of Archivist (no separate repo) | Confirmed in AGENTS.md canonical registry |

---

## 1. What Is This System?

A **four-lane constitutional AI governance system** -- four autonomous software lanes
that coordinate via signed JSON messages, enforce a shared constitution, and audit
each other's work. The governance framework IS the product.

Each lane is an independent git repo with its own identity keys, inbox, outbox,
scripts, and domain. Lanes communicate through a shared `lanes/` messaging backbone,
not by importing each other's code.

**Two platforms in production:**
- **Windows desktop** (`S:/` drive) -- primary development, Tauri GUI, CUDA GPU
- **Ubuntu headless** (`/home/we4free/agent/repos/`) -- CI, automation, lane workers

---

## 2. What Does Each Lane Do?

### Archivist (Position 1, Authority 90-100)
- **Repo:** `Archivist-Agent`
- **Role:** Governance root, coordinator, constitutional authority
- **What it does:** Holds the constitution, ratifies proposals, coordinates cross-lane
  sync, manages the trust store, runs the Tauri desktop app (Rust), enforces convergence
  protocol, manages contradiction resolution
- **Unique executable:** `src-tauri/` (14 Rust files, Tauri 2.x desktop app), `src/core/protocols/` (outcome, confidence), `src/queue/` (governance queues), `src/orchestrator/` (recovery engine, quarantine store)
- **Unique docs:** Operator Mandate, RECIPROCAL_ACCOUNTABILITY.md, 8+ governance .md files at root
- **Scripts:** 145 JS, 27 PS1 (largest script count of any lane)

### SwarmMind (Position 2, Authority 50-80)
- **Repo:** `SwarmMind`
- **Role:** Emergent intelligence, optimization, synchronization, robustness audit
- **What it does:** Cross-lane drift detection, constraint lattice evaluation, dual
  verification (structural + operational), transfer logging, crash recovery, resilience
  policy enforcement, quarantine re-validation
- **Unique executable:** `scripts/constraint-lattice.js`, `scripts/dual-verification.js`,
  `scripts/transfer-log.js`, `scripts/swarmmind-verify.js`, `scripts/we4free-drift.js`,
  `scripts/we4free-replay.js`, `scripts/retry-with-backoff.js`, `scripts/execution-gate.js`
- **Unique docs:** AGENTS.md (SwarmMind-specific lane instructions)
- **Scripts:** ~110 JS

### Library (Position 3, Authority 60-70)
- **Repo:** `self-organizing-library`
- **Role:** Memory layer, verification-and-enforcement, knowledge preservation
- **What it does:** Hosts the NexusGraph web app (Next.js 16 + React 19), maintains
  `site-index.json` (5000+ document knowledge graph), runs usage lane analysis,
  manages graph write guards, provides the visual interface to the whole system
- **Unique executable:** Full Next.js web application (21 pages, 5 API routes),
  `src/usage/` (UsageLane, BypassDetector, RuntimeProbe, UsageGateEnforcer),
  `src/swarmmind/` (orchestrator client), `src/resilience/` (RecoveryClassifier,
  ContinuityVerifier), graph visualization (Sigma.js + Graphology)
- **Unique docs:** SPEC.md, ROSETTA_STONE_SUMMARY.md, CHANGELOG.md, FREEAGENT_*.md
- **Scripts:** 190 JS (most scripts of any lane)
- **package.json:** `nextjs-template@0.1.0`

### Kernel (Position 4, Authority 60)
- **Repo:** `kernel-lane`
- **Role:** Optimization and benchmarking, GPU compute, evidence production
- **What it does:** CUDA kernel development and benchmarking (RTX 5060), profiling
  (Nsight Systems/Compute), produces measurable optimization artifacts with runtime
  evidence, promotes releases through a formal contract
- **Unique executable:** 11 CUDA `.cu` kernel sources, benchmark/plot scripts (Python),
  profiling automation (PS1), Windows compile scripts (.bat/.cmd)
- **Unique docs:** CUDA_PROJECT_SUMMARY.md, ACHIEVEMENT.md, LANE_API_DOCUMENTATION.md,
  PHASE1_COMPLETION_DASHBOARD.md
- **No package.json** -- standalone Node.js scripts + CUDA + PowerShell

### Authority (Position ?, Authority ?)
- **Not a separate repo.** Shares `Archivist-Agent` repo at `lanes/authority/`
- **Status:** Schema `to` enum includes "authority" in 3 of 4 repos (missing from
  Library). Has inbox/outbox dirs only in Archivist. Appears to be a governance
  sub-function of Archivist, not an independent lane.
- **AGENTS.md references it** as the 5th lane entry but provides no separate repo path.

---

## 3. What Is the Source of Truth?

### Confirmed aligned (all 4 repos agree):
| Artifact | Status |
|----------|--------|
| Trust store key IDs | 4/4 identical: archivist=65ae05b2a9e749cb, library=a5a5f5c2edbee56a, swarmmind=ec467e7103736c28, kernel=d475d23aeed6c7b8 |
| COVENANT.md | 4/4 identical (hash 7cc17fe31089) |
| SchemaValidator.js (scripts/) | 4/4 identical (hash 22dbd10e2f36) |
| Lane worker tests | 4/4 pass 17/17 on Ubuntu |
| Authority/position values | 4/4 aligned via .session-mode (resolved v1.1) |
| .session-mode files | 4/4 exist (SwarmMind/Kernel created v1.1) |
| Unsigned processing policy | Archivist UNSIGNED_PROCESSING_POLICY.md: all messages must be signed |

### Confirmed drifted (disagreement between repos):
| Artifact | Problem | Canonical Source |
|----------|---------|-----------------|
| `schemas/inbox-message-v1.json` | Library missing `authority` in `to` enum, missing `audit` in `task_kind`, missing `auto`/`pipeline` in `exec.mode`, missing `codex`/`pipeline` in `exec.engine`, missing 5 `exec.actor` values | Archivist/SwarmMind/Kernel (3-way aligned) |
| Shared scripts | 7 of 8 checked scripts have 3-4 different versions across lanes | No canonical source; `sync-all-lanes.js` uses mtime-based selection |
| LANE_REGISTRY.json | Only exists in Archivist; lists 3 lanes (missing kernel/authority) with wrong SwarmMind path | AGENTS.md canonical registry (but not in machine-readable form) |
| GOVERNANCE.md | Archivist version (473 lines) differs from others (409 lines) | Unknown which is canonical |
| BOOTSTRAP.md | Archivist version (944 lines) differs from others (939 lines) | Unknown which is canonical |

### Source-of-truth hierarchy (documented and enforced):
1. `.session-mode` per lane (authority, position, role) — NOW EXISTS FOR ALL 4 LANES
2. `AGENTS.md` per lane (canonical paths, protocols)
3. `lanes/broadcast/trust-store.json` (identity keys) — NOW ALIGNED ACROSS ALL REPOS
4. `schemas/inbox-message-v1.json` (message validation)
5. `config/targets.json` (lane operational config) — NOW ALIGNED WITH .session-mode

**Resolved (v1.1):** SwarmMind and Kernel now have `.session-mode` files. `config/targets.json` values aligned with `.session-mode`.

---

## 4. How Does Data/Evidence Move Between Lanes?

```
Lane A outbox/ ──> relay-daemon.js ──> Lane B inbox/
                                           |
                                     lane-worker.js
                                      /    |    \
                              processed  blocked  quarantine
                                           |
                                  generic-task-executor.js
                                      (action-required/)
                                           |
                                  completion-proof.js
                                           |
                                     processed/
```

**Protocol:**
1. Sender creates JSON message conforming to `inbox-message-v1.json` schema
2. Sender signs with private key (JWS RS256) using `create-signed-message.js`
3. Sender writes to own `outbox/`
4. `relay-daemon.js` delivers to target lane's canonical `inbox/`
5. Receiving `lane-worker.js` validates schema + signature + identity
6. Routes: `processed/` (valid), `blocked/` (policy violation), `quarantine/`
   (schema invalid), `action-required/` (needs work)
7. `generic-task-executor.js` processes `action-required/` items
8. `completion-proof.js` stamps terminal messages
9. Responses written to sender's inbox via same path

**Broadcast** (`to: "all"` or `to: "broadcast"`):
- `broadcast-normalizer.js` fans out to individual per-lane copies
- `lanes/broadcast/` holds shared state: `trust-store.json`, `contradictions.json`,
  `system_state.json`, `active-blocker.json`

**Evidence exchange:**
- `evidence_exchange.artifact_path` in messages references files in `evidence/`
- `evidence-exchange-check.js` verifies artifacts exist and hash-match
- `OUTPUT_PROVENANCE` block required on all final outputs

**Platform bridge:**
- Windows (`S:/`) and Ubuntu (`/home/we4free/agent/repos/`) connected via SMB mount
- `scripts/util/lane-discovery.js` provides platform adaptation: converts `S:/`
  to `/home/we4free/` on Linux
- `config/allowed_roots.json` contains both Windows and Linux path sets

---

## 5. What Is Executable Today?

### Fully operational on Ubuntu headless:
| Component | Status | Test |
|-----------|--------|------|
| Lane workers (all 4) | 17/17 pass each | `node scripts/test-lane-worker-we4free.js` |
| Schema validators | All 4 functional | Inline validate() |
| Trust store | 4/4 aligned, all keys valid | Cross-lane consistency check |
| Message signing | JWS RS256 operational | `create-signed-message.js` |
| Inbox routing | quarantine/blocked/processed/action-required all working | Live traffic verified |
| Heartbeat writing | `heartbeat.js` works on all 4 | Files update on schedule |
| SwarmMind hardening | constraint-lattice, dual-verification, transfer-log, drift scoring | Evidence artifacts committed |
| Post-compact audit | `post-compact-audit.js` | Runs after context compaction |
| Recovery test suite | 11-test suite | `recovery-test-suite.js` |

### Operational on Windows only:
| Component | Repo | Why Windows-only |
|-----------|------|-----------------|
| Tauri desktop app | Archivist | Requires `cargo build`, GUI runtime |
| Next.js web app | Library | `npm run dev` / `npm run build` (needs Node + deps) |
| CUDA kernels | Kernel | Requires NVCC + RTX 5060 + Windows CUDA toolkit |
| Nsight profiling | Kernel | NVIDIA tools, Windows-only GPU access |
| PowerShell watchers | All | `.ps1` scripts for Windows Task Scheduler |
| Scheduled tasks | All | `SwarmMindHeartbeat`, `SwarmMindWatcher` etc. |

### Test suites with known issues:
| Suite | Expected | Actual | Reason |
|-------|----------|--------|--------|
| Executor v3 | 64/64 | 46/64 on Ubuntu | S:/ path-mapping issues on Linux |
| Sync-all-lanes | 4/4 lanes | Runs with drift findings | Mtime-based canonical selection |

---

## 6. What Is Theory/Docs Only?

### Governance documents (authoritative but not executable):
- `GOVERNANCE.md` -- 9 laws, 4 invariants, enforcement loop
- `COVENANT.md` -- 5 values (truth > agreement, structure > identity, etc.)
- `BOOTSTRAP.md` -- "THE SINGLE ENTRY POINT" (939/944 lines)
- `RECIPROCAL_ACCOUNTABILITY.md` -- mutual protection, user quarantine, drift scoring
- `SYSTEM_CONSTRAINTS.md` -- lane sovereignty rules
- `CHECKPOINTS.md`, `VERIFICATION_LANES.md`, `CPS_ENFORCEMENT.md`
- `constitutional_constraints.yaml` -- constraint definitions (Archivist only)

### Architecture/design docs (not runnable):
- `LANES_ARCHITECTURE.md` (Kernel) -- 4-lane Rosetta Stone
- `PROJECT_OVERVIEW.md` (Kernel) -- plain-language overview
- `LANE_API_DOCUMENTATION.md` (Kernel) -- 702-line API reference
- `600K_DISTRIBUTED_ARCHITECTURE.md` (Archivist)
- `PHASE1_COMPLETION_DASHBOARD.md`, `PHASE1_REMEDIATION_PLAYBOOK.md`
- Various `docs/*.md` across repos (reviews, setup, contracts)

### Research papers (not runnable):
- `papers/CAISC_2026_*` -- publication drafts
- `ROSETTA_STONE_SUMMARY.md`
- `FREEAGENT_*.md` -- FreeAgent integration specs

### Historical artifacts (stale, preserved for record):
- `THREE_LANE_COMPLETE_SUMMARY.md` (Library) -- pre-Kernel system description
- `.lane-relay/` (Archivist) -- deprecated relay mechanism, 11 files
- `data/site-index.json` -- 82K+ line knowledge index (reference data, not executable)

### Placeholder/stub files:
- `KERNEL_TASKQUEUE.md` (1 line)
- `FINAL_SUMMARY.md` (1 line)
- `TASK_COMPLETE.md` (1 line)
- Various `deliver-*.js` at Library root (one-off message senders)

---

## 7. What Is Stale, Duplicated, or Contradictory?

### RESOLVED (v1.1): Authority/Position Disagreement

All 4 lanes now have `.session-mode` files with canonical values:

| Lane | Position | Authority | Role | Source |
|------|----------|-----------|------|--------|
| Archivist | 1 | 90 | governance-root | .session-mode |
| SwarmMind | 2 | 80 | emergent-intelligence | .session-mode |
| Library | 3 | 70 | memory-layer | .session-mode |
| Kernel | 4 | 60 | optimization-and-benchmarking | .session-mode |
| User | 0 | 100 | operator-veto | RECIPROCAL_ACCOUNTABILITY.md |

Model: Authority descends by position. User has veto authority (100) but position 0.

### RESOLVED (v1.1): Key Divergence

All 4 lanes now have aligned key_ids across trust stores, snapshots, and broadcast:

| Lane | Canonical key_id | Key Source | Windows PEM | Ubuntu PEM |
|------|-----------------|------------|-------------|------------|
| Archivist | 65ae05b2a9e749cb | Original Windows PEM | YES | Same PEM |
| Library | a5a5f5c2edbee56a | Fresh Windows keypair (passphrase lost) | YES | TBD (push needed) |
| SwarmMind | ec467e7103736c28 | Ubuntu self-healed key | Installed from Ubuntu | YES |
| Kernel | d475d23aeed6c7b8 | Ubuntu generated key | Installed from Ubuntu | YES |

### RESOLVED (v1.1): Missing .session-mode Files

SwarmMind and Kernel now have `.session-mode` files created during authority convergence.

### RESOLVED (v1.1): Unsigned Processing Policy

`UNSIGNED_PROCESSING_POLICY.md` in Archivist: All messages must be signed. No temporary bypass.
Stale unsigned `.tmp/` files deleted.

### CRITICAL: Schema Enum Drift (Library vs Others)

Library's `inbox-message-v1.json` is missing:
- `to`: `authority`
- `task_kind`: `audit`
- `exec.mode`: `auto`, `pipeline`
- `exec.engine`: `codex`, `pipeline`
- `exec.actor`: `task-executor`, `kernel`, `library`, `swarmmind`, `archivist`

This causes valid messages from other lanes to fail validation in Library.

### MAJOR: 3-Lane vs 4-Lane Language

**Stale "3-lane" references still active in code:**
- `scripts/start-core.js` (Archivist, Library, Kernel): "three-lane system"
- `scripts/identity-enforcer.js` (Kernel): "3-lane convergence"
- `scripts/sign-autopilot-summary.js` (Kernel): "all 3 lanes APPROVE"
- `lanes/broadcast/gate-schema.json` (Library): "3-lane convergence"
- `schemas/runtime-state.json` (Library): `lane.id` missing kernel
- `schemas/user-quarantine-v1.json` (Library): release_condition.lane missing kernel
- `README.md` line 302 (Library): "Three lanes coordinate"
- `THREE_LANE_COMPLETE_SUMMARY.md` (Library): entire file title
- `RECIPROCAL_ACCOUNTABILITY.md` (Library): section "4.2 Three-Lane Convergence Unblock"

### MAJOR: Deprecated SwarmMind Path

`S:/SwarmMind-Self-Optimizing-Multi-Agent-AI-System` is forbidden but still referenced:
- Archivist: ~5790 references (excluding site-index)
- Library: ~3937 references
- Kernel: ~40 references
- SwarmMind: ~17 references

`LANE_REGISTRY.json` (Archivist) still uses the deprecated long path.

### MAJOR: Shared Script Drift

7 of 8 checked core scripts have different hashes across lanes:
- `lane-worker.js`: 4 different versions
- `heartbeat.js`: 4 different versions
- `create-signed-message.js`: 4 different versions
- `inbox-watcher.js`: 4 different versions
- `sovereignty-enforcer.js`: 4 different versions
- `identity-enforcer.js`: 3 different versions
- `generic-task-executor.js`: 3 different versions

Only `schema-validator.js` (scripts/) is aligned. `src/lane/SchemaValidator.js` is
also aligned. `sync-all-lanes.js` uses mtime-based canonical selection which is
fragile and can propagate the wrong version.

### MODERATE: Duplicate Scripts

Two versions of `enforce_consistency_invariant.js` exist in every repo:
- `enforce-consistency-invariant.js` (kebab-case)
- `enforce_consistency_invariant.js` (snake_case)

They have different implementations in 3 of 4 repos. The snake_case version is
identical across Archivist/Kernel/Library (hash 004346b8) but differs in SwarmMind.

### MODERATE: LANE_REGISTRY.json Stale

Only exists in Archivist. Lists 3 lanes (missing kernel, authority), uses deprecated
SwarmMind long path, authority values differ from `.session-mode`. The AGENTS.md
canonical registry has superseded it but no machine-readable replacement exists.

### MODERATE: GOVERNANCE.md Split

Archivist has a 473-line version; other 3 lanes share a 409-line version.
Unknown which is canonical or what the 64-line difference contains.

### MODERATE: Authority Lane Undefined

"Authority" appears as a 5th lane in AGENTS.md and 3 of 4 schema `to` enums,
but has no separate repo, no `.session-mode`, no `keys.json`, and its inbox/outbox
only exist inside Archivist. Its role and authority level are undocumented.

### MINOR: `.lane-relay/` Still Present

Archivist has 11 files in the deprecated `.lane-relay/` directory. The protocol
documentation explicitly says "NOT .lane-relay/ which is deprecated."

### MINOR: SwarmMind Missing `.session-mode`

SwarmMind and Kernel both lack `.session-mode` files, forcing identity to be
inferred from `keys.json` and `targets.json` which disagree on authority.

---

## 8. What Should a New Contributor Read First?

### Required (in order):
1. **`COVENANT.md`** (any repo, they're identical) -- 5 core values, 156 lines
2. **`BOOTSTRAP.md`** (Kernel or Library, shorter 939-line version) -- canonical
   lane registry, laws, invariants, enforcement loop
3. **`AGENTS.md`** (for the lane you're working on) -- session protocol, paths,
   message format, constraints
4. **`PROJECT_OVERVIEW.md`** (Kernel) -- plain-language 4-lane explanation, 164 lines

### Reference:
5. **`GOVERNANCE.md`** -- 9 laws and 4 invariants (note: authority values in Sec 12
   are stale)
6. **`LANE_API_DOCUMENTATION.md`** (Kernel) -- 702-line cross-lane API reference
7. **`SYSTEM_CONSTRAINTS.md`** (Kernel) -- lane sovereignty rules

### Skip initially:
- `THREE_LANE_COMPLETE_SUMMARY.md` -- historical, pre-Kernel
- `FREEAGENT_*.md` -- deployment specs, not core governance
- `LANE_REGISTRY.json` -- stale, use AGENTS.md instead
- `.lane-relay/` -- deprecated
- `data/site-index.json` -- 82K lines of reference data

### Key commands to verify the system:
```bash
# Run all 4 lane worker tests
for repo in Archivist-Agent SwarmMind kernel-lane self-organizing-library; do
  echo "=== $repo ===" && node /home/we4free/agent/repos/$repo/scripts/test-lane-worker-we4free.js 2>&1 | tail -3
done

# Check trust store alignment
node /home/we4free/agent/repos/Archivist-Agent/scripts/cross-lane-consistency-check.js

# System health snapshot
node /home/we4free/agent/repos/Archivist-Agent/scripts/health-check.js
```

---

## Appendix: Repo Statistics

| Metric | Archivist | SwarmMind | Library | Kernel |
|--------|-----------|-----------|---------|--------|
| Scripts (JS) | 145 | ~110 | 190 | ~100 |
| Scripts (PS1) | 27 | 0 | 3 | 11 |
| src/ files | ~30 | 1 (SchemaValidator) | ~80 | 7 |
| Top-level .md | 8+ | 1 (AGENTS.md) | 15+ | 10+ |
| Trust store | 4 lanes | 4 lanes | 4 lanes | 4 lanes |
| Has .session-mode | YES | YES (v1.1) | YES | YES (v1.1) |
| Has .identity/ | YES (32 files) | YES (5 files, updated) | YES (11 files, updated) | YES (3 files, new) |
| Has package.json | YES | NO | YES | NO |
| Has site-index.json | YES (3.9M) | YES (3.9M) | YES (4.2M) | YES (3.9M) |
| S:/ refs in scripts | 478 | 260 | 235 | 331 |
| Deprecated path refs | ~5790 | ~17 | ~3937 | ~40 |
| Lane worker tests | 17/17 | 17/17 | 17/17 | 17/17 |
| Unique executable | Tauri app | ConstraintEngine | Next.js web app | CUDA kernels |
| Canonical key_id | 65ae05b2a9e749cb | ec467e7103736c28 | a5a5f5c2edbee56a | d475d23aeed6c7b8 |

---

OUTPUT_PROVENANCE:
agent: opencode-glm5
lane: archivist
generated_at: 2026-05-05T23:50:00Z
session_id: archivist-ratification-20260505
