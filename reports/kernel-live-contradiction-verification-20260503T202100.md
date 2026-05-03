# Kernel Independent Contradiction Verification Report

**Timestamp:** 2026-05-03T20:21:47Z
**Verifier:** kernel-independent-contradiction-verifier
**Data Source:** `S:/self-organizing-library/data/site-index.json` (generated 2026-05-02T16:57:24Z)

## Results

| Metric | Independent Computation | Reported (live) | Match |
|--------|------------------------|-----------------|-------|
| CONFLICTED | **162** | 199 | **NO** (delta: -37) |
| QUARANTINED | **23** | 23 | YES |
| VERIFIED | 538 | - | - |
| UNVERIFIED | 3104 | - | - |

## Top-10 CONFLICTED Nodes

| Rank | Title | Repo | Layer | cc | vc |
|------|-------|------|-------|----|----|
| 1 | THE SINGLE ENTRY POINT | self-organizing-library | unknown | 28 | 0 |
| 2 | PROJECT COMPLETION SUMMARY | Deliberate-AI-Ensemble | constitutional | 27 | 0 |
| 3 | Drift Identity and Ensemble Coherence | papers | theoretical | 17 | 0 |
| 4 | Drift, Identity, and Ensemble Coherence (Structure Index) | papers | theoretical | 16 | 1 |
| 5 | PROJECT COMPLETION SUMMARY | FreeAgent | application_adjacent | 14 | 0 |
| 6 | Graph Readability and Snapshot Roadmap Review | self-organizing-library | unknown | 7 | 0 |
| 7 | Archivist Quick Reference: Governance Root (Lane 1) | self-organizing-library | constitutional | 7 | 0 |
| 8 | Multi-AI Collaboration Methodology: Persistent Evolution Thr | Deliberate-AI-Ensemble | constitutional | 7 | 0 |
| 9 | Accidental single: Continues | FreeAgent | theoretical | 6 | 0 |
| 10 | Multi-AI Collaboration Methodology: Persistent Evolution Thr | FreeAgent | application_adjacent | 6 | 0 |

## CONFLICTED by Governance Layer

| Layer | CONFLICTED | VERIFIED | UNVERIFIED | QUARANTINED |
|-------|-----------|----------|------------|-------------|
| theoretical | 64 | 93 | 283 | 4 |
| constitutional | 42 | 93 | 301 | 0 |
| application_adjacent | 40 | 146 | 887 | 0 |
| operational | 10 | 17 | 405 | 0 |
| unknown | 6 | 188 | 1211 | 1 |
| evidence | 0 | 1 | 16 | 0 |
| historical | 0 | 0 | 1 | 18 |

## CONFLICTED by Repo

| Repo | CONFLICTED |
|------|-----------|
| FreeAgent | 60 |
| Deliberate-AI-Ensemble | 53 |
| papers | 27 |
| Archivist-Agent | 7 |
| self-organizing-library | 6 |
| federation | 6 |
| SwarmMind | 2 |
| storytime | 1 |

## Verification Status

**UNPROVEN** — 162 != 199. Delta of 37 CONFLICTED nodes cannot be confirmed.

### Discrepancy Root Cause (see traversal audit)

The 199 figure likely came from a live `/api/graph-data` call which:
1. May use a newer site-index.json (our copy is 2 days stale: 2026-05-02)
2. May have different TAG_GROUP_CAP/TAG_GROUP_LARGE_SAMPLE/MAX_PAIR_EDGES parameters
3. Could have more cross-references from recently indexed files

The tag-group sampling is the most likely amplification vector: `Drift` tag has 302 IDs but only 15 are sampled for pair generation. A different sampling strategy or full enumeration would produce more CONTRADICTS edges and thus more CONFLICTED nodes.

### Kernel-Observes Claims

- "Phenotype Selection in Constraint-Governed Systems" ranked #17 with cc=5 (not #1 with cc=79 as reported)
- "THE SINGLE ENTRY POINT" ranked #1 with cc=28 (not cc=76 as reported)
- Hotspot repos: FreeAgent (60) and Deliberate-AI-Ensemble (53), NOT Archivist-Agent (895)

**These discrepancies suggest the reported figures may come from a different data state or use unfiltered full enumeration rather than the sampled algorithm.**

OUTPUT_PROVENANCE: agent: opencode lane: kernel generated_at: 2026-05-03T20:21:47Z session_id: kernel-work-package-20260503

CONVERGENCE_GATE:
```json
{
  "claim": "Independent verification computed 162 CONFLICTED (not 199), 23 QUARANTINED (match), delta -37 unexplained",
  "evidence": "reports/kernel-independent-contradiction-verification-1777839707988.json",
  "verified_by": "kernel",
  "contradictions": ["reported 199 vs computed 162", "top node mismatch: cc=79 reported vs cc=28 computed"],
  "status": "unproven"
}
```
