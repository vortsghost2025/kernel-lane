param(
  [string]$ExePath = ".\matrix_tensor_optimized.exe",
  [string]$OutPrefix = "gen5_stall",
  [string]$ReportDir = "benchmarks/reports"
)

$ErrorActionPreference = "Stop"
New-Item -ItemType Directory -Force -Path $ReportDir | Out-Null

$metrics = @(
  "sm__warps_active",
  "sm__warps_launched",
  "smsp__warp_issue_stalled_barrier_per_warp_active",
  "smsp__warp_issue_stalled_long_scoreboard_per_warp_active",
  "smsp__warp_issue_stalled_short_scoreboard_per_warp_active",
  "smsp__warp_issue_stalled_mio_throttle_per_warp_active",
  "smsp__warp_issue_stalled_math_pipe_throttle_per_warp_active",
  "smsp__warp_issue_stalled_wait_per_warp_active"
) -join ","

$queryOut = Join-Path $ReportDir "$OutPrefix`_query_metrics.txt"
ncu --query-metrics | Select-String "warp_issue_stalled_|sm__warps_active|sm__warps_launched" | Set-Content -Path $queryOut

$rep = Join-Path $ReportDir "$OutPrefix`_async8"
$csv = Join-Path $ReportDir "$OutPrefix`_async8.csv"

# fastpath-async-8warp is the second matrixMul_wmma_async launch in main()
ncu --set full -k matrixMul_wmma_async --launch-skip 1 --launch-count 1 --metrics $metrics -o $rep $ExePath
ncu --import "$rep.ncu-rep" --csv --page raw > $csv

Write-Host "Wrote:"
Write-Host " - $queryOut"
Write-Host " - $rep.ncu-rep"
Write-Host " - $csv"
