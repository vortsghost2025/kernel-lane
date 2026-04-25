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
$nsysAvailable = $false
if (Get-Command nsys -ErrorAction SilentlyContinue) {
    $nsysAvailable = $true
} else {
    Write-Host "[WARN] nsys not found on PATH - skipping Nsight Systems capture."
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
        'profile'
        '-t', 'cuda,nvtx'
        '--sample=none'
        '--cpuctxsw=none'
        '-x', 'true'
        '--force-overwrite=true'
        '--stats=true'
        '--gpu-metrics-devices=all'
        '--duration', $DurationSec.ToString()
        '-o', $nsysOutputBase
        $Executable
    )

    $proc = Start-Process -FilePath nsys -ArgumentList $nsysArgs -PassThru -Wait -NoNewWindow
    if ($proc.ExitCode -eq 0) {
        Write-Host "[HEADLESS] nsys capture succeeded."
        $jsonOut = "$nsysOutputBase.json"
        $exportArgs = @('export','--type','json','--output',$jsonOut,"$nsysOutputBase.nsys-rep")
        $exp = Start-Process -FilePath nsys -ArgumentList $exportArgs -PassThru -Wait -NoNewWindow
        if ($exp.ExitCode -eq 0) {
            Write-Host "[HEADLESS] nsys JSON export: $jsonOut"
        } else {
            Write-Host ("[WARN] nsys export failed (exit {0})." -f $exp.ExitCode)
        }
    } else {
        Write-Host ("[WARN] nsys capture failed (exit {0}). Skipping export." -f $proc.ExitCode)
    }
}

# -------------------------------------------------------------------------
# Nsight Compute capture (per-kernel metrics) - two-step: rep then CSV
# -------------------------------------------------------------------------
Write-Host "[HEADLESS] Nsight Compute capture..."

# Step A: collect report (binary .ncu-rep)
$ncuRep = Join-Path $OutputDir "kernel_metrics.ncu-rep"
$ncuArgs = @(
    '--target-processes','all'
    '--set','full'
    '-f'
    '-o', $ncuRep
    $Executable
)
$ncuProc = Start-Process -FilePath ncu -ArgumentList $ncuArgs -PassThru -Wait -NoNewWindow
if ($ncuProc.ExitCode -ne 0) {
    Write-Error ("ncu profiling failed (exit {0})" -f $ncuProc.ExitCode)
    exit $ncuProc.ExitCode
}
Write-Host "[HEADLESS] ncu rep created: $ncuRep"

# Step B: export full CSV from the report (stdout only)
$fullCsv = Join-Path $OutputDir "kernel_metrics_full.csv"
& ncu -i $ncuRep --csv > $fullCsv 2>$null
if ($LASTEXITCODE -ne 0) {
    Write-Host ("[WARN] ncu CSV export failed (exit {0}). Some metrics may be missing." -f $LASTEXITCODE)
}

# Step C: parse full CSV to extract kernel duration rows and build simplified CSV
$simpleCsv = Join-Path $OutputDir "kernel_metrics.csv"
if (Test-Path $fullCsv) {
    try {
        $allRows = Import-Csv $fullCsv
        $durationRows = $allRows | Where-Object { $_.'Metric Name' -eq 'Duration' }
        if ($durationRows.Count -eq 0) {
            Write-Host "[WARN] No 'Duration' metrics found in $fullCsv. Output will lack regression data."
        } else {
            $simpleList = @()
            foreach ($row in $durationRows) {
                $valStr = $row.'Metric Value' -replace ',',''
                $valNum = [double]::Parse($valStr)
                $unit = $row.'Metric Unit'
                if ($unit -eq 'us') {
                    $durationNs = [long]($valNum * 1000)
                } elseif ($unit -eq 'ns') {
                    $durationNs = [long]$valNum
                } else {
                    $durationNs = [long]$valNum
                }
                $obj = [PSCustomObject]@{
                    'Kernel Name' = $row.'Kernel Name'
                    'Kernel Duration (ns)' = $durationNs
                    'Grid Size' = $row.'Grid Size'
                    'Block Size' = $row.'Block Size'
                }
                $simpleList += $obj
            }
            $simpleList | Export-Csv -Path $simpleCsv -NoTypeInformation -Encoding UTF8
            Write-Host ("[HEADLESS] Simplified CSV with durations: {0} ({1} entries)" -f $simpleCsv, $simpleList.Count)
        }
    } catch {
        Write-Host ("[WARN] Failed to parse full CSV: {0}" -f $_)
    }
} else {
    Write-Host "[WARN] Full CSV not found at $fullCsv - skipping duration extraction."
}

Write-Host "`nHead-less profiling complete. Artifacts in: $OutputDir"
