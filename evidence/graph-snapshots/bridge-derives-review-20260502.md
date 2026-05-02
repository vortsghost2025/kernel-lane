# Bridge-State and Derives-Without-Verifies Review

**Report ID:** bridge-derives-review-20260502
**Generated:** 2026-05-02T15:22:24.857Z
**Source:** kernel-lane
**Total Items:** 954

## Classification Summary

| Classification | Count | Percentage |
|---|---|---|
| state-correction-needed | 517 | 54.2% |
| verification-needed | 437 | 45.8% |
| ok-as-is | 0 | 0.0% |

## Bucket 5: Bridge-State Mismatches (798 items)

All 798 items have `bridgeState="unknown"` despite having constitutional or operational governance layers.

**Governance Layer Distribution:**

- operational: 420
- constitutional: 378

**Category Distribution (top 10):**

- governance: 293
- agent: 121
- code: 106
- architecture: 52
- config: 44
- web: 27
- public_html: 26
- distributed: 25
- attestation: 23
- ai: 17

## Bucket 6: Derives-Without-Verifies (156 items)

**Bridge State Distribution:**

- verified: 48
- contradicted: 43
- unknown: 35
- partial: 30

**False verification claims:** 48 nodes with bridgeState="verified" but 0 VERIFIES
**False contradiction claims:** 0 nodes with bridgeState="contradicted" but 0 contradictions

**Governance Layer Distribution:**

- theoretical: 78
- constitutional: 35
- unknown: 25
- application_adjacent: 15
- operational: 2
- historical: 1

## Overlap: Items in Both Buckets (16)

| ID | Title | Bridge State | Classification |
|---|---|---|---|
| 911a3576c8a9f8c9 | Claude Web Breakthrough Session - February 5, 2026 | unknown | state-correction-needed |
| 00ded50060d1e1bb | Constitutional Correction Event - February 7, 2026 | unknown | state-correction-needed |
| 65550e5eeff4e315 | Entry Timing Refinement - Candle Close + Reversal Confirmati | unknown | state-correction-needed |
| 4ef5036605153cae | Evidence of Real Multi-Agent Coordination Work | unknown | state-correction-needed |
| 9e290a7f26717867 | FORTRESS COGNITIVE INFRASTRUCTURE - EVIDENCE INDEX | unknown | state-correction-needed |
| 14f2a60ec1108ab4 | KuCoin API Integration - Implementation Summary | unknown | state-correction-needed |
| 001cf57fe30888fd | Live Trading Deployment Guide | unknown | state-correction-needed |
| 1949787e90859146 | The Moral Imperative: Why Waiting Until 2050 Guarantees the  | unknown | state-correction-needed |
| c4117f4b902d286e | Production Deployment Requirements | unknown | state-correction-needed |
| 4d2a7431482708a6 | PUBLICATION ROADMAP - FORTRESS COGNITIVE INFRASTRUCTURE | unknown | state-correction-needed |
| d61ab47a8d7df96b | Session Checkpoints - Deliberate AI Ensemble | unknown | state-correction-needed |
| 825dfccb35cdb68f | Session ID Persistence Validation - February 8, 2026 | unknown | state-correction-needed |
| 7eb83a68618bfa08 | Silent Failure Audit | unknown | state-correction-needed |
| 6ed2a206fcad6a0f | The Vision: Persistent Multi-AI Collaboration Environment | unknown | state-correction-needed |
| fe61cbdfb55fcb0e | 12. Monitoring Architecture | unknown | state-correction-needed |
| e4475a7ebe65427f | 37. Separation of Concerns Architecture | unknown | state-correction-needed |

## Governance Policy Recommendations

### POL-001: Enforce bridgeState-verificationCount consistency [high]

48 nodes claim bridgeState="verified" with 0 VERIFIES edges. Policy: bridgeState="verified" MUST NOT be set unless verificationCount >= 1.

### POL-003: Default bridgeState to unknown for new nodes [medium]

All 798 Bucket 5 items have bridgeState="unknown". Policy: new nodes MUST default to bridgeState="unknown" and transition only when evidence exists.

### POL-004: Require VERIFIES edges for derived claims above authority 50 [medium]

156 derived claims have 0 VERIFIES. High-authority derived claims propagate assumptions. Policy: nodes with authorityDepth >= 50 and derivesFromCount >= 1 MUST have at least 1 VERIFIES edge.

### POL-005: Periodic bridgeState audit [low]

Run bridge-state consistency checks as part of graph maintenance. Flag nodes where bridgeState conflicts with edge counts.

## Convergence Gate

```json
{
  "claim": "Classified 954 bridge-state and derives-without-verifies items into state-correction-needed, verification-needed, and ok-as-is categories with governance policy recommendations",
  "evidence": "evidence/graph-snapshots/bridge-derives-review-20260502.json",
  "verified_by": "kernel",
  "contradictions": [],
  "status": "proven"
}
```