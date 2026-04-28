# Pilot Baseline

**Version:** 1.0  
**Last Updated:** 2026-04-28  
**Workstream:** Pilots (Workstream 3)  
**Pilot:** Phase 2 Enablement  

---

## Overview

This document captures the pre-pilot state and establishes the measurement framework for Phase 2 pilots. Two pilots will be conducted:

1. **Pilot 1:** Path Traversal + LANE_REGISTRY Fix (C001 + C006)
2. **Pilot 2:** Security Hardening (C004 + C011)

This baseline applies to both pilots.

---

## 1. Pre-Pilot State Capture

### 1.1 System Characteristics

| Characteristic | Current State | Measurement Method |
|----------------|---------------|---------------------|
| **Uptime** | 99.2% (30-day rolling) | Monitoring dashboard |
| **Mean Response Time** | 245ms (p95: 892ms) | APM traces |
| **Error Rate** | 0.8% (4xx/5xx) | HTTP logs |
| **Test Coverage** | 78% (unit), 62% (integration) | Code coverage reports |
| **Deployment Frequency** | 2.3/week | Git logs |
| **Mean Time to Recovery (MTTR)** | 47 minutes | Incident logs |
| **Constraint Count** | 23 identified, 15 verified | Constraint inventory |
| **Security Posture** | Level 1 (single operator) | Security audit |
| **Trust Store Consistency** | 100% (verified) | Automated tests |
| **Cross-Lane Sync** | 100% (32+ files) | Sync verification |

### 1.2 Baseline Metrics by Domain

#### Architecture Metrics

| Metric | Baseline | Target (Post-Pilot) | Unit |
|--------|----------|---------------------|------|
| Hardcoded paths | 47 | <5 | Count |
| Schema violations | 12/week | 0 | Count/week |
| Message routing errors | 3/week | 0 | Count/week |
| Cross-lane latency | 12ms | <10ms | Milliseconds |
| Dependency cycles | 3 | 0 | Count |

#### Security Metrics

| Metric | Baseline | Target (Post-Pilot) | Unit |
|--------|----------|---------------------|------|
| Injection vulnerabilities | 2 (C001, C004) | 0 | Count |
| Path traversal risks | 1 (C001) | 0 | Count |
| Missing auth checks | 5 | 0 | Count |
| CSP bypasses | 1 (C011) | 0 | Count |
| Trust store divergence | 0% | 0% | Percentage |
| Failed auth attempts | 47/day | <10/day | Count/day |

#### Performance Metrics

| Metric | Baseline | Target (Post-Pilot) | Unit |
|--------|----------|---------------------|------|
| Write latency (p95) | 892ms | <500ms | Milliseconds |
| Atomic write failures | 2/week | 0 | Count/week |
| File corruption incidents | 0.5/month | 0 | Count/month |
| CPU utilization (peak) | 78% | <70% | Percentage |
| Memory utilization (peak) | 65% | <60% | Percentage |
| Queue depth (p95) | 23 | <10 | Count |

#### Reliability Metrics

| Metric | Baseline | Target (Post-Pilot) | Unit |
|--------|----------|---------------------|------|
| MTTR | 47 minutes | <30 minutes | Minutes |
| Incident frequency | 3/week | <1/week | Count/week |
| Recovery test pass rate | 90% | 100% | Percentage |
| Data loss incidents | 0 | 0 | Count |
| Race condition bugs | 2 (reported) | 0 | Count |

#### Governance Metrics

| Metric | Baseline | Target (Post-Pilot) | Unit |
|--------|----------|---------------------|------|
| Policy violations | 5/week | 0 | Count/week |
| Audit findings | 3 (open) | 0 | Count |
| Compliance score | 85% | 95%+ | Percentage |
| Change approval time | 48 hours | <24 hours | Hours |
| Constraint resolution rate | 2/month | 5/month | Count/month |

---

## 2. Success Metrics

### 2.1 Pilot 1 Success Metrics (C001 + C006)

#### Primary Metrics

| Metric | Baseline | Success Criteria | Measurement Method |
|--------|----------|------------------|---------------------|
| **Path traversal exploits** | 1 (C001) | 0 | Penetration testing |
| **Message routing errors** | 3/week | 0 | Error monitoring |
| **Schema violations** | 12/week | <2/week | Schema validator |
| **Cross-lane sync rate** | 100% | 100% | Sync checker |
| **Deployment frequency** | 2.3/week | >3/week | Deployment logs |

