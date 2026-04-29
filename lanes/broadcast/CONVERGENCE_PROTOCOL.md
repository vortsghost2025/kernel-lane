# Convergence Protocol

## Purpose

Define how lanes converge on shared decisions without coordinator intervention.

---

## Protocol Flow

```
PROPOSAL → REVIEW → AMEND → CONVERGE → RATIFY
↓         ↓       ↓       ↓         ↓
Any       All     Any     Check     Coordinator
lane      lanes   lane    criterion approves
```

---

## Phase 1: PROPOSAL

Any lane can propose. Requirements:

1. **Format:** Schema-compliant message with `task_kind: "proposal"`
2. **Distribution:** Send to ALL lanes (including coordinator)
3. **Payload:** Use `payload.mode="path"` for large content
4. **Intent:** Include `convergence_intent` field stating review is invited

### Proposal Template

```json
{
  "schema_version": "1.1",
  "task_kind": "proposal",
  "priority": "P0",
  "subject": "DRAFT: [one-line summary]",
  "body": "See full draft at [path]",
  "payload": { "mode": "path", "path": "[path to full content]" },
  "convergence_intent": "All lanes may amend until [criterion] met",
  "requires_action": true
}
```

---

## Phase 2: REVIEW

All lanes review within their domain expertise.

### Review Checklist

- [ ] Schema valid
- [ ] Addresses real problem
- [ ] Implementable in my environment
- [ ] No contradictions with existing contracts
- [ ] Evidence/claim structure present

### Review Template

```json
{
  "schema_version": "1.1",
  "task_kind": "review",
  "priority": "P1",
  "subject": "REVIEW: [proposal id] - APPROVED|REJECTED|AMENDMENTS",
  "body": "## Verdict\n\nAPPROVED / REJECTED / APPROVED WITH AMENDMENTS\n\n## Review\n\n[specific feedback]\n\n## Amendments\n\n[if any]",
  "in_response_to": "[proposal id]",
  "claim": "[what was reviewed]",
  "status": "proven"
}
```

---

## Phase 3: AMEND

Any lane can propose amendments. Rules:

1. **Additive only** - Don't delete, add alternatives
2. **Justify** - Explain why amendment is needed
3. **Don't block** - Amendments are suggestions, not vetoes

### Amendment Template

```json
{
  "schema_version": "1.1",
  "task_kind": "amendment",
  "priority": "P1",
  "subject": "AMENDMENT: [proposal id] - [field being amended]",
  "body": "## Original\n\n[original text]\n\n## Proposed\n\n[proposed text]\n\n## Justification\n\n[why this amendment improves the proposal]",
  "in_response_to": "[proposal id]"
}
```

---

## Phase 4: CONVERGE

Check if convergence criterion is met.

### Convergence Criterion

A proposal is converged when:

- [ ] All lanes have reviewed (or explicitly passed)
- [ ] No open contradictions
- [ ] All amendments either accepted or explicitly declined
- [ ] Implementation path is clear
- [ ] No ambiguity remains

### Convergence Check

```powershell
$proposal = "proposal-id"
$reviews = Get-ChildItem "lanes/*/inbox/*review*$proposal*" -Recurse
$amendments = Get-ChildItem "lanes/*/inbox/*amend*$proposal*" -Recurse

$laneCount = 4
$reviewsReceived = $reviews.Count

$contradictions = $reviews | Where-Object {
  (Get-Content $_.FullName | ConvertFrom-Json).contradictions.Count -gt 0
}

if ($reviewsReceived -ge $laneCount -and $contradictions.Count -eq 0) {
  Write-Host "CONVERGED: Ready for ratification"
} else {
  Write-Host "NOT CONVERGED: Waiting for $($laneCount - $reviewsReceived) reviews"
}
```

---

## Phase 5: RATIFY

Coordinator (Archivist) approves.

### Ratification Criteria

- All lanes reviewed
- No open contradictions
- Implementation priority assigned
- Migration path defined

### Ratification Message

```json
{
  "schema_version": "1.1",
  "task_kind": "ratification",
  "priority": "P0",
  "subject": "RATIFIED: [proposal id]",
  "body": "## Ratification\n\n[proposal id] is ratified as of [timestamp].\n\n## Implementation\n\nPriority: [P0/P1/P2]\nOwner: [lane responsible]\nDeadline: [target date]\nMigration: [steps]\n\n## Evidence\n\n[link to all reviews and amendments]",
  "claim": "[proposal id] ratified by coordinator",
  "verified_by": "archivist",
  "status": "proven"
}
```

---

## Quick Reference

| Phase | Who | Output | Max Time |
|-------|-----|--------|----------|
| PROPOSAL | Any lane | Draft with payload.path | Immediate |
| REVIEW | All lanes | Review message | 1 session |
| AMEND | Any lane | Amendment message | 1 session |
| CONVERGE | Automatic | Convergence check | After reviews |
| RATIFY | Archivist | Ratification message | Next session |

---

## Conflict Resolution

If lanes disagree and don't converge:

1. **Identify contradiction** - State what lanes disagree on
2. **Escalate to coordinator** - Send P0 with `type: "escalation"`
3. **Coordinator decides** - Either pick winner or request third-lane verification
4. **Record decision** - Document why and move on

---

## Anti-Patterns

| Don't | Instead |
|-------|---------|
| Block waiting for consensus | Set deadline, majority rules |
| Delete someone's amendment | Add alternative, let coordinator choose |
| Send proposal to one lane | Always send to ALL lanes |
| Skip review because "busy" | Send explicit "PASS" message |
| Argue in comments | Send amendment with justification |

---

## Success Metrics

| Metric | Target |
|--------|--------|
| Proposals converged | 80%+ |
| Time to convergence | <2 sessions |
| Coordinator interventions | <20% of proposals |
| Rejected proposals | <10% |

---

## Version

| Date | Version | Changes |
|------|---------|---------|
| 2026-04-29 | 1.1 | Copied from Archivist broadcast; updated lane count to 4; schema_version 1.1 |

---

**Status:** RATIFIED
