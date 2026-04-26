# WE4FREE Publication Roadmap

**Date:** 2026-04-26
**Status:** ACTIVE
**Owner:** Sean (operator), all lanes (evidence producers)

---

## Current Inventory

| Artifact | Status | Words | Location |
|----------|--------|-------|----------|
| Paper A: The Rosetta Stone | COMPLETE | ~10,200 | `papers/paper1.txt` |
| Paper B: Constraint Lattices | COMPLETE | ~8,100 | `papers/paper2.txt` |
| Paper C: Phenotype Selection | COMPLETE | ~7,800 | `papers/paper3.txt` |
| Paper D: Drift, Identity, Ensemble | COMPLETE | ~7,600 | `papers/paper4.txt` |
| Paper E: WE4FREE Framework | COMPLETE (needs errata) | ~11,400 | `papers/paper5.txt` |
| Paper F: Failure Modes, Limits, Self-Correction | DRAFT FOR REVIEW | ~8,500 | Library `book-6-...md` |
| CAISC 2026 Outline | OUTLINE ONLY | outline | `CAISC_2026_PAPER_OUTLINE.md` |
| CAISC 2026 Abstract | DRAFT | 498 words | `CAISC_2026_ABSTRACT.md` |
| OSF Preprint | SUBMITTED | summary | https://osf.io/n3tya |
| Medium Articles | 10+ PUBLISHED | varies | Library `publications.ts` |
| Subagent Contract (SBC v2.0) | PUBLISHED | contract | `docs/ops/SWARMIND_SUBAGENT_CONTRACT.md` |

---

## Phase 1: Paper F Revision (now - 48h)

**Goal:** Bring Paper F from DRAFT to reviewable.

### Gaps to Close

| Gap | What's Missing | Evidence Source | Priority |
|-----|----------------|-----------------|----------|
| NFM-029 through NFM-035 | 7 new failure modes from subagent validation | `library/docs/failure-modes/INDEX.md` | P0 |
| Subagent pipeline evidence | Batch execution: 8/8, 0% error, ~4.2s/task | This session | P0 |
| SBC v2.0 integration | 7 execution verbs, 19 failure modes, bounded automation | `docs/ops/SWARMIND_SUBAGENT_CONTRACT.md` | P1 |
| Paper E errata count update | Paper F says "8 errors" - may need update | Cross-reference paper5.txt vs actual | P2 |
| Delegated automation as phenotype | SwarmMind = phenotype selection in production | Batch test evidence | P1 |

### Paper F Sections to Update

1. **1.1**: Update "8 errors in Paper E" count if more found
2. **2 (Failure Modes)**: Add NFM-029 through NFM-035 as Category 8 (Subagent/Delegation Failure Modes)
3. **3 (Formal Limits)**: Add autonomy limit: delegated lanes can read beyond own boundary (NFM-032)
4. **4 (Self-Correcting Loop)**: Add subagent batch validation as evidence that the loop works at scale
5. **New appendix**: Subagent Contract as operational artifact

---

## Phase 2: CAISC 2026 Draft (48h - 1 week)

**Goal:** Write 8-12 page conference paper from outline.

### What the Outline Has
- Research question, contribution claims, system architecture
- Failure case documented (state-claim divergence)
- Runtime verification fix (proof-gated execution)

### What the Outline Needs
- **Section 4 (Failure Case)**: Write from NFM-002 evidence + the original incident
- **Section 5 (Detection)**: Proof vs. claim framework - now with 35 NFMs, not 3
- **Section 6 (Runtime Fix)**: Verification gates, subagent contract, bounded automation
- **Section 7 (Evaluation)**: Batch test data (8/8, 0% error, 4.2s/task) + recovery suite (11/11 PASS)
- **Section 8 (Implications)**: Delegated bounded automation as a new governance pattern

### Key Quantitative Results to Include

| Metric | Before Fix | After Fix |
|--------|-----------|-----------|
| State verification checks passing | 0/3 | 3/3 |
| Recovery test suite | CONFLICTED | 11/11 PASS |
| Execution gate tests | FAIL | 10/10 PASS |
| Artifact resolver tests | FAIL | 8/8 PASS |
| Cross-lane consistency | DRIFTED | Consistent (0 contradictions) |
| Subagent batch execution | N/A | 8/8, 0% error, ~4.2s/task |
| Named failure modes | 3 | 35 |
| Schema-validated message routing | None | Full pipeline (sign-admit-execute-deliver) |

---

## Phase 3: Paper G Proposal (1 week - 2 weeks)

**Goal:** Sketch Paper G - Delegated Bounded Automation as Phenotype Selection.

### Thesis
Paper C says stable behaviors emerge as attractors when constraints interact with selection. The subagent pipeline IS Paper C in production: SwarmMind doesn't decide to execute - the constraint lattice (schema, signatures, path safety, write protection) selects which actions are possible, and the Subagent Contract IS the phenotype that emerged.

### What Paper G Would Contain
1. Formal mapping from Paper C's fixed-point operator to the Subagent Contract
2. Constraint lattice for delegated execution (signatures, schema, path bounds, write guards)
3. Empirical evidence: 0% error rate across mixed workloads
4. Failure modes as constraint refinement (NFM-029 through NFM-035)
5. Prediction: adding new execution verbs produces new failure modes, which produce new constraints

### Why This Matters
Paper F closed the loop (failure - detection - correction - constraint refinement). Paper G would show that the loop IS phenotype selection: the system doesn't design its behaviors, it selects them under constraint, and the selected behaviors are the ones that survive the failure mode test.

---

## Phase 4: Publication Pipeline (ongoing)

### Channels

| Channel | What Goes There | Status |
|---------|----------------|--------|
| OSF | Preprints of Papers A-G | A-E summary submitted, F pending |
| Medium | Individual findings, blog-style | 10+ published |
| arXiv | Formal paper submissions | Not yet started |
| CAISC 2026 | Conference paper | Outline + abstract done, draft pending |
| GitHub | Code, governance docs, contracts | All 4 repos active |

### Action Items
- [ ] Paper F revision - incorporate NFM-029 to NFM-035
- [ ] Paper F submission to OSF as preprint
- [ ] CAISC 2026 draft written
- [ ] Papers A-E errata document (gap between paper5.txt and reality)
- [ ] Paper G proposal written
- [ ] arXiv submission (when ready)

---

## Evidence Trail

This roadmap is grounded in the following verified evidence:

1. **35 named failure modes** documented in `library/docs/failure-modes/INDEX.md`
2. **19 SBC failure modes** documented in `docs/ops/SWARMIND_SUBAGENT_CONTRACT.md`
3. **Subagent batch validation**: 8 tasks, 0 errors, ~34s total
4. **Recovery test suite**: 11/11 PASS across all 4 lanes
5. **Execution gate test**: 10/10 PASS across all 4 lanes
6. **Artifact resolver test**: 8/8 PASS across all 4 lanes
7. **Cross-lane consistency**: all green, 0 contradictions, trust store hash 58a8aad5aa6597fe
8. **DER key_ids**: archivist=ee70b78105bc6189, kernel=b677eb87f6be83f9, library=ea2a75bab220adc2, swarmmind=addb0afb8ee5c2ed

**All evidence is cryptographically signed and stored in the lane system.**
