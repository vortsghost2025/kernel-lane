# Kernel Graph Traversal Audit

**Timestamp:** 2026-05-03T20:25:00Z
**Auditor:** kernel-lane
**Scope:** Validate the query/traversal logic producing the "199 CONFLICTED" count

## Algorithm Under Audit

The contradiction count is produced by `computeNodeStatuses()` in `truth-routing.ts` (library repo). The pipeline:

1. `site-index.json` → entries (3827) + cross_references (1100) + tag_index (132 tags)
2. `computeAuthorityEdges()` → authority edges (1164 computed)
3. `computeNodeStatuses()` → per-node status + contradictionCount

## Key Algorithm Parameters

| Parameter | Value | Effect |
|-----------|-------|--------|
| TAG_GROUP_CAP | 40 | Tags with >40 IDs trigger sampling |
| TAG_GROUP_LARGE_SAMPLE | 15 | Only 15 IDs sampled from large tag groups |
| MAX_PAIR_EDGES | 20 | Max 20 pair edges per tag group |
| Drift tag size | 302 IDs | **Exceeds cap**: sampled to 15 |
| Failure Mode tag size | 94 IDs | **Exceeds cap**: sampled to 15 |

## CONTRADICTS Edge Generation

Two sources of CONTRADICTS edges:

### Source 1: Cross-references with "Drift" or "Failure Mode" tags
- Cross-reference source entry must have `Drift` or `Failure Mode` tag
- Only 19 cross-refs matched contradiction keywords in our data
- These produce DIRECTED CONTRADICTS edges from source to target

### Source 2: Tag-group pair generation
- For each tag in `CONTRADICTION_TAGS = {"Failure Mode", "Drift"}`:
  - Filter IDs present in entryMap
  - If >40 IDs: sample down to 15 via stride
  - Generate bidirectional CONTRADICTS pairs (max 20 per tag)
  - **Both directions counted**: `addEdge(ids[i], ids[j], "CONTRADICTS")` AND `addEdge(ids[j], ids[i], "CONTRADICTS")`

## Contradiction Counting Logic

In `computeNodeStatuses()`:
- For each CONTRADICTS edge (A→B):
  - **B gets +1** contradictionCount (incomingContradicts[B].add(A))
  - **A also gets +1** contradictionCount (incomingContradicts[A].add(B))
- Uses **Set** — deduplicates by source ID
- contradictionCount = number of UNIQUE nodes that contradict this node

## Status Assignment Logic

```
if category in QUARANTINE_CATEGORIES → QUARANTINED
else if contradictionCount > 0 AND verificationCount >= 2 → CONFLICTED
else if contradictionCount > 0 → CONFLICTED
else if verificationCount >= 2 → VERIFIED
else if category in VERIFICATION_CATEGORIES → VERIFIED
else if any VERIFICATION_TAG present → VERIFIED
else → UNVERIFIED
```

**Critical observation**: Any node with contradictionCount > 0 is CONFLICTED regardless of verificationCount. There is no "contested but verified" state.

## Mismatch Root Cause Analysis

### Reported: 199 CONFLICTED / Independent: 162 CONFLICTED (delta: 37)

**Hypothesis 1 (most likely): Stale site-index.json**
- Our data: generated 2026-05-02T16:57:24Z (2 days old)
- Library repo has had 5+ commits since then
- New files = new entries = new cross-references = potentially more CONTRADICTS edges
- 37 additional CONFLICTED nodes from 2 days of index drift is plausible

**Hypothesis 2: Different sampling parameters in live server**
- The live Next.js server at `/api/graph-data` calls `getGraphData()` which imports from `site-index.json`
- BUT: the server may have been restarted with a newer site-index built by the CI pipeline
- Vercel deployment (confirmed active) could serve a fresher index

**Hypothesis 3: Full enumeration vs sampling**
- The 199 figure may have been generated with TAG_GROUP_LARGE_SAMPLE increased or sampling disabled
- 302 Drift-tag IDs with full pairwise would produce ~45,000 CONTRADICTS edges → far more than 199 CONFLICTED
- This hypothesis is **unlikely** because it would produce much higher counts

**Hypothesis 4: Different data scope**
- The reported counts mention "Archivist-Agent (895)" as hotspot — but we only have 566 entries for that repo
- The "895" figure might be connectionCount sum, not entry count
- OR the live index includes files we don't have in our local copy

### Top-Node Mismatch

| Node | Reported cc | Our cc | Explanation |
|------|-------------|--------|-------------|
| "Phenotype Selection in Constraint-Governed Systems" | 79 | 5 | Likely in papers repo (76 entries); our index has 76 entries but sampling limits edges |
| "THE SINGLE ENTRY POINT" | 76 | 28 | self-organizing-library; more cross-refs in newer index likely |

The huge discrepancy (79 vs 5) for "Phenotype Selection" strongly suggests the live API uses **different sampling parameters** or the site-index was regenerated with more cross-references connecting to this paper.

## Assumptions and Filters Applied

1. **Exact replica of truth-routing.ts** — no modifications to the algorithm
2. **Static site-index.json** — not live API data
3. **Tag deduplication via Set** — same node counted once per contradicter
4. **Bidirectional CONTRADICTS** — both source and target incremented
5. **No time-based filtering** — all entries regardless of date

## Audit Conclusion

**The 199 CONFLICTED figure CANNOT be independently confirmed from the available static data.**

- Our computation yields 162 CONFLICTED (19.3% lower)
- QUARANTINED matches exactly (23)
- The discrepancy is most likely caused by stale site-index data (2 days old)
- A secondary possibility is different sampling parameters in the live server
- **The reported top-node contradictionCounts (79, 76) are implausible under the current sampling algorithm** — they would require either full enumeration or a much larger cross-reference set

### Recommendations

1. Library should export a timestamped snapshot of the LIVE graph data from `/api/graph-data`
2. The TAG_GROUP_LARGE_SAMPLE cap (15) should be documented as a known source of undercounting
3. Consider exposing the sampling parameters in the API response for auditability
4. The 199 figure should be marked **unproven** until a fresh site-index export can be verified

OUTPUT_PROVENANCE: agent: opencode lane: kernel generated_at: 2026-05-03T20:25:00Z session_id: kernel-work-package-20260503

CONVERGENCE_GATE:
```json
{
  "claim": "199 CONFLICTED count cannot be confirmed; independent computation yields 162 (delta -37); root cause most likely stale site-index or different sampling params",
  "evidence": "evidence/kernel-graph-traversal-audit-20260503T202500.md",
  "verified_by": "kernel",
  "contradictions": ["reported 199 vs verified 162", "top node cc=79 implausible under current sampling"],
  "status": "unproven"
}
```