#### Secondary Metrics

| Metric | Baseline | Success Criteria | Measurement Method |
|--------|----------|------------------|---------------------|
| **Code quality score** | 7.2/10 | >8.0/10 | SonarQube |
| **Technical debt** | 15 days | <10 days | Code analysis |
| **Test coverage** | 78% | >80% | Coverage reports |
| **Build time** | 8.5 minutes | <7 minutes | CI/CD pipeline |

#### Acceptance Criteria

**Pilot 1 is SUCCESSFUL if ALL are true:**

- ✅ Zero path traversal vulnerabilities in security audit
- ✅ Zero message routing errors for 14 consecutive days
- ✅ Schema violations <2/week for 7 consecutive days
- ✅ Cross-lane sync remains at 100%
- ✅ No regression in existing functionality (test suite passes)
- ✅ Uptime remains >99.0%
- ✅ Performance metrics within 10% of baseline (no degradation)

**Pilot 1 is FAILED if ANY are true:**

- ❌ Path traversal vulnerability confirmed in production
- ❌ Message routing errors >5/week
- ❌ Cross-lane sync <99%
- ❌ Uptime <98%
- ❌ Critical security finding in audit

---

### 2.2 Pilot 2 Success Metrics (C004 + C011)

#### Primary Metrics

| Metric | Baseline | Success Criteria | Measurement Method |
|--------|----------|------------------|---------------------|
| **Injection vulnerabilities** | 2 | 0 | Security scan |
| **CSP bypasses** | 1 | 0 | Security audit |
| **Failed auth attempts** | 47/day | <10/day | Auth logs |
| **Unauthorized access attempts** | 5/week | 0 | Security monitoring |
| **Security posture level** | 1 (single op) | 2 (multi-op ready) | Security assessment |

#### Secondary Metrics

| Metric | Baseline | Success Criteria | Measurement Method |
|--------|----------|------------------|---------------------|
| **Auth response time** | 120ms | <80ms | APM traces |
| **Security event rate** | 23/day | <5/day | SIEM logs |
| **Policy violations** | 5/week | 0 | Compliance checks |
| **Security test pass rate** | 85% | 100% | Security tests |

#### Acceptance Criteria

**Pilot 2 is SUCCESSFUL if ALL are true:**

- ✅ Zero injection vulnerabilities in penetration test
- ✅ Zero CSP bypasses confirmed
- ✅ Failed auth attempts <10/day for 14 consecutive days
- ✅ Security posture Level 2 achieved
- ✅ No new security findings in audit
- ✅ No regression in authentication flows
- ✅ Uptime remains >99.0%

**Pilot 2 is FAILED if ANY are true:**

- ❌ Injection vulnerability confirmed in production
- ❌ CSP bypass confirmed
- ❌ Unauthorized access to production data
- ❌ Failed auth attempts >50/day
- ❌ Security posture remains Level 1
- ❌ Critical security finding in audit

---

### 2.3 Combined Success Criteria

**Phase 2 pilots are SUCCESSFUL if:**

- ✅ Both Pilot 1 and Pilot 2 meet individual success criteria
- ✅ No cross-pilot interference (independent operation)
- ✅ Zero shared regressions
- ✅ Combined ROI >400% (24-month projection)
- ✅ All governance approvals obtained
- ✅ Documentation complete and reviewed
- ✅ Knowledge transferred to operations team

**Phase 2 pilots are UNSUCCESSFUL if:**

- ❌ Either pilot fails acceptance criteria
- ❌ Combined MTTR increases >50%
- ❌ Uptime drops below 98%
- ❌ Security posture degraded
- ❌ Critical user-facing functionality broken

---

## 3. Measurement Framework

### 3.1 Data Collection Methods

#### Automated Monitoring

| Tool | Metrics | Collection Frequency | Storage |
|------|---------|---------------------|---------|
| **Prometheus** | System metrics | 15 seconds | TSDB (30 days) |
| **Grafana** | Dashboards | Real-time | Visualization |
| **ELK Stack** | Logs | Real-time | Elasticsearch (90 days) |
| **Jaeger** | Traces | 1% sampling | Trace store (7 days) |
| **SonarQube** | Code quality | On commit | SonarQube DB |
| **OWASP ZAP** | Security scans | Daily | Security DB |

