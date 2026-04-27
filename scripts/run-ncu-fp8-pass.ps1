param(
    [string]$ExePath = ".\kernels\bin\matrixMul_wmma_fp8_async.exe",
    [int]$Size = 2048,
    [string]$OutPrefix = "gen5_fp8",
    [string]$ReportDir = "benchmarks/reports"
)

$ErrorActionPreference = "Stop"
New-Item -ItemType Directory -Force -Path $ReportDir | Out-Null

$metrics = @(
    "sm__ops_path_tensor_op_imma_src_fp8_dst_fp16_sparsity_off",
    "sm__ops_path_tensor_op_imma_src_fp8_dst_fp32_sparsity_off",
    "sm__ops_path_tensor_op_hmma_src_fp16_dst_fp32_sparsity_off",
    "sm__warps_active",
    "sm__warps_launched",
    "smsp__warp_issue_stalled_barrier_per_warp_active",
    "smsp__warp_issue_stalled_long_scoreboard_per_warp_active",
    "smsp__warp_issue_stalled_short_scoreboard_per_warp_active",
    "smsp__warp_issue_stalled_mio_throttle_per_warp_active",
    "smsp__warp_issue_stalled_math_pipe_throttle_per_warp_active",
    "smsp__warp_issue_stalled_wait_per_warp_active",
    "sm__pipeline_stall_cycles",
    "l1tex__data_pipe_lg_wavefronts_mem_shared_op_ld_st_read",
    "l1tex__data_pipe_lg_wavefronts_mem_shared_op_ld_st_write",
    "dram__bytes_read",
    "dram__bytes_written",
    "lts__t_sectors_pipe_lsu_mem_global_op_ld.sum",
    "lts__t_sectors_pipe_lsu_mem_global_op_st.sum"
) -join ","

$queryOut = Join-Path $ReportDir "$OutPrefix`_query_metrics.txt"
ncu --query-metrics | Select-String "warp_issue_stalled_|sm__warps_active|sm__warps_launched|pipeline_stall|fp8|tensor_op_imma" | Set-Content -Path $queryOut

# Profile FP8 async-8warp kernel
$repFp8 = Join-Path $ReportDir "$OutPrefix`_fp8"
$csvFp8 = Join-Path $ReportDir "$OutPrefix`_fp8.csv"
ncu --set full -k matrixMul_fp8_fallback_wmma --launch-skip 1 --launch-count 1 --metrics $metrics -o $repFp8 "$ExePath" "$Size" "fp8"
ncu --import "$repFp8.ncu-rep" --csv --page raw > $csvFp8

# Profile FP16 async-8warp kernel for side-by-side comparison
$repFp16 = Join-Path $ReportDir "$OutPrefix`_fp16_compare"
$csvFp16 = Join-Path $ReportDir "$OutPrefix`_fp16_compare.csv"
$fp16Exe = Join-Path (Split-Path $ExePath) "..\matrix_tensor_optimized.exe" | Resolve-Path
ncu --set full -k matrixMul_wmma_async --launch-skip 1 --launch-count 1 --metrics $metrics -o $repFp16 "$fp16Exe" "$Size"
ncu --import "$repFp16.ncu-rep" --csv --page raw > $csvFp16

Write-Host "Wrote:"
Write-Host " - $queryOut"
Write-Host " - $repFp8.ncu-rep"
Write-Host " - $csvFp8"
Write-Host " - $repFp16.ncu-rep"
Write-Host " - $csvFp16"
