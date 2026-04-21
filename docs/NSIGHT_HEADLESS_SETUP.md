# Nsight Headless Profiling Guide — kernel-lane

## TL;DR

- **ncu** (Nsight Compute): Works headless, always. Use for automated/scheduled profiling.
- **nsys** (Nsight Systems): Requires interactive desktop session. Use manually for system traces.

## The nsys Daemon Problem

`nsys profile` communicates with a daemon via Windows named pipes:
```
\\.\pipe\NVIDIANsightSystems2026.2.1.210-262137639646v0
```

The daemon pipe exists, but the RPC handshake times out (120s) when
called from agent/non-interactive sessions due to Windows session
isolation. Even with the daemon running and pipes visible, `nsys`
from a headless context cannot complete the connection.

This is NOT an EULA issue. It's a Windows session boundary problem.
The daemon was designed for interactive desktop use.

## What Works: ncu Headless Profiling

```powershell
# Quick profile (1 pass, ~1s)
ncu --set quick --export S:\kernel-lane\profiles\ncu\quick-profile S:\kernel-lane\build\Release\matrix_benchmark.exe

# Full profile (42 passes, ~34s on RTX 5060)
ncu --set full --export S:\kernel-lane\profiles\ncu\full-profile S:\kernel-lane\build\Release\matrix_benchmark.exe
```

Verified on this system (RTX 5060, driver 595.97):
- Quick: 391.87ms wall / 0.35 TFlops
- Full: 34309.8ms wall (serialization overhead) / 81MB .ncu-rep

## What Doesn't Work From Agents: nsys

```powershell
# This hangs for 120s then fails with RPC timeout
nsys profile --duration=5 --output test matrix_benchmark.exe
```

Works ONLY from a direct interactive desktop PowerShell/CMD session.
If you need nsys system-level traces, run manually from desktop.

## Kernel-Lane Profiling Strategy

| Context | Tool | Command |
|---------|------|---------|
| Scheduled task | ncu --set quick | Fast, headless, always works |
| Automated CI | ncu --set full | Complete kernel metrics |
| Interactive debugging | nsys profile | System-level traces (manual only) |
| Performance regression | ncu --set quick | Compare against baseline |