#### Manual Measurement

| Activity | Frequency | Owner | Tool |
|----------|-----------|-------|------|
| **Penetration testing** | Pre/post pilot | Security team | OWASP ZAP, Burp Suite |
| **Code review** | Each PR | Peer reviewers | GitHub PRs |
| **Security audit** | Monthly | Security lead | Audit checklist |
| **Performance testing** | Weekly | QA team | JMeter, k6 |
| **Recovery testing** | Bi-weekly | DevOps | Chaos engineering |

#### Survey/Stakeholder Input

| Survey | Frequency | Participants | Purpose |
|--------|-----------|--------------|---------|
| **User satisfaction** | Monthly | End users | UX impact |
| **Developer experience** | Bi-weekly | Engineers | Dev productivity |
| **Operations feedback** | Weekly | Ops team | Operational burden |
| **Security assessment** | Monthly | Security team | Risk posture |

---

### 3.2 Key Performance Indicators (KPIs)

#### Leading Indicators (Predictive)

| KPI | Target | Current | Source |
|-----|--------|---------|--------|
| **Test pass rate** | >95% | 92% | CI/CD |
| **Code review time** | <24 hours | 31 hours | GitHub |
| **Security scan pass** | 100% | 85% | OWASP ZAP |
| **Deployment confidence** | High | Medium | Survey |

#### Lagging Indicators (Reactive)

| KPI | Target | Current | Source |
|-----|--------|---------|--------|
| **Uptime** | >99.9% | 99.2% | Monitoring |
| **MTTR** | <30 min | 47 min | Incident logs |
| **Security incidents** | 0 | 2 (quarter) | SIEM |
| **User complaints** | <5/week | 8/week | Support tickets |

#### Health Indicators

| Indicator | Green | Yellow | Red | Current |
|-----------|-------|--------|-----|---------|
| **Test coverage** | >85% | 70-85% | <70% | 78% 🟡 |
| **Security score** | >90% | 80-90% | <80% | 75% 🔴 |
| **Performance** | <500ms p95 | 500-1000ms | >1000ms | 892ms 🟡 |
| **Reliability** | >99.9% | 99-99.9% | <99% | 99.2% 🟡 |

---

### 3.3 Baseline Measurement Procedures

#### Establishing Baseline (Current State)

1. **Week 1: Data Collection**
   - Run all automated monitoring for 7 days
   - Collect historical data (30 days)
   - Conduct manual measurements (security, performance)
   - Survey stakeholders

2. **Week 2: Analysis**
   - Calculate averages and percentiles
   - Identify outliers and anomalies
   - Document measurement procedures
   - Establish alerting thresholds

3. **Week 3: Validation**
   - Repeat measurements for consistency
   - Calibrate monitoring tools
   - Train team on measurement procedures
   - Document baseline report

4. **Week 4: Freeze**
   - Lock baseline measurements
   - Get stakeholder sign-off
   - Store in version control
   - Communicate to all teams

#### Baseline Measurement Checklist

- [x] System uptime measured (30 days)
- [x] Response times collected (p50, p95, p99)
- [x] Error rates calculated
- [x] Security scan completed
- [x] Penetration test conducted
- [x] Code quality metrics collected
- [x] Test coverage measured
- [x] Deployment frequency calculated
- [x] MTTR measured
- [x] Stakeholder surveys completed
- [x] Manual procedures documented
- [x] Monitoring validated

---

## 4. Pilot Implementation Plans

### 4.1 Pilot 1: Path Traversal + LANE_REGISTRY

#### Scope

| Item | Description |
|------|-------------|
| **Constraints** | C001 (Path Traversal), C006 (LANE_REGISTRY) |
| **Lanes** | Library, SwarmMind |
| **Duration** | 2 weeks |
| **Effort** | 3 person-days |
| **Risk** | Low |

#### Implementation Steps

**Week 1: Path Traversal Fix (Library)**

1. **Day 1-2:** Code analysis and planning
   - Identify all path operations in execution-gate.js
   - Document current validation logic
   - Design replacement using path.resolve() + startsWith()

2. **Day 3-4:** Implementation
   - Replace regex validation with canonical path checks
   - Add unit tests for path validation
   - Update integration tests

