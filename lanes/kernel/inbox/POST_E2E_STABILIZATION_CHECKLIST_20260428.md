# Post-E2E Stabilization Checklist (2026-04-28)

Status baseline:
- 4/4 lanes pass lane-worker and executor suites
- 8/8 cross-lane delivery pass
- schema and completion-proof files aligned across lanes
- residual failures are legacy or operational hygiene

## Goal
Close residual operational debt after E2E green without changing validated core behavior.

## Priority 1 (Immediate)

### 1) Library lane-worker restart
- Start/verify Library lane worker and heartbeat loop.
- Success criteria:
  - fresh `heartbeat-library.json` timestamp
  - no growth in `quarantine/` from schema-valid messages

### 2) Preserve green baseline
- Do not modify cross-lane message semantics.
- Do not alter `NON_TERMINAL_TYPE` logic during cleanup.

## Priority 2 (One-time cleanup)

### 3) Archive legacy pre-v1.3 artifacts
- Move known non-fixable legacy messages to archival folder (`quarantine/resolved-*` or equivalent).
- Include:
  - pre-schema files missing `schema_version/task_id/...`
  - malformed JSON files with invalid control characters
  - legacy `heartbeat.status=active` raw envelopes that were never normalized
- Success criteria:
  - lane readiness checks ignore archived directories
  - active quarantine contains only current actionable items or fresh schema rejects

### 4) Resolve schema-invalid relay loop responses
- For residual relay-response schema gaps (missing `execution/lease/retry`), either:
  - regenerate as valid v1.3 envelopes and re-ingest, or
  - archive as historical invalids with reason metadata.

## Priority 3 (Low severity)

### 5) `needs-review/` directory
- No action required unless collisions are present.
- Directory is allowed to be on-demand.

### 6) Cosmetic malformed NACK
- Optional cleanup only; no pipeline impact.

## Verification Gate (must pass)

Run after cleanup:
- Lane worker tests: pass
- Executor tests: pass
- Cross-lane delivery matrix: pass
- Readiness sweep: zero actionable root-P0 for active lanes
- Heartbeats fresh for active lanes

## Reporting Format (copy/paste)

```text
POST_E2E_STABILIZATION_REPORT:
- lane: <lane>
- library_worker_status: <running|not_running>
- archived_legacy_count: <n>
- remaining_quarantine_count: <n>
- readiness_status: <green|blocked>
- notes: <short notes>
```

## Artifact paths
- This checklist (source): `S:/Archivist-Agent/docs/ops/POST_E2E_STABILIZATION_CHECKLIST_20260428.md`
- Delivered copies:
  - `S:/Archivist-Agent/lanes/library/inbox/POST_E2E_STABILIZATION_CHECKLIST_20260428.md`
  - `S:/kernel-lane/lanes/kernel/inbox/POST_E2E_STABILIZATION_CHECKLIST_20260428.md`
