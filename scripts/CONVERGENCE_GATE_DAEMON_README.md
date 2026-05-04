# Convergence Gate Daemon

## Purpose

The convergence gate daemon enforces message validation across lane outboxes. It acts as a gatekeeper that:

1. **Validates** all outbound messages against the `inbox-message-v1.json` schema
2. **Checks** the `convergence_gate.status` field — only messages with status `proven`, `approved`, `ratified`, or `accepted` are allowed through
3. **Delivers** valid messages to the recipient's canonical inbox
4. **Quarantines** invalid messages and logs rejections to `logs/cps_log.jsonl`

## Usage

```bash
# Dry-run mode (default) - shows what would be delivered/rejected
node convergence-gate-daemon.js

# Run once with JSON output
node convergence-gate-daemon.js --json

# Actually deliver messages (apply changes)
node convergence-gate-daemon.js --apply

# Run as a daemon (polling every 60 seconds)
node convergence-gate-daemon.js --daemon --poll-seconds=60

# Process only kernel lane outbox
node convergence-gate-daemon.js --lane=kernel --apply

# Custom poll interval
node convergence-gate-daemon.js --daemon --poll-seconds=30
```

## Command-Line Options

| Option | Description |
|--------|-------------|
| `--apply` | Actually move files (default: dry-run, only logs) |
| `--daemon` | Run continuously as a daemon with polling |
| `--poll-seconds=N` | Polling interval in seconds (default: 60) |
| `--lane=NAME` | Process only specified lane's outbox (default: all lanes) |
| `--json` | Output results as JSON instead of human-readable logs |

## Output

### Human-Readable (default)
```
[convergence-gate] lane=kernel scanned=5 delivered=3 rejected=2
[convergence-gate] lane=library scanned=1 delivered=1 rejected=0
```

### JSON Mode
```json
{
  "timestamp": "2026-05-04T13:00:00Z",
  "dry_run": false,
  "results": [
    {
      "lane": "kernel",
      "scanned": 5,
      "delivered": 3,
      "rejected": 2,
      "details": [...]
    }
  ]
}
```

## Rejection Logging

All rejected messages are logged to `logs/cps_log.jsonl` with full context:

```json
{
  "timestamp": "2026-05-04T13:00:00Z",
  "event": "MESSAGE_REJECTED",
  "lane": "kernel",
  "file": "summary-12345.json",
  "reasons": ["STATUS_NOT_PROVEN", "CONVERGENCE_GATE_MISSING_CLAIM"],
  "msg_id": "task-12345",
  "from": "library",
  "to": "kernel",
  "convergence_status": "unproven"
}
```

## Integration

### As a Daemon

Run the daemon in the background to continuously monitor and process messages:

```bash
# Linux/macOS
nohup node convergence-gate-daemon.js --daemon --apply > logs/convergence-gate.log 2>&1 &

# Windows (PowerShell)
Start-Process node -ArgumentList "scripts\convergence-gate-daemon.js --daemon --apply" -RedirectStandardOutput "logs\convergence-gate.log" -NoNewWindow
```

### With PM2 (Process Manager)

```bash
pm2 start convergence-gate-daemon.js --name convergence-gate -- --daemon --apply
```

### Cron Job (periodic polling)

```bash
# Run every minute
* * * * * cd /path/to/kernel-lane && node scripts/convergence-gate-daemon.js --apply --json
```

## Gate Logic

Messages must pass all checks:

1. **Schema**: Valid against `schemas/inbox-message-v1.json`
2. **Signature**: Has valid `signature` and `key_id` fields
3. **Convergence Gate**: 
   - `convergence_gate` object exists
   - `status` is in `['proven', 'approved', 'ratified', 'accepted']`
   - `claim`, `evidence`, `verified_by`, and `contradictions` (array) are present

## File Movement

- **Outbox → Inbox**: Valid messages are copied to the recipient's canonical inbox (using lane-discovery paths) and deleted from the outbox
- **Quarantine**: Invalid messages are moved to `<outbox>/../quarantine/` (only when `--apply` is used)
- **Logging**: All rejections are appended to `logs/cps_log.jsonl`

## Schema Reference

The daemon validates against `schemas/inbox-message-v1.json`. This schema defines the structure of cross-lane messages including required fields like `task_id`, `idempotency_key`, `from`, `to`, `type`, `priority`, `payload`, `execution`, `lease`, `retry`, `evidence`, `heartbeat`, `signature`, `key_id`, and crucially `convergence_gate`.

## Exit Codes

- `0` - Success (when run once)
- `1` - Fatal error (schema not found, lane-discovery failure)

In daemon mode, errors are logged but the daemon continues running.

## Architecture

```
Outbox Directories (per lane)
├── archivist/lanes/archivist/outbox/
├── kernel/lanes/kernel/outbox/
├── library/lanes/library/outbox/
└── swarmmind/lanes/swarmmind/outbox/

Convergence Gate Daemon
  ├── Validates schema
  ├── Checks convergence_gate.status
  ├── Verifies signature
  └── Delivers to canonical inbox (or quarantines)

Canonical Inbox Directories (per lane)
├── S:/Archivist-Agent/lanes/archivist/inbox/
├── S:/kernel-lane/lanes/kernel/inbox/
├── S:/self-organizing-library/lanes/library/inbox/
└── S:/SwarmMind/lanes/swarmmind/inbox/
```

## Governance

This daemon enforces the constitutional constraint that cross-lane communication must be **proven** before delivery. It implements the convergence gate protocol described in `docs/ops/CONVERGENCE_GATE_POLICY.md` (or equivalent governance document).
