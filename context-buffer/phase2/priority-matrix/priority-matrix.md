# Priority Matrix

**Version:** 1.0  
**Last Updated:** 2026-04-28  
**Workstream:** Prioritization (Workstream 2)  

---

## Scoring Framework

### Impact Score (I): 1-10

| Score | User Impact | System Impact | Business Impact |
|-------|-------------|---------------|-----------------|
| **10** | Critical failure, data loss | System down/blocker | Revenue loss, legal |
| **8-9** | Major feature broken | Severe degradation | Significant revenue |
| **6-7** | Feature degraded | Performance impact | Moderate revenue |
| **4-5** | Minor inconvenience | Slight slowdown | Small revenue effect |
| **1-3** | Cosmetic only | Negligible | None |

### Effort Score (E): 1-10

| Score | Person-Days | Complexity | Risk |
|-------|-------------|------------|------|
| **1** | <1 | Trivial | Low |
| **2-3** | 1-2 | Simple | Low |
| **4-5** | 3-5 | Moderate | Medium |
| **6-7** | 6-10 | Complex | Medium |
| **8-10** | 10+ | Very complex | High |

### Priority Score (P) = I² / E

**Rationale:** High impact items get exponentially higher priority, balanced by effort.

| Priority | Score Range | Action |
|----------|-------------|--------|
| **P0** | ≥50 | Immediate (Phase 2) |
| **P1** | 25-49 | Soon (Phase 2) |
| **P2** | 10-24 | Later (Phase 3) |
| **P3** | <10 | Future (Phase 4) |

---

## Constraint Priority Matrix

| ID | Constraint | Impact (I) | Effort (E) | Priority (P) | Phase | Owner |
|----|------------|-----------|-----------|-------------|-------|-------|
| **C001** | Path Traversal | 9 | 3 | **27.0** | 2 | Library |
| **C002** | Atomic Write | 9 | 5 | **16.2** | 1 | Kernel |
| **C003** | Trust Store | 8 | 4 | **16.0** | 2 | Library |
| **C004** | Tauri Injection | 8 | 3 | **21.3** | 2 | Archivist |
| **C005** | Schema Mismatch | 7 | 4 | **12.3** | 2 | SwarmMind |
| **C006** | LANE_REGISTRY | 7 | 2 | **24.5** | 2 | SwarmMind |
| **C007** | Timestamp Check | 7 | 3 | **16.3** | 2 | Library |
| **C008** | Delegation Contract | 7 | 5 | **9.8** | 3 | SwarmMind |
| **C009** | Hardcoded Paths | 5 | 3 | **8.3** | 3 | All |
| **C010** | Field Names | 4 | 2 | **8.0** | 3 | Library |
| **C011** | CSP Bypass | 5 | 2 | **12.5** | 2 | Archivist |
| **C012** | Proof Duplication | 4 | 2 | **8.0** | 3 | SwarmMind |
| **C013** | Schema Enums | 4 | 2 | **8.0** | 3 | SwarmMind |
| **C014** | Race Condition | 5 | 4 | **6.3** | 3 | Kernel |
| **C015** | Key ID Derivation | 3 | 2 | **4.5** | 4 | Archivist |

---

## Prioritization by Workstream

### Workstream 1: Discovery
**Use:** Focus validation efforts on high-priority constraints

| Priority | Constraints | Action |
|----------|-------------|--------|
| **P0** | C001, C004, C006, C011 | Validate thoroughly |
| **P1** | C002, C003, C005, C007 | Validate well |
| **P2** | C008, C009, C010, C012, C013 | Validate selectively |

### Workstream 2: Prioritization
**Use:** Drive Phase 2 pilot selection

| Batch | Constraints | Rationale |
|-------|-------------|-----------|
| **Pilot 1** | C001, C006 | High impact, medium effort, different domains |
| **Pilot 2** | C004, C011 | Security focus, same lane (Archivist) |
| **Future** | C003, C005, C007 | Foundational work |

### Workstream 3: Pilots
**Use:** Implementation roadmap