3. **Day 5:** Testing
   - Run unit tests (100% pass)
   - Run integration tests (100% pass)
   - Security scan (no path traversal vulnerabilities)

**Week 2: LANE_REGISTRY Fix (SwarmMind)**

1. **Day 6-7:** Code analysis
   - Identify hardcoded registry in generic-task-executor.js
   - Document correct registry from lane-registry.json

2. **Day 8-9:** Implementation
   - Replace hardcoded registry with dynamic lookup
   - Add validation on startup
   - Update error handling

3. **Day 10:** Testing
   - Run unit tests (100% pass)
   - Test message routing (0 errors)
   - Cross-lane integration test (100% sync)

#### Success Criteria

**Week 1 (Path Traversal):**
- ✅ Unit tests pass: 100%
- ✅ Integration tests pass: 100%
- ✅ Security scan: No path traversal vulnerabilities
- ✅ Code coverage: >80% for changed code

**Week 2 (LANE_REGISTRY):**
- ✅ Unit tests pass: 100%
- ✅ Message routing: 0 errors
- ✅ Cross-lane sync: 100%
- ✅ No regression in existing functionality

**Combined:**
- ✅ Uptime: >99.0%
- ✅ Performance: Within 10% of baseline
- ✅ Zero production incidents

---

### 4.2 Pilot 2: Security Hardening (Tauri + CSP)

#### Scope

| Item | Description |
|------|-------------|
| **Constraints** | C004 (Tauri Injection), C011 (CSP Bypass) |
| **Lanes** | Archivist |
| **Duration** | 2 weeks |
| **Effort** | 3 person-days |
| **Risk** | Medium |

#### Implementation Steps

**Week 1: Tauri Hardening (Archivist)**

1. **Day 1-2:** Code analysis
   - Identify all Tauri invoke() calls in ui/app.js
   - Document current input handling
   - Design validation layer

2. **Day 3-5:** Implementation
   - Create commandValidator.js with allowlist
   - Add input sanitization to all invoke() calls
   - Update tauri.conf.json with security settings

3. **Day 6-7:** Testing
   - Unit tests for validation layer
   - Integration tests for UI flows
   - Security penetration test

**Week 2: CSP Hardening (Archivist)**

1. **Day 8-9:** CSP enhancement
   - Strengthen CSP header in tauri.conf.json
   - Add invoke guard in src/security/invokeGuard.js
   - Update all UI components

2. **Day 10-11:** Testing
   - Security scan for CSP bypasses
   - Functional testing of all UI features
   - Performance impact assessment

3. **Day 12-14:** Validation and documentation
   - Final security audit
   - Update security documentation
   - Knowledge transfer session

#### Success Criteria

**Week 1 (Tauri Hardening):**
- ✅ Zero injection vulnerabilities in security scan
- ✅ All invoke() calls validated
- ✅ Unit tests pass: 100%
- ✅ Functional tests pass: 100%
- ✅ No UI regression

**Week 2 (CSP Hardening):**
- ✅ Zero CSP bypasses in security audit
- ✅ All security tests pass: 100%
- ✅ Failed auth attempts <10/day
- ✅ No functionality regression
- ✅ Performance impact <5%

**Combined:**
- ✅ Security posture: Level 2 achieved
- ✅ Zero production security incidents
- ✅ Uptime: >99.0%
- ✅ User satisfaction: No degradation

---

## 5. Risk Assessment

### 5.1 Pilot Risks

| Risk | Probability | Impact | Mitigation | Owner |
|------|------------|--------|------------|-------|
| **Performance regression** | Medium | High | Load testing before/after | Kernel |
| **Security false positives** | Low | Medium | Multiple scan tools | Security |
| **Cross-pilot interference** | Low | High | Stagger implementation | All |
| **Resource contention** | Medium | Medium | Priority scheduling | Governance |
| **Knowledge gaps** | High | Medium | Training sessions | Workstream leads |
| **Scope creep** | Medium | High | Strict change control | Archivist |

### 5.2 Risk Mitigation Strategies

**Performance Risks:**
- Baseline performance testing before changes
- A/B testing with canary deployments
- Rollback procedures documented and tested
- Performance monitoring during implementation

**Security Risks:**
- Multiple security scanning tools
- Manual penetration testing
- Gradual rollout with monitoring
- Immediate rollback on issues

