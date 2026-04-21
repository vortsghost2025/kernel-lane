<#
.SYNOPSIS
  Collect Nsight Systems profile from an interactive desktop session.

.DESCRIPTION
  This script MUST be run from an interactive admin PowerShell session.
  The nsys daemon requires a desktop dialog acceptance that headless/agent
  sessions cannot provide. Run this once, then the .nsys-rep file will be
  available for release promotion.

  Usage:
    powershell -ExecutionPolicy Bypass -File scripts\collect-nsys.ps1

  After success, re-promote with:
    scripts\promote-release.ps1 -Version v0.1.0 -ArtifactPath build/Release/benchmark.exe `
      -BenchmarkReportPath benchmarks/reports/baseline.json `
      -NcuReportPath profiles/ncu/baseline.ncu-rep `
      -NsysReportPath profiles/nsys/baseline.nsys-rep `
      -Claim "Baseline release: RTX 5060 FMA kernel benchmark + ncu + nsys profile"
#>

param(
    [string]$NsysExe = 'C:\Program Files\NVIDIA Corporation\Nsight Systems 2026.2.1\target-windows-x64\nsys.exe',
    [string]$TargetExe = '',
    [string]$OutputName = 'baseline',
    [string]$OutputDir = ''
)

# Resolve nsys.exe
if (!(Test-Path $NsysExe)) {
    # Try 2025 version
    $fallback = 'C:\Program Files\NVIDIA Corporation\Nsight Systems 2025.6.3\target-windows-x64\nsys.exe'
    if (Test-Path $fallback) {
        $NsysExe = $fallback
        Write-Host "[INFO] Using fallback nsys: $NsysExe"
    } else {
        throw "nsys.exe not found at: $NsysExe"
    }
}

# Resolve target executable
if (!$TargetExe) {
    $TargetExe = Join-Path $PSScriptRoot '..\build\Release\profile_target.exe'
    if (!(Test-Path $TargetExe)) {
        $TargetExe = Join-Path $PSScriptRoot '..\build\Release\matrix_benchmark.exe'
    }
}
if (!(Test-Path $TargetExe)) {
    $resolved = Join-Path $PSScriptRoot $TargetExe
    if (!(Test-Path $resolved)) {
        throw "Target executable not found: $TargetExe"
    }
    $TargetExe = $resolved
}
$TargetExe = (Resolve-Path $TargetExe).Path

# Resolve output directory
if (!$OutputDir) {
    $OutputDir = Join-Path $PSScriptRoot '..\profiles\nsys'
}
New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null
$OutputPath = Join-Path $OutputDir $OutputName

Write-Host "[NSYS] Exe: $NsysExe"
Write-Host "[NSYS] Target: $TargetExe"
Write-Host "[NSYS] Output: $OutputPath.nsys-rep"
Write-Host ""
Write-Host "IMPORTANT: When the Nsight Systems dialog appears, click Accept/Allow."
Write-Host "Starting profile in 3 seconds..."
Start-Sleep -Seconds 3

# Run nsys profile:
#   -t cuda       = trace CUDA APIs (REQUIRED - none causes exit -1)
#   --sample=none = skip CPU sampling (needs admin, not useful for GPU kernel profiling)
#   --cpuctxsw=none = skip CPU context switches (needs admin)
#   -x true       = stop when target exits
#   --force-overwrite = overwrite existing output
#   --stats=true  = generate SQLite stats
$nsysArgs = @(
    'profile',
    '-t', 'cuda',
    '--sample=none',
    '--cpuctxsw=none',
    '-x', 'true',
    '--force-overwrite=true',
    '--stats=true',
    '-o', $OutputPath,
    $TargetExe
)

$proc = Start-Process -FilePath $NsysExe -ArgumentList $nsysArgs -PassThru -NoNewWindow -Wait

if ($proc.ExitCode -eq 0) {
    # Check for output files
    $nsysRep = Get-ChildItem "$OutputPath*" -Include '*.nsys-rep' -ErrorAction SilentlyContinue
    if ($nsysRep) {
        Write-Host "[PASS] nsys profile collected: $($nsysRep.FullName) ($([math]::Round($nsysRep.Length/1MB,1)) MB)"
    } else {
        Write-Host "[WARN] nsys exited 0 but no .nsys-rep found at $OutputPath"
        Write-Host "[INFO] Checking for .qdstrm files (may need finalize)..."
        $qdstrm = Get-ChildItem "$OutputPath*" -Include '*.qdstrm' -ErrorAction SilentlyContinue
        if ($qdstrm) {
            Write-Host "[INFO] Found .qdstrm: $($qdstrm.FullName) - run 'nsys finalize' to convert"
        }
    }
} else {
    Write-Host "[FAIL] nsys exited with code $($proc.ExitCode)"
    Write-Host "[HINT] Common causes:"
    Write-Host "  - Daemon dialog was not accepted (click Accept/Allow when prompted)"
    Write-Host "  - GPU driver issue (update to latest driver)"
    Write-Host "  - Target executable crashed before producing any CUDA work"
}

# Write metadata
$meta = [ordered]@{
    name = $OutputName
    executable = $TargetExe
    nsys_version = (& $NsysExe --version 2>&1 | Select-Object -First 1)
    created_at_utc = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
    tool = 'nsys'
    args = $nsysArgs -join ' '
    exit_code = $proc.ExitCode
}
$metaPath = Join-Path $OutputDir "${OutputName}_meta.json"
$meta | ConvertTo-Json -Depth 4 | Set-Content -Path $metaPath -Encoding UTF8
Write-Host "[META] $metaPath"
