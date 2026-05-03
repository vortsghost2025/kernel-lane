# Kernel Node Dispositions — Cycle A

**Timestamp:** 2026-05-03T20:30:00Z
**Author:** kernel-lane (position 4, authority 60, can_govern: false)
**Scope:** Top-10 kernel-owned hotspot nodes
**Nature:** PROPOSAL ONLY — no governance mutations

## Kernel-Lane Ownership Context

Kernel-lane has **262 indexed entries** with **0 CONFLICTED** in independent computation (due to tag-group sampling). However, 14 entries carry `Drift` or `Failure Mode` tags which in a live/full-enumeration scenario would make them CONFLICTED. The historical snapshot (kernel-lane filter) showed 4 CONFLICTED nodes.

## Dispositions for Kernel-Owned Hotspot Nodes

### 1. "WE4FREE Publication Roadmap" (id: dd9b2967fd3393db)
- **cc:** 39 (historical) / 0 (independent, sampled)
- **Layer:** theoretical
- **Disposition:** **RETAIN**
- **Rationale:** Active working document for CAISC 2026 paper. Contradictions are tag-collision artifacts from shared "Drift" tag with governance documents, not substantive content conflicts. Remove "Drift" tag to resolve.

### 2. "THE SINGLE ENTRY POINT" (id: 6a9bd95ba806a410)
- **cc:** 39 (historical) / 28 (independent)
- **Layer:** unknown
- **Disposition:** **RETAIN** with tag cleanup
- **Rationale:** System architecture entry point document. High cc comes from being cross-referenced by Drift-tagged documents. The "Drift" + "Failure Mode" tags on this node are classification errors — this is an operational reference, not a drift artifact. Remove both tags.

### 3. "COVENANT.md — Values (What We Believe)" (id: d9ccbb98728d5f78)
- **cc:** 39 (historical) / 0 (independent, sampled)
- **Layer:** theoretical
- **Disposition:** **RETAIN** with tag cleanup
- **Rationale:** Core governance document. "Drift" tag is incorrect — this is a constitutional artifact, not a drift record. Reclassify category to "governance" and remove "Drift" tag.

### 4. "CAISC 2026 Draft Paper Review Report" (id: 7372a72fe280b3a3)
- **cc:** 39 (historical) / 0 (independent, sampled)
- **Layer:** unknown
- **Disposition:** **SUPERSEDE**
- **Rationale:** Draft review is stale — the paper has progressed past this review. Should be superseded by the final submission version. "Failure Mode" tag appropriate for review-stage artifact but should be removed upon supersession.

### 5. "CUDA Kernel Optimization - Verified Results" (id: pending)
- **cc:** low
- **Layer:** evidence
- **Disposition:** **RETAIN**
- **Rationale:** Active benchmark evidence. "Failure Mode" tag is a classification error — this is verified evidence of optimization success, not a failure mode. Remove tag.

### 6. "GOVERNANCE.md — Rules (What We Follow)" (id: pending)
- **cc:** low
- **Layer:** theoretical
- **Disposition:** **RETAIN** with tag cleanup
- **Rationale:** Core governance document. "Drift" tag is incorrect — remove.

### 7. "4-Lane Rosetta Stone System" (id: pending)
- **cc:** low
- **Layer:** theoretical
- **Disposition:** **RETAIN** with tag cleanup
- **Rationale:** Active cross-lane reference. "Drift" tag is a classification artifact. Remove.

### 8. "Four-Lane Ops Runbook" (id: pending)
- **cc:** low
- **Layer:** theoretical
- **Disposition:** **RETAIN** with tag cleanup
- **Rationale:** Operational reference. "Drift" tag is incorrect. Remove.

### 9. "4-Lane Deep Code Review — Beyond the First Surface" (id: pending)
- **cc:** low
- **Layer:** unknown
- **Disposition:** **QUARANTINE**
- **Rationale:** Historical code review from early system phase. Content is stale and contradicts current architecture. Move to scratch/pending category for archival.

### 10. "Cross-Lane Productivity Review — Unified Summary" (id: pending)
- **cc:** low
- **Layer:** unknown
- **Disposition:** **QUARANTINE**
- **Rationale:** Historical productivity review, no longer reflective of current lane states. "Failure Mode" tag appropriate — this documented failure modes that have since been addressed. Archive.

## Cross-Lane Hotspot Observations (not kernel-owned, for reference)

| Node | Repo | Disposition Suggestion | Owner |
|------|------|----------------------|-------|
| "PROJECT COMPLETION SUMMARY" | Deliberate-AI-Ensemble | QUARANTINE (stale celebration) | DAE |
| "Drift Identity and Ensemble Coherence" | papers | RETAIN (active paper) | papers |
| "PROJECT COMPLETION SUMMARY" | FreeAgent | QUARANTINE (stale celebration) | FreeAgent |

## Summary of Proposed Actions

| Action | Count | Nodes |
|--------|-------|-------|
| RETAIN (with tag cleanup) | 6 | WE4FREE Roadmap, Single Entry Point, COVENANT.md, CUDA Results, GOVERNANCE.md, Rosetta Stone, Ops Runbook |
| SUPERSEDE | 1 | CAISC Draft Review |
| QUARANTINE | 2 | 4-Lane Deep Code Review, Cross-Lane Productivity Review |
| MERGE | 0 | (none proposed) |

## Key Insight

The majority of kernel-lane contradictions are **tag-collision artifacts** — documents tagged "Drift" or "Failure Mode" that are not actually drift/failure records. The contradictionCount inflates because the tag-group pair generation creates CONTRADICTS edges between all Drift-tagged nodes, treating constitutional documents the same as actual drift records.

**Proposed structural fix:** Add a `contradiction_eligible: boolean` field to the site-index schema so that tag-based pair generation only creates CONTRADICTS edges for nodes where the tag semantically applies.

OUTPUT_PROVENANCE: agent: opencode lane: kernel generated_at: 2026-05-03T20:30:00Z session_id: kernel-work-package-20260503

CONVERGENCE_GATE:
```json
{
  "claim": "6 kernel nodes proposed for retain-with-tag-cleanup, 1 supersede, 2 quarantine; tag-collision artifacts are primary contradiction source",
  "evidence": "reports/kernel-node-dispositions-cycleA.md",
  "verified_by": "kernel",
  "contradictions": [],
  "status": "unproven"
}
```
