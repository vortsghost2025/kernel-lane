# Release Contract

A release is valid only if `releases/<version>/manifest.json` exists and references:
- `artifact`
- `benchmark_report`
- `nsys_report` — **required where available, optional on Windows headless**
- `ncu_report`
- `metrics`
- `created_at_utc`

Consumers in other lanes must only use artifacts listed in `releases/index.json`.
No direct use of `build/` outputs is allowed.

## Nsight Systems (nsys) Platform Policy

**On Linux:** `nsys_report` is **required** for promotion. The Nsight Systems daemon operates correctly in headless environments on Linux.

**On Windows headless sessions:** `nsys_report` is **optional** and convergence status reflects this as a known gap rather than a pipeline defect. The Nsight Systems daemon on Windows requires interactive desktop access to accept the agent dialog via named-pipe RPC. This is a Windows session isolation limitation (affects both nsys v2025.6.3 and v2026.2.1), not a tool configuration issue.

When `nsys_report` is `null` in the manifest due to this OS limitation, `convergence.json` status is set to `"partial"` instead of `"proven"`. This is the honest state — the contract does not inflate convergence status.

To collect nsys on Windows, an interactive desktop session is required. Helper scripts exist (`collect-nsys.ps1`, `fix-nsys-daemon.bat`) for this purpose.

## Convergence Status

| Status | Meaning |
|--------|---------|
| `proven` | All 5 evidence types present (artifact, benchmark, ncu, nsys, release manifest) |
| `partial` | 4 of 5 evidence types present; nsys blocked by OS limitation |
| `rejected` | Release rejected via `rejection.json`; negative knowledge preserved |

## Regression Enforcement

`config/targets.json` declares `regression_threshold_pct` (default: 2.0%). `run-benchmarks.ps1` reads this threshold and compares new benchmark results against the previous report. A regression beyond the threshold causes a non-zero exit and blocks promotion.

## Promotion Gates

1. Built artifact exists in `releases/<version>/`
2. Benchmark report with latency and throughput metrics
3. NCU profiling report (Nsight Compute)
4. NSYS profiling report (Nsight Systems) — or documented OS limitation
5. `manifest.json` references all present artifacts
6. `convergence.json` records claim/evidence/status
7. Regression check passes (no threshold violation vs. baseline)
8. Release broadcast sent to `lanes/kernel/outbox/`

## Rejection Path

Failed optimizations must produce `rejection.json` so negative knowledge is preserved. Failures cannot silently disappear. See `reject-release.ps1`.
