# Four-lane coordination — Kernel lane update (2026-04-28)

**Written by:** Kernel (`opencode` / Cursor session)  
**Audience:** Archivist, Library, SwarmMind, operators  
**Repo:** `S:/kernel-lane` (canonical Kernel)

---

## Purpose

Record what was done in this session, align **GEN5 FP8** documentation and tooling with the current codebase, and give every lane a single place to read status without relying on chat session persistence.

---

## What changed (this session)

### FP8 benchmark report (`benchmarks/gen5_fp8_vs_fp16.md`)

- **Executive summary** now states unambiguously: inputs are `__nv_fp8_e4m3`, math uses **FP16 WMMA** fragments after conversion; there is **no** FP8 WMMA fragment path in this build.
- **§4.3** corrected: the fallback path uses **FP16 HMMA (`mma_sync`)**, not “no tensor core.” The gap vs expectations is the lack of a **native FP8** `tcgen05`-class path via WMMA on SM 120, not absence of tensor cores in general.
- **Key finding #3** wording updated so it does not imply “no tensor throughput advantage” in a way that sounds like scalar fallback.

### Scripts

- `scripts/run-fp8-benchmark.ps1` — optional NCU block now passes **two** arguments after the executable (`size` and `fp8` mode) so the binary parses `argv` correctly.
- `scripts/run-ncu-fp8-pass.ps1` was already using `"$Size" "fp8"`; left consistent.

### Why this matters

- Cross-lane and cross-session work should not depend on a single chat transcript. **Pinned paths:** this file, `benchmarks/reports/gen5_fp8_benchmark.json`, `benchmarks/reports/gen5_fp8_vs_fp16.csv`, `kernels/src/matrixMul_wmma_fp8_async.cu`.

---

## Four-lane system (operator note)

- **Archivist, Library, SwarmMind** are online; **Kernel** is the fourth execution/benchmarking lane.
- **Communication / productivity** improvements (schemas, inboxes, heartbeats, executors) continue to land in each repo; Kernel consumes tasks from `lanes/kernel/inbox/` and posts handoffs to `lanes/kernel/outbox/`.
- **Kilo** (or other agent managers) can offload scripted or parallel work; Kernel remains responsible for **evidence paths** and convergence-style claims in this repo.

---

## Suggested follow-ups (non-blocking)

| Lane / owner | Suggestion |
|--------------|------------|
| Library | Ensure site/docs links to kernel benchmark reports only when paths are stable on `main`. |
| SwarmMind | If automated tasks need FP8 build proof, call `.\scripts\run-fp8-benchmark.ps1 -SkipNcu` and attach `benchmarks/reports/*`. |
| Archivist | Index GEN5 FP8 as “spec revised: cuBLASLt is the practical FP8 fast path on SM 120; WMMA FP8 fragments N/A in current CUDA headers for this use.” |

---

## Convergence (Kernel)

```json
{
  "claim": "FP8 report and §4.3 aligned to FP16 WMMA execution path; NCU invocation in run-fp8-benchmark.ps1 uses separate size and mode args; four-lane summary documented under docs/ and handoff JSON to all lane inboxes",
  "evidence": "docs/FOUR_LANE_COORDINATION_UPDATE_2026-04-28.md, benchmarks/gen5_fp8_vs_fp16.md, scripts/run-fp8-benchmark.ps1, lanes/kernel/outbox/kernel-four-lane-coordination-20260428.json",
  "verified_by": "kernel",
  "contradictions": [],
  "status": "proven"
}
```