| Pilot | Constraints | Expected Impact |
|-------|-------------|-----------------|
| **Pilot 1** | C001, C006 | Path traversal + Registry (2 domains) |
| **Pilot 2** | C004, C011 | Security hardening (1 domain) |

---

## Dependency Graph

```
C002 (Atomic Write)
    ↓
    enables
    ↓
C014 (Race Conditions) - Future

C003 (Trust Store)
    ↓
    enables
    ↓
C008 (Delegation Contract)

C005 (Schema)
    ↓
    enables
    ↓
C013 (Schema Enums)

C004 (Tauri Injection)
    ↓
    related
    ↓
C011 (CSP Bypass)
```

---

## ROI Calculator

### Simple ROI Formula

```
ROI = (Impact × Frequency × Time Saved) / (Effort × Cost per Day)
```

**Assumptions:**
- Cost per person-day = $1,000
- Frequency = Incidents per month
- Time Saved = Hours saved per incident × Hourly rate ($100)

### Top 5 Constraints ROI

| ID | Constraint | Impact | Freq | Time Saved | Effort | Cost | ROI | Payback |
|----|------------|--------|------|-----------|--------|------|-----|---------|
| C001 | Path Traversal | 9 | 2/mo | 10hrs | 3d | $3k | 6.0 | 0.5mo |
| C006 | LANE_REGISTRY | 7 | 1/mo | 20hrs | 2d | $2k | 7.0 | 0.3mo |
| C004 | Tauri Injection | 8 | 0.5/mo | 40hrs | 3d | $3k | 5.3 | 0.6mo |
| C003 | Trust Store | 8 | 0.25/mo | 80hrs | 4d | $4k | 4.0 | 0.5mo |
| C011 | CSP Bypass | 5 | 0.25/mo | 40hrs | 2d | $2k | 5.0 | 0.4mo |

**All top 5 have positive ROI with <1 month payback!**

---

## Sequencing Recommendations

### Phase 2 (Months 1-2)

**Batch 1: High ROI, Independent**
1. C006 (LANE_REGISTRY) - 2 days
   - Fast win, enables other work
2. C001 (Path Traversal) - 3 days
   - Critical security fix
3. C004 (Tauri Injection) - 3 days
   - Parallel with C001

**Batch 2: Foundational**
4. C011 (CSP Bypass) - 2 days
   - Completes security batch
5. C003 (Trust Store) - 4 days
   - Enables Level 2 security

### Phase 3 (Months 3-4)

**Batch 3: Schema & Architecture**
6. C005 (Schema Mismatch) - 4 days
   - Aligns system vocabulary
7. C007 (Timestamp Checks) - 3 days
   - Security enhancement

### Phase 4 (Months 5+)

**Batch 4: Optimization**
8. C008 (Delegation Contract) - 5 days
   - Enables new use cases
9. C014 (Race Conditions) - 4 days
   - Reliability improvement
10. C002 (Atomic Write) - 4 days
    - Already in progress

---

## Resource Allocation Model

### Available Resources
- **4 lanes × 1 person each** = 4 person-days/day capacity
- **Phase 1 ongoing** = 2 person-days/day used
- **Available for Phase 2** = 2 person-days/day

### 45-Day Phase 2 Budget
- **Total available:** 90 person-days (45 days × 2)
- **Phase 2 plan:** 18.5 person-days
- **Buffer:** 71.5 person-days (79%)

**Resource allocation is NOT a constraint!**

---

## Risk-Adjusted Priorities

| ID | Priority | Risk | Adjusted | Rationale |
|-----|----------|------|----------|----------|
| C001 | 27.0 | High | 21.6 | Security risk if failed |
| C006 | 24.5 | Low | 24.5 | Low implementation risk |
| C004 | 21.3 | High | 17.0 | Security risk |
| C003 | 16.0 | Medium | 12.8 | Complexity risk |
| C011 | 12.5 | Medium | 10.0 | Moderate risk |
| C002 | 16.2 | Low | 16.2 | Already in progress |
| C005 | 12.3 | Low | 12.3 | Straightforward |
| C007 | 16.3 | Low | 16.3 | Simple addition |

