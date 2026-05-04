# WE4FREE Publication Roadmap

**Date:** 2026-04-29
**Status:** ACTIVE
**Owner:** Sean (operator), all lanes (evidence producers)

---

## Current Inventory

| Artifact | Status | Words | Location |
|----------|--------|-------|----------|
| Paper A: Noether Rosetta Stone | COMPLETE | ~8,500 | `S:/federation/originals/PAPER_A_NOETHER_ROSETTA_COMPLETE_20260214.md` |
| Paper B: WE Framework / Noether | COMPLETE | ~15,000 | `S:/federation/originals/PAPER_B_WE_FRAMEWORK_NOETHER_20260214.md` |
| Paper C: Domain Invariance Empirical | COMPLETE | ~7,500 | `S:/federation/originals/PAPER_C_DOMAIN_INVARIANCE_EMPIRICAL_20260428.md` |
| Paper 1: The Rosetta Stone | COMPLETE | ~10,200 | Archivist repo `papers/paper1.txt` |
| Paper 2: Constraint Lattices | COMPLETE | ~8,100 | Archivist repo `papers/paper2.txt` |
| Paper 3: Phenotype Selection | COMPLETE | ~7,800 | Archivist repo `papers/paper3.txt` |
| Paper 4: Drift, Identity, Ensemble | COMPLETE | ~7,600 | Archivist repo `papers/paper4.txt` |
| Paper 5: WE4FREE Framework | COMPLETE (needs errata) | ~11,400 | Archivist repo `papers/paper5.txt` |
| Paper 6 (F): Failure Modes, Limits, Self-Correction | DRAFT FOR REVIEW | ~8,500 | Library `book-6-...md` |
| CAISC 2026 Draft | DRAFT (3 pillars integrated) | ~6,500 | `S:/Archivist-Agent/papers/CAISC_2026_DRAFT.md` |
| OSF Preprint | SUBMITTED | summary | https://osf.io/n3tya |
| Medium Articles | 10+ PUBLISHED | varies | Library `publications.ts` |
| Subagent Contract (SBC v2.0) | PUBLISHED | contract | `docs/ops/SWARMIND_SUBAGENT_CONTRACT.md` |

---

## Phase 1: Paper F Revision (overdue)

**Goal:** Bring Paper F from DRAFT to reviewable.

### Gaps to Close

| Gap | What's Missing | Evidence Source | Priority |
|-----|----------------|-----------------|----------|
| NFM-029 through NFM-035 | 7 new failure modes from subagent validation | `library/docs/failure-modes/INDEX.md` | P0 |
| Subagent pipeline evidence | Batch execution: 8/8, 0% error, ~4.2s/task | This session | P0 |
| SBC v2.0 integration | 7 execution verbs, 19 failure modes, bounded automation | `docs/ops/SWARMIND_SUBAGENT_CONTRACT.md` | P1 |
| Paper E errata count update | Paper F says "8 errors" - may need update | Cross-reference paper5.txt vs actual | P2 |
| Delegated automation as phenotype | SwarmMind = phenotype selection in production | Batch test evidence | P1 |

---

## Phase 2: CAISC 2026 Draft (DONE — needs final review)

**Goal:** 8-12 page conference paper with triple-domain evidence.

### Current State
- ✅ Abstract updated with simulation pillar
- ✅ Section 6 (Simulation Validation) added with adversarial, hardening, paradox harmonization evidence
- ✅ Conclusion strengthened with triple-domain convergence language
- ✅ Contribution list updated to 5 contributions (was 4)
- ✅ Sections renumbered (1-9)

### Remaining for Submission
- [ ] Final read-through for flow and consistency
- [ ] Format to CAISC template (page count check)
- [ ] Author order / affiliation confirmation
- [ ] Reference formatting (CAISC style)

---

## Phase 3: Paper G Proposal (1-2 weeks)

**Goal:** Sketch Paper G — Delegated Bounded Automation as Phenotype Selection.

### Thesis
Paper C says stable behaviors emerge as attractors when constraints interact with selection. The subagent pipeline IS Paper C in production: SwarmMind doesn't decide to execute — the constraint lattice (schema, signatures, path safety, write protection) selects which actions are possible, and the Subagent Contract IS the phenotype that emerged.

---

## Phase 4: Next Papers (not yet started)

| Paper | Thesis | Evidence Available | Priority |
|-------|--------|--------------------|----------|
| Exponential Lattice Formalization | Define the lattice mathematically: phases as nodes, composition as partial order, constraints as meet; show 2^n behavioral space; prove phenotype selection is fixed point | All simulation phase data | High |
| Earth/Space Dual-Domain | Two different constraint lattices on same invariant set; same invariants survive in both; different failure modes; self-correcting loop with different cost functions | Phase 11 simulation data | Medium |
| Paper I: Adversarial Governance Decay | Phase 8's 12 adversarial probes ARE the evidence | Phase 8 data | Medium |

---

## Phase 5: Publication Pipeline (ongoing)

| Channel | What Goes There | Status |
|---------|----------------|--------|
| OSF | Preprints of Papers A-G | A-E summary submitted, F pending, C new |
| Medium | Individual findings, blog-style | 10+ published |
| arXiv | Formal paper submissions | Not yet started |
| CAISC 2026 | Conference paper | Draft complete with 3 pillars, needs formatting |
| GitHub | Code, governance docs, contracts | All 4 repos active |

### Action Items
- [ ] Paper F revision — incorporate NFM-029 to NFM-035
- [ ] Paper F submission to OSF as preprint
- [ ] Paper C submission to OSF as preprint
- [ ] CAISC 2026 final formatting and submission
- [ ] Paper G proposal written
- [ ] Exponential lattice formalization paper
- [ ] Earth/Space dual-domain paper
- [ ] arXiv submission (when ready)

---

## Evidence Trail

1. **35 named failure modes** documented in `library/docs/failure-modes/INDEX.md`
2. **19 SBC failure modes** documented in `docs/ops/SWARMIND_SUBAGENT_CONTRACT.md`
3. **Subagent batch validation**: 8 tasks, 0 errors, ~34s total
4. **Recovery test suite**: 11/11 PASS across all 4 lanes
5. **Execution gate test**: 10/10 PASS across all 4 lanes
6. **Artifact resolver test**: 8/8 PASS across all 4 lanes
7. **Cross-lane consistency**: all green, 0 contradictions, trust store hash 58a8aad5aa6597fe
8. **DER key_ids**: archivist=506c2d0838b6862c, kernel=127b44d2bb294ad9, library=2eec06be0befc8d5, swarmmind=1450972ce0a225b7
9. **Simulation validation**: 98+ tests, 12/12 adversarial probes, Phase 13 threshold proofs, Phase 23 paradox harmonization
10. **PAPER_C**: Domain invariance as empirical fact — bridge paper complete

**All evidence is cryptographically signed and stored in the lane system.**
