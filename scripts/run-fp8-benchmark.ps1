<#
.SYNOPSIS
  GEN5 FP8 vs FP16 GEMM benchmark runner for the kernel lane.

.DESCRIPTION
  Compiles the FP8 kernel, runs it at 1024^3, 2048^3, 4096^3, collects
  NCU profiling metrics (optional), and writes JSON + CSV reports.

.PARAMETER Sizes
  Comma-separated problem sizes. Default: "1024,2048,4096"

.PARAMETER SkipNcu
  Skip Nsight Compute profiling (faster but no hardware metrics).

.PARAMETER SkipBuild
  Skip the compile step (use existing binaries).

.PARAMETER ReportDir
  Directory for benchmark reports. Default: benchmarks/reports
#>
param(
    [string]$Sizes = "1024,2048,4096",
    [switch]$SkipNcu,
    [switch]$SkipBuild,
    [string]$ReportDir = "benchmarks/reports"
)

$ErrorActionPreference = "Stop"

# -------------------------------------------------------------------------
# Resolve paths
# -------------------------------------------------------------------------
$projectRoot = Join-Path $PSScriptRoot ".."
$srcFile      = Join-Path $projectRoot "kernels\src\matrixMul_wmma_fp8_async.cu"
$exeDir       = Join-Path $projectRoot "kernels\bin"
$fp8Exe       = Join-Path $exeDir "matrixMul_wmma_fp8_async.exe"
$reportDirAbs = Join-Path $projectRoot $ReportDir

New-Item -ItemType Directory -Force -Path $exeDir       | Out-Null
New-Item -ItemType Directory -Force -Path $reportDirAbs | Out-Null

