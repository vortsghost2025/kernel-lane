<#
.SYNOPSIS
Run head-less Nsight Systems + Nsight Compute profiling for the kernel lane.

.DESCRIPTION
Captures a system-wide timeline with Nsight Systems (if available) and
per-kernel metrics with Nsight Compute. Designed for CI / headless environments.

.PARAMETER Executable
Path to the benchmark executable. Default: build\Release\benchmark.exe

.PARAMETER OutputDir
Directory where profiling artifacts will be written. Default: profiles\headless

.PARAMETER DurationSec
Maximum wall-clock duration for the Nsight Systems capture. Default: 30
#>
param(
    [string]$Executable   = "build\Release\benchmark.exe",
    [string]$OutputDir    = "profiles\headless",
    [int]   $DurationSec  = 30
)

# -------------------------------------------------------------------------
# Pre-flight: verify tools
# -------------------------------------------------------------------------
if (-not (Get-Command nsys -ErrorAction SilentlyContinue)) {
    Write-Host "[WARN] nsys not found on PATH — skipping Nsight Systems capture."
    $nsysAvailable = $false
} else {
    $nsysAvailable = $true
}
if (-not (Get-Command ncu -ErrorAction SilentlyContinue)) {
    Write-Error "ncu not found on PATH. Install Nsight Compute."
    exit 1
}

# -------------------------------------------------------------------------
# Prepare output folder
# -------------------------------------------------------------------------
New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null

# -------------------------------------------------------------------------
# Nsight Systems capture (system-wide timeline)
# -------------------------------------------------------------------------
if ($nsysAvailable) {
    Write-Host "[HEADLESS] Nsight Systems capture..."
    $nsysOutputBase = Join-Path $OutputDir "kernel_profile"

    $nsysArgs = @(
        'profile',
        '-t', 'cuda,nvtx,osrt',
        '--sample=none',
        '--cpuctxsw=none',
        '-x', 'true',
        '--force-overwrite=true',
        '--stats=true',
        '--capture-range=cudaLaunchKernel',
        '--capture-range-end=cudaDeviceSynchronize',
        '--gpu-metrics-device=all',
        "--duration=${DurationSec}s",
        '-o', $nsysOutputBase,
        $Executable
    )

    $proc = Start-Process -FilePath nsys -ArgumentList $nsysArgs -PassThru -Wait -NoNewWindow
    if ($proc.ExitCode -eq 0) {
        Write-Host "[HEADLESS] nsys capture succeeded."
        # Export to JSON for CI friendliness
        $exportArgs = @('export','--type','json','--output',"$nsysOutputBase.json","$nsysOutputBase.nsys-rep")
        $exp = Start-Process -FilePath nsys -ArgumentList $exportArgs -PassThru -Wait -NoNewWindow
        if ($exp.ExitCode -eq 0) {
            Write-Host "[HEADLESS] nsys JSON export created: $nsysOutputBase.json"
        } else {
            Write-Host "[WARN] nsys export failed with exit $($exp.ExitCode)"
        }
    } else {
        Write-Host "[WARN] nsys capture failed with exit $($proc.ExitCode). Skipping export."
    }
} else {
    Write-Host "[SKIP] Nsight Systems (nsys not available)"
}

# -------------------------------------------------------------------------
# Nsight Compute capture (per-kernel metrics)
# -------------------------------------------------------------------------
Write-Host "[HEADLESS] Nsight Compute capture..."
$ncuOutputBase = Join-Path $OutputDir "kernel_metrics"
$ncuArgs = @(
    '--target-processes','all',
    '--set','full',
    '--csv',
    '--force-overwrite',
    '-o', $ncuOutputBase,
    $Executable
)
$ncuProc = Start-Process -FilePath ncu -ArgumentList $ncuArgs -PassThru -Wait -NoNewWindow
if ($ncuProc.ExitCode -ne 0) {
    Write-Error "ncu failed with exit code $($ncuProc.ExitCode)"
    exit $ncuProc.ExitCode
}
Write-Host "[HEADLESS] Nsight Compute capture succeeded."

# Verify expected artifacts
$csvPath = "$ncuOutputBase.csv"
if (-not (Test-Path $csvPath)) {
    Write-Error "Expected CSV export not found: $csvPath"
    exit 1
}

Write-Host "`n✅ Head-less profiling complete. Artifacts in: $OutputDir"