### Risk-Adjusted Sequencing

1. **C006** - High ROI, low risk → Do first
2. **C002** - Already started → Complete
3. **C001** - High priority, high risk → Do early with careful testing
4. **C007** - Simple, low risk → Quick win
5. **C004, C011** - Security pair → Do together
6. **C005** - Depends on 3 → Do after
7. **C003** - Complex → Allow more time
8. **Lower priorities** → Phase 3+

---

## Decision Recommendations

### For Governance Review

**RECOMMEND: Approve Phase 2 with Batch 1 sequencing**

**Rationale:**
- ✅ All top 6 constraints have positive ROI
- ✅ Total effort (18.5 days) << available capacity (90 days)
- ✅ Low risk implementation path
- ✅ Clear dependencies respected
- ✅ Fast wins (C006, C007) build momentum

**Expected Outcomes:**
- 6 high-impact constraints resolved
- Security posture significantly improved
- Foundation for Phase 3 optimization
- ROI >300% over 6 months

### Go/No-Go Criteria

**Go:**
- ✅ All 6 Batch 1 constraints approved
- ✅ Resource allocation confirmed (2 person-days/day)
- ✅ Timeline approved (45 days)

**No-Go:**
- ❌ Batch 1 constraints reduced
- ❌ Timeline compressed >20%
- ❌ Resources reduced >50%

---

## Monitoring and Adjustment

### Metrics

| Metric | Target | Current |
|--------|--------|---------|
| Constraints resolved | 6 | 0 |
| ROI realized | >300% | TBD |
| Timeline adherence | >90% | N/A |
| Zero regressions | 100% | N/A |

### Review Cadence

- **Weekly:** Progress vs. plan
- **Bi-weekly:** ROI recalculation
- **Monthly:** Priority reassessment

**Adjustment triggers:**
- ROI <200% → Re-prioritize
- Timeline slip >20% → Re-sequence
- New constraints discovered → Evaluate insertion

---

## Tool Support

### Available Tools

1. **Excel ROI Calculator** (`priority-matrix/roi-calculator.xlsx`)
   - Drag-and-drop reprioritization
   - Automatic ROI recalculation
   - What-if scenario modeling

2. **Dependency Visualizer** (`priority-matrix/dependency-graph.mmd`)
   - Mermaid diagram of constraints
   - Identifies sequencing constraints

3. **Decision Log** (`priority-matrix/decision-log.md`)
   - Tracks all prioritization decisions
   - Rationale and trade-offs
   - Can be audited

### Automation Opportunities

- [ ] Auto-recalculate priorities when I or E changes
- [ ] Alert when dependencies create conflicts
- [ ] Predict timeline based on velocity
- [ ] Generate stakeholder reports

---

## Change Control

### Process

1. **Request submitted** → Workstream 2 lead
2. **Impact analysis** → Recalculate priority
3. **Governance review** → Approve/reject change
4. **Communication** → All stakeholders
5. **Implementation** → Update all artifacts

### Change Types

| Type | Examples | Approval |
|------|----------|----------|
| **Priority change** | I or E adjustment | Workstream 2 |
| **New constraint** | Additional item | Governance |
| **Dependency change** | New blocker identified | Technical Lead |
| **Timeline change** | Due date shift | Governance |

---

## Document History

| Version | Date | Author | Changes |
|---------|------|--------|----------|
| 1.0 | 2026-04-28 | Kernel | Initial creation |
| 1.1 | TBD | TBD | First review updates |
| 1.2 | TBD | TBD | Mid-phase adjustments |

---

## Appendices

### A. Full Constraint Catalog
See: `../constraint-inventory/constraint-catalog.md`

### B. Detailed ROI Calculations
See: `roi-calculator.xlsx`

### C. Dependency Analysis
See: `dependency-graph.mmd`

### D. Decision Log
See: `decision-log.md`

---

*This matrix guides Phase 2 prioritization decisions. Review and update bi-weekly.*  
*Next review: 2026-05-12 (Phase 2 Kickoff)*