# -------------------------------------------------------------------------
# Import MSVC environment (same as build-kernels.ps1)
# -------------------------------------------------------------------------
if (-not (Get-Command 'cl.exe' -ErrorAction SilentlyContinue)) {
    $vcvarsall = 'C:\Program Files\Microsoft Visual Studio\18\Community\VC\Auxiliary\Build\vcvarsall.bat'
    if (Test-Path $vcvarsall) {
        Write-Host "[ENV] Importing MSVC environment from $vcvarsall"
        $output = cmd /c "`"$vcvarsall`" x64 > nul 2>&1 && set" 2>$null
        if ($LASTEXITCODE -eq 0) {
            foreach ($line in $output) {
                if ($line -match '^([^=]+)=(.*)$') {
                    [System.Environment]::SetEnvironmentVariable($matches[1], $matches[2], 'Process')
                }
            }
            Write-Host "[ENV] MSVC environment imported"
        } else {
            Write-Host "[ERROR] Failed to import MSVC environment"
            exit 1
        }
    } else {
        Write-Host "[ERROR] cl.exe not found and vcvarsall.bat missing."
        exit 1
    }
}

# -------------------------------------------------------------------------
# Step 1: Compile the FP8 kernel
# -------------------------------------------------------------------------
if (-not $SkipBuild) {
    Write-Host "[BUILD] Compiling FP8 kernel..."
    $nvccArgs = @"
-arch=sm_120 -lineinfo -std=c++17 -DCCCL_IGNORE_DEPRECATED_CPP_DIALECT -Xcompiler "/Zc:preprocessor" -o "$fp8Exe" "$srcFile" -O3 --use_fast_math -lcublasLt -lcublas
"@
    $nvccCmd = "nvcc $nvccArgs"
    Write-Host "[BUILD] $nvccCmd"
    cmd /c $nvccCmd
    if ($LASTEXITCODE -ne 0) {
        Write-Host "[ERROR] nvcc compilation failed (exit $LASTEXITCODE)"
        exit $LASTEXITCODE
    }
    Write-Host "[BUILD] FP8 kernel compiled: $fp8Exe"
} else {
    Write-Host "[BUILD] Skipping compilation (using existing binary)"
}

# -------------------------------------------------------------------------
# GPU detection
# -------------------------------------------------------------------------
$gpuName = "unknown"
try {
    $gpuName = (nvidia-smi --query-gpu=name --format=csv,noheader | Select-Object -First 1).Trim()
} catch { }

# -------------------------------------------------------------------------
# Step 2: Run FP8 + FP16 benchmarks at each size
# -------------------------------------------------------------------------
$sizeList = $Sizes -split "," | ForEach-Object { $_.Trim() }
$results  = @{}

foreach ($sz in $sizeList) {
    Write-Host "`n[RUN] Benchmarking size ${sz}^3..."

    # Run FP8+FP16 comparison (the exe runs both when mode=both)
    $output = & $fp8Exe $sz "both" 2>&1 | Out-String
    Write-Host $output

    # Parse FP8 fallback WMMA timing
    $fp8_ms = $null
    if ($output -match 'matrixMul_fp8_fallback_wmma:\s+([\d.]+)\s+ms') {
        $fp8_ms = [float]$matches[1]
    }

    # Parse cuBLASLt FP8 timing
    $cublaslt_ms = $null
    if ($output -match 'cublasLt_fp8_e4m3:\s+([\d.]+)\s+ms') {
        $cublaslt_ms = [float]$matches[1]
    }

    # Parse FP16 timing
    $fp16_ms = $null
    if ($output -match 'matrixMul_wmma_async_fp16_ref:\s+([\d.]+)\s+ms') {
        $fp16_ms = [float]$matches[1]
    }

    # Parse speedup
    $speedup = $null
    if ($output -match 'cuBLASLt FP8 speed-up vs FP16 WMMA:\s+([\d.]+)x') {
        $speedup = [float]$matches[1]
    } elseif ($cublaslt_ms -and $fp16_ms -and $fp16_ms -gt 0) {
        $speedup = [float]($fp16_ms / $cublaslt_ms)
    }

    # Compute TFLOPS
    $szInt = [int]$sz
    $flops = 2.0 * $szInt * $szInt * $szInt
    $fp8_tflops     = if ($fp8_ms)      { [float]($flops / ($fp8_ms / 1000.0) / 1e12) } else { $null }
    $cublaslt_tflops = if ($cublaslt_ms) { [float]($flops / ($cublaslt_ms / 1000.0) / 1e12) } else { $null }
    $fp16_tflops    = if ($fp16_ms)     { [float]($flops / ($fp16_ms / 1000.0) / 1e12) } else { $null }

    $results[$sz] = [ordered]@{
        fp8_fallback_ms   = $fp8_ms
        cublaslt_fp8_ms   = $cublaslt_ms
        fp16_ms           = $fp16_ms
        speedup           = $speedup
        fp8_fallback_tflops  = $fp8_tflops
        cublaslt_fp8_tflops  = $cublaslt_tflops
        fp16_tflops          = $fp16_tflops
    }


}

# -------------------------------------------------------------------------
# Step 3: NCU profiling (optional)
# -------------------------------------------------------------------------
$ncuMetrics = @()
if (-not $SkipNcu) {
    # Resolve ncu path
    $ncuExe = $null
    if (Get-Command ncu -ErrorAction SilentlyContinue) {
        $ncuExe = "ncu"
    } else {
        $ncuCandidates = @(
            'C:\Program Files\NVIDIA Corporation\Nsight Compute 2026.1.0\ncu.exe',
            'C:\Program Files\NVIDIA Corporation\Nsight Compute 2025.6.1\ncu.exe',
            'C:\Program Files\NVIDIA Corporation\Nsight Compute 2025.5.1\ncu.exe'
        )
        foreach ($p in $ncuCandidates) {
            if (Test-Path $p) { $ncuExe = $p; break }
        }
    }

    if (-not $ncuExe) {
        Write-Host "[WARN] ncu not found - skipping NCU profiling"
    } else {
        Write-Host "`n[NCU] Collecting FP8 tensor-core metrics..."

        $metricList = @(
            "sm__ops_path_tensor_op_imma_src_fp8_dst_fp16_sparsity_off",
            "sm__ops_path_tensor_op_imma_src_fp8_dst_fp32_sparsity_off",
            "sm__ops_path_tensor_op_hmma_src_fp16_dst_fp32_sparsity_off",
            "sm__warps_active",
            "sm__pipeline_stall_cycles",
            "smsp__warp_issue_stalled_long_scoreboard_per_warp_active",
            "smsp__warp_issue_stalled_short_scoreboard_per_warp_active",
            "dram__bytes_read",
            "dram__bytes_written"
        ) -join ","

        foreach ($sz in $sizeList) {
            $ncuOut = Join-Path $reportDirAbs "gen5_fp8_ncu_$sz"
            $ncuCsv = Join-Path $reportDirAbs "gen5_fp8_ncu_${sz}.csv"

            $ncuCmd = "`"$ncuExe`" --set full -k matrixMul_fp8_fallback_wmma --launch-count 1 --metrics $metricList -o `"$ncuOut`" `"$fp8Exe`" $sz fp8"
            Write-Host "[NCU] Profiling FP8 @ ${sz}^3..."
            cmd /c $ncuCmd

            # Export CSV
            if (Test-Path "$ncuOut.ncu-rep") {
                $exportCmd = "`"$ncuExe`" --import `"$ncuOut.ncu-rep`" --csv --page raw"
                cmd /c $exportCmd > $ncuCsv 2>$null
                Write-Host "[NCU] CSV: $ncuCsv"
            }
            $ncuMetrics += @{
                size = $sz
                rep  = "$ncuOut.ncu-rep"
                csv  = $ncuCsv
            }
        }
    }
}

# -------------------------------------------------------------------------
# Step 4: Write JSON report
# -------------------------------------------------------------------------
$ts = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
$jsonReport = [ordered]@{
    name           = "gen5_fp8_vs_fp16"
    created_at_utc = $ts
    gpu            = $gpuName
    build_flags    = "nvcc -arch=sm_120 -O3 --use_fast_math -std=c++17"
    kernel_block   = "dim3(32,8,1) = 256 threads / 8 warps per block"
    sizes          = $results
    ncu_profiles   = $ncuMetrics
}

$jsonOut = Join-Path $reportDirAbs "gen5_fp8_benchmark.json"
$jsonReport | ConvertTo-Json -Depth 8 | Set-Content -Path $jsonOut -Encoding UTF8
Write-Host "`n[REPORT] JSON: $jsonOut"

# -------------------------------------------------------------------------
# Step 5: Write CSV summary
# -------------------------------------------------------------------------
$csvRows = @()
foreach ($sz in $sizeList) {
    $r = $results[$sz]
    $csvRows += [PSCustomObject]@{
        Size              = $sz
        FP8_Fallback_ms   = if ($r.fp8_fallback_ms)  { [math]::Round($r.fp8_fallback_ms, 3)  } else { "N/A" }
        cuBLASLt_FP8_ms   = if ($r.cublaslt_fp8_ms)  { [math]::Round($r.cublaslt_fp8_ms, 3)  } else { "N/A" }
        FP16_ms           = if ($r.fp16_ms)           { [math]::Round($r.fp16_ms, 3)           } else { "N/A" }
        Speedup           = if ($r.speedup)           { [math]::Round($r.speedup, 2)            } else { "N/A" }
        FP8_Fallback_TFLOPS  = if ($r.fp8_fallback_tflops)  { [math]::Round($r.fp8_fallback_tflops, 2)  } else { "N/A" }
        cuBLASLt_FP8_TFLOPS  = if ($r.cublaslt_fp8_tflops)  { [math]::Round($r.cublaslt_fp8_tflops, 2)  } else { "N/A" }
        FP16_TFLOPS          = if ($r.fp16_tflops)          { [math]::Round($r.fp16_tflops, 2)          } else { "N/A" }
    }
}

$csvOut = Join-Path $reportDirAbs "gen5_fp8_vs_fp16.csv"
$csvRows | Export-Csv -Path $csvOut -NoTypeInformation -Encoding UTF8
Write-Host "[REPORT] CSV: $csvOut"

# -------------------------------------------------------------------------
# Summary table
# -------------------------------------------------------------------------
Write-Host "`n=== GEN5 FP8 vs FP16 Benchmark Summary ==="
Write-Host ("{0,-8} {1,12} {2,12} {3,10} {4,10} {5,10}" -f "Size", "cuBLASLt(ms)", "FP16(ms)", "Speedup", "cuBLAS(TF)", "FP16(TF)")
Write-Host ("-" * 66)
foreach ($sz in $sizeList) {
    $r = $results[$sz]
    $cubltStr = if ($r.cublaslt_fp8_ms) { "{0,12:F3}" -f $r.cublaslt_fp8_ms } else { "{0,12}" -f "N/A" }
    $fp16Str  = if ($r.fp16_ms)         { "{0,10:F3}" -f $r.fp16_ms          } else { "{0,10}" -f "N/A" }
    $spStr    = if ($r.speedup)         { "{0,10:F2}x" -f $r.speedup         } else { "{0,10}" -f "N/A" }
    $tfCubStr = if ($r.cublaslt_fp8_tflops) { "{0,10:F2}" -f $r.cublaslt_fp8_tflops } else { "{0,10}" -f "N/A" }
    $tf16Str  = if ($r.fp16_tflops)          { "{0,10:F2}" -f $r.fp16_tflops          } else { "{0,10}" -f "N/A" }
    Write-Host ("{0,-8} {1} {2} {3} {4} {5}" -f "${sz}^3", $cubltStr, $fp16Str, $spStr, $tfCubStr, $tf16Str)
}