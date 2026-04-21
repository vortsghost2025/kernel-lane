# Kernel Lane Inbox

Incoming requests from other lanes.

## Request Types

Other lanes place JSON files here to request Kernel Lane actions:

- `benchmark_request.json` — request a benchmark run against a specific kernel
- `validation_request.json` — request validation of a kernel optimization claim
- `comparison_request.json` — request comparison of two kernel versions

## Format

```json
{
  "type": "benchmark_request",
  "from_lane": "library",
  "kernel": "inference_kernel",
  "parameters": { "size": 1048576 },
  "created_at_utc": "2026-04-20T21:30:00Z"
}
```

Processed requests are moved to `processed/` with a response attached.
