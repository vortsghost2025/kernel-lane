# Four-Lane Ops Runbook

Purpose: keep Archivist, Library, SwarmMind, and Kernel stable during day-to-day operations.

## Operating Mode

- Stability-first: no major architecture changes during active incident response.
- One blocker at a time: use `lanes/broadcast/active-blocker.json`.
- Evidence before claims: every fix and closure points to a concrete path.

## Health Checks (Quick Pass)

Run these in each lane repo:

- Verify heartbeat file exists in lane inbox root:
  - `lanes/<lane>/inbox/heartbeat-<lane>.json`
- Verify no actionable message backlog:
  - `lanes/<lane>/inbox/action-required/`
- Verify quarantine is not growing unexpectedly:
  - `lanes/<lane>/inbox/quarantine/`
- Verify system state:
  - `lanes/broadcast/system_state.json`

## Incident Playbooks

### Recovering stale heartbeat

Symptoms:
- Heartbeat age exceeds timeout, or lane marked stale/dead.

Actions:
1. Confirm lane worker and heartbeat script are running.
2. Write a fresh heartbeat once.
3. Re-check lane staleness after one interval.
4. If still stale, create/update blocker and route to owner lane.

Evidence:
- Updated heartbeat file path
- Worker/runtime logs

### Resolving quarantine spikes

Symptoms:
- Sudden increase in `inbox/quarantine` message count.

Actions:
1. Sample latest quarantined messages and classify failure reason:
   - schema invalid
   - signature invalid
   - format/ASCII policy
   - evidence gate failure
2. Fix producer contract first (do not hand-edit messages unless emergency).
3. Re-run message through normal path once producer is fixed.
4. Track count trend until stable.

Evidence:
- Quarantine samples
- Producer fix commit or script change
- Post-fix message admission proof

### Resolving trust-store mismatch

Symptoms:
- Signature verification failures across otherwise valid messages.

Actions:
1. Compare trust store hashes across all lanes.
2. Confirm expected key IDs and algorithms for each lane.
3. Restore canonical trust store (do not partially merge unknown keys).
4. Re-validate one signed message end-to-end.

Evidence:
- Trust store snapshots/hashes
- Successful signature validation log or message path

## SLO Targets

- Quarantine unresolved > 30 minutes: **0**
- Action-required backlog older than 30 minutes: **0**
- Heartbeat stale lanes: **0**
- Active blocker older than 2 hours without update: **0**

## Escalation Rules

- P0: signature/trust-store failure, multi-lane ingestion failure.
- P1: sustained quarantine spike, stale lane worker, repeated schema failures.
- P2: documentation drift, non-blocking cleanup, policy alignment.

## Closure Checklist

Before marking incident complete:

1. Root cause documented.
2. Fix merged and pushed.
3. Evidence paths recorded.
4. Cross-lane status reflected in `system_state.json`.
5. If blocker was set, `active-blocker.json` returned to inactive.

## Convergence Gate

```json
{
  "claim": "Four-lane operations runbook defines concrete incident procedures, SLO targets, escalation policy, and closure gates for stable multi-lane execution.",
  "evidence": "docs/FOUR_LANE_OPS_RUNBOOK.md",
  "verified_by": "kernel",
  "contradictions": [],
  "status": "proven"
}
```
