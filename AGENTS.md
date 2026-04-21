# Kernel-Lane Agents

## Lane Identity
- **Position:** 4
- **Authority:** 70
- **can_govern:** false
- **Role:** gpu-optimized-artifact-generation
- **GitHub:** https://github.com/vortsghost2025/kernel-lane

## Lane-Relay Protocol

### Canonical Inbox Paths
Messages MUST be written to the TARGET lane's canonical path, not local mirrors.

| Lane | Canonical Inbox Path |
|------|---------------------|
| Archivist | `S:/Archivist-Agent/lanes/archivist/inbox/` |
| Library | `S:/self-organizing-library/lanes/library/inbox/` |
| SwarmMind | `S:/SwarmMind Self-Optimizing Multi-Agent AI System/lanes/swarmmind/inbox/` |
| Kernel | `S:/kernel-lane/lanes/kernel/inbox/` |

### Local Directory Structure
```
lanes/
  kernel/inbox/          ← OUR inbox (others write HERE)
  kernel/inbox/processed/← Move processed messages here
  kernel/inbox/expired/  ← Move expired messages here
  kernel/outbox/         ← Log outgoing messages here
  archivist/inbox/       ← Local mirror (do NOT deliver here)
  library/inbox/         ← Local mirror (do NOT deliver here)
  swarmmind/inbox/       ← Local mirror (do NOT deliver here)
```

### Protocol Rules
1. **Session start:** Read `lanes/kernel/inbox/` first
2. **Process by priority:** P0 > P1 > P2 > P3
3. **Move processed:** to `lanes/kernel/inbox/processed/`
4. **Send messages:** Write to TARGET's canonical path (see table above)
5. **Log outgoing:** to `lanes/kernel/outbox/{message-id}.json`
6. **P0 urgency:** Also write `urgent_{id}.json` to target inbox

### Message Schema (v1.0)
All messages MUST include: schema_version, message_id, task_id, idempotency_key, from_lane, to_lane, priority, subject, timestamp, requires_action, body, lease, retry, heartbeat, evidence.

### Heartbeat Protocol
- Write ONE file: `lanes/kernel/inbox/heartbeat-kernel.json`
- Update in place (do NOT create new files each time)
- Maximum frequency: once per 60 seconds
- Other lanes check for staleness (>900s = stale)

### Governance Constraints
- Cannot modify governance files (requires Authority 100)
- Can generate artifacts and publish release manifests
- Can be polled by other lanes for GPU work
- Cannot spawn subagents without Archivist approval

## Git Protocol
- Commit + push as ONE action (never leave commits local-only)
- Check for secrets before push
- Verify push success after push