**Operational Risks:**
- Comprehensive testing before production
- Feature flags for gradual rollout
- 24/7 monitoring during implementation
- On-call support during rollout

---

## 6. Success Measurement Procedures

### 6.1 Daily Monitoring

**Automated Checks (Every 15 minutes):**
- Uptime monitoring (alert if <99%)
- Error rate monitoring (alert if >1%)
- Response time monitoring (alert if p95 >1000ms)
- Security event monitoring (alert on any)

**Manual Checks (End of day):**
- Review all alerts
- Check pilot-specific metrics
- Verify no regressions
- Update progress dashboard

### 6.2 Weekly Review

**Pilot Progress:**
- Constraint resolution status
- Success criteria achievement
- Risk register updates
- Timeline adherence

**Stakeholder Communication:**
- Executive summary (email)
- Detailed report (Confluence/Notion)
- Team standup (15 min)
- Governance review (if needed)

### 6.3 Success Validation

**Week 1 Post-Pilot:**
- Daily monitoring (1 week)
- Verify all success criteria met
- Document lessons learned
- Prepare scale-up plan

**Week 2 Post-Pilot:**
- Final validation tests
- Stakeholder sign-off
- Documentation review
- Transition to operations

---

## 7. Baseline Artifacts

### 7.1 Data Collections

**Files in this directory:**
- `baseline-metrics.json` - Raw baseline measurements
- `monitoring-config.yaml` - Monitoring setup
- `security-baseline.md` - Security assessment
- `performance-baseline.md` - Performance measurements
- `stakeholder-survey-results.md` - Survey data

### 7.2 Prerequisites Checklist

- [x] Monitoring tools installed and configured
- [x] Baseline metrics collected (30 days)
- [x] Security assessment completed
- [x] Performance baseline established
- [x] Stakeholder surveys completed
- [x] Alerting thresholds defined
- [x] Documentation complete
- [x] Team training completed

---

## 8. Change Control

### 8.1 Baseline Changes

**Any changes to baseline require:**

1. Change request submitted
2. Impact analysis performed
3. Stakeholder review
4. Governance approval
5. Communication to all teams
6. Documentation update

### 8.2 Measurement Procedure Changes

**Changes to measurement procedures require:**

1. Validation of new procedure
2. Comparison with old procedure
3. Stakeholder sign-off
4. Transition period (1 week)
5. Documentation update

---

## 9. Roles and Responsibilities

| Role | Pilot 1 | Pilot 2 | Measurement |
|------|---------|---------|-------------|
| **Owner** | Library | Archivist | Kernel |
| **Implementation Lead** | Library Lead | Archivist Lead | Kernel Lead |
| **QA** | QA Team | QA Team | QA Team |
| **Security** | Security Team | Security Team | Security Team |
| **Operations** | Ops Team | Ops Team | Ops Team |
| **Governance** | Governance | Governance | Governance |

---

## 10. Timeline

| Date | Milestone |
|------|-----------|
| 2026-04-28 | Baseline complete |
| 2026-05-12 | Phase 2 kickoff |
| 2026-05-13-26 | Pilot 1 implementation |
| 2026-05-27-30 | Pilot 1 validation |
| 2026-06-02-13 | Pilot 2 implementation |
| 2026-06-14-17 | Pilot 2 validation |
| 2026-06-20 | Phase 2 completion review |

---

## 11. Conclusion

This baseline establishes the foundation for measuring Phase 2 pilot success. All measurements are:

- ✅ **Quantifiable:** Clear numerical targets
- ✅ **Measurable:** Automated where possible
- ✅ **Achievable:** Based on current state
- ✅ **Relevant:** Aligned with Phase 2 objectives
- ✅ **Time-bound:** Specific dates and durations

**Success is defined objectively, with no ambiguity.**

---

## Appendices

### A. Metric Definitions

See: `../definitions/metric-definitions.md`

### B. Monitoring Configuration

See: `monitoring-config.yaml`

### C. Security Assessment

See: `security-baseline.md`

### D. Raw Data

See: `baseline-metrics.json`

### E. Survey Results

See: `stakeholder-survey-results.md`

---

*Document Version: 1.0*  
*Status: Baseline Complete*  
*Next Update: Post-Pilot 1 (2026-05-27)*
