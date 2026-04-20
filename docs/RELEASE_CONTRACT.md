# Release Contract

A release is valid only if `releases/<version>/manifest.json` exists and references:
- `artifact`
- `benchmark_report`
- `nsys_report`
- `ncu_report`
- `metrics`
- `created_at_utc`

Consumers in other lanes must only use artifacts listed in `releases/index.json`.
No direct use of `build/` outputs is allowed.
