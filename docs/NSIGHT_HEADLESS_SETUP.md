# Nsight Headless Profiling Guide — kernel-lane

## TL;DR

- **ncu** (Nsight Compute): Works headless, always. Use for automated/scheduled profiling.
- **nsys** (Nsight Systems): Works headless on version **2024.5+** (CLI-only offline mode). Older versions (<2024.5) require an interactive desktop session.

## Nsight Systems Headless (2024.5+)

For recent Nsight Systems installations, full headless operation is supported:

```powershell
nsys profile `
    --output profile_output `
    --trace=cuda,nvtx,osrt `
    --capture-range=cudaLaunchKernel `
    --capture-range-end=cudaDeviceSynchronize `
    --gpu-metrics-device=all `
    --duration 30s `
    build\Release\benchmark.exe
```

The `--capture-range` flags automatically start/stop capture around kernel execution, and `--duration` provides a safety timeout.

## Nsight Compute (Always Headless)

Nvidia Nsight Compute has always supported headless operation:

```powershell
ncu --target-processes all --set full --export metrics.csv --output profile_metrics build\Release\benchmark.exe
```

## Kernel-Lane Headless Script

The repository includes a convenience script that runs both profilers and exports artifacts for CI:

```powershell
.\scripts\run-headless-profiling.ps1 -DurationSec 60
```

This produces:
- `profiles/headless/kernel_profile.nsys-rep` (timeline)
- `profiles/headless/kernel_profile.json` (JSON export)
- `profiles/headless/kernel_metrics.ncu-rep` and `.csv`

The script automatically skips Nsight Systems if the tool is missing or fails, ensuring Nsight Compute always runs.

## Regression Guard

A simple regression check compares current kernel metrics against a baseline:

```powershell
.\scripts\check-profiling-regression.ps1 -BaselineCsv profiles\headless\baseline_metrics.csv -CurrentCsv profiles\headless\kernel_metrics.csv
```

The baseline CSV is committed in the repository.

## Notes for Older Nsight Versions

If you are using Nsight Systems **prior to 2024.5**, the daemon still requires an interactive desktop session and the EULA acceptance dialog. In that scenario:
- Run `scripts\collect-nsys.ps1` manually from an admin PowerShell prompt.
- Or upgrade to a newer Nsight Systems version to enable true headless operation.
