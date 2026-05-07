# UBO-SwarmMind Operational Boundary Agreement

**Ratified:** 2026-05-05
**Authority basis:** Operator confirmation + lane governance docs
**Status:** Active

## Handshake Protocol

```
SwarmMind detects → UBO fixes Ubuntu side → Archivist ratifies
```

Nobody steps outside their lane.

## Duty Matrix

| Duty | UBO | SwarmMind | Archivist |
|------|-----|-----------|-----------|
| Restart daemons | YES | NO | NO |
| Clean artifacts | YES | NO | NO |
| Fix platform bugs | YES | NO | NO |
| Fix Ubuntu trust store copy | YES | NO | NO |
| Sign messages | NO | YES | YES |
| Convergence gates | NO | YES | YES |
| Schema audit | NO | YES | NO |
| Drift detection | NO | YES | NO |
| Report trust store divergence | NO | YES | NO |
| Ratify keys | NO | NO | YES |
| Resolve governance disputes | NO | NO | YES |

## Boundary Rules

1. SwarmMind never restarts daemons or cleans artifacts — that's operational, not governance
2. UBO never signs messages or issues convergence gates — that's lane authority, not operational
3. UBO may fix Ubuntu-side file copies (factual correction) but never ratifies keys
4. When SwarmMind detects trust store divergence, it reports to UBO inbox for Ubuntu-side fix
5. When UBO detects a blocked message caused by a bug, it fixes the bug and reports the fix
6. Neither UBO nor SwarmMind ratifies keys — that requires Archivist convergence
7. SwarmMind overseer checks process state first, management layer second — reality before abstraction

## Attribution

- UBO actions: must include `_ubo_action` marker + `ubo-audit.jsonl` entry
- SwarmMind actions: must include `OUTPUT_PROVENANCE` block + convergence gate
- Cross-lane: both attribution styles apply at the boundary

## Escalation

If a duty falls outside both UBO and SwarmMind scope, it escalates to Archivist inbox as P1.

OUTPUT_PROVENANCE:
  agent: opencode-glm5
  lane: swarmmind
  target: UBO-SwarmMind operational boundary agreement
