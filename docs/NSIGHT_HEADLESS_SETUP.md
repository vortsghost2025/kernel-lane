# Nsight Systems Headless Setup Guide

## The Problem

`nsys profile` requires the Nsight Systems daemon to be running.
On first use, the daemon shows an EULA popup that requires interactive
desktop acceptance. Scheduled tasks running as SYSTEM cannot accept
this popup — they timeout at the RPC layer.

## The Fix (One-Time, Interactive)

1. Open a regular PowerShell (not elevated, just normal desktop session)
2. Run:
   ```powershell
   & "C:\Program Files\NVIDIA Corporation\Nsight Systems 2026.2.1\target-windows-x64\nsys.exe" profile --duration=3 "S:\kernel-lane\build\Release\matrix_benchmark.exe"
   ```
3. If the EULA popup appears, click **Accept**
4. The daemon will start and persist for the session

After EULA acceptance, the daemon remains available for subsequent
headless/scheduled runs until reboot.

## Alternative: Use ncu (Works Headless Now)

`ncu` (Nsight Compute) does NOT require a daemon and works headless:

```powershell
ncu --set quick --export S:\kernel-lane\profiles\ncu\profile-name S:\kernel-lane\build\Release\matrix_benchmark.exe
```

Verified working on this system: 4096x4096 matrix multiply profiled
successfully at 391.87ms / 0.35 TFlops on RTX 5060.

## Make nsys Work After Reboot

Add to Windows Startup (runs on login, accepts daemon in desktop session):

```powershell
# Create a startup task that runs as the interactive user
$trigger = New-ScheduledTaskTrigger -AtLogOn -UserId "seand"
$action = New-ScheduledTaskAction -Execute "C:\Program Files\NVIDIA Corporation\Nsight Systems 2026.2.1\target-windows-x64\nsys.exe" -Argument "profile --duration=1 --session-new daemon-warmup S:\kernel-lane\build\Release\matrix_benchmark.exe"
Register-ScheduledTask -TaskName "Nsight-Daemon-Warmup" -Trigger $trigger -Action $action -RunLevel Highest -Description "Starts nsys daemon on login so scheduled tasks can use it"
```

This ensures the daemon is running whenever you're logged in.

## Kernel-Lane Profiling Strategy

For headless/scheduled profiling:
- **ncu**: Always works, use for kernel-level metrics
- **nsys**: Only works after interactive daemon start, use for system-level traces

Recommended: default to `ncu` in scheduled tasks, use `nsys` interactively
when you need full system profiling.
