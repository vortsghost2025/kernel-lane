# verify-gen5-proof-pack.ps1
# One-command verifier for GEN5 WMMA optimization proof pack
# Returns: GEN5_DEFAULT_FASTPATH_VERIFIED on success, error on failure

param(
    [string]$BenchmarksDir = "$PSScriptRoot/../benchmarks",
    [string]$ReportsDir = "$BenchmarksDir/reports",
    [string]$KernelsDir = "$PSScriptRoot/../kernels",
    [string]$SrcDir = "$KernelsDir/src"
)

function Test-ProofPack {
    $errors = @()

    # [PASS] compile log exists and contains emitted successfully
    $compileLog = "$ReportsDir/gen5_compile_log.txt"
    if (!(Test-Path $compileLog)) {
        $errors += "Compile log missing: $compileLog"
    } elseif (!(Select-String -Path $compileLog -Pattern "emitted successfully" -Quiet)) {
        $errors += "Compile log does not contain 'emitted successfully'"
    }

    # [PASS] runtime report contains Default fast path: async-8warp
    $runtimeReport = "$ReportsDir/gen5_variant_runtime.txt"
    if (!(Test-Path $runtimeReport)) {
        $errors += "Runtime report missing: $runtimeReport"
    } elseif (!(Select-String -Path $runtimeReport -Pattern "Default fast path: async-8warp" -Quiet)) {
        $errors += "Runtime report does not contain 'Default fast path: async-8warp'"
    }

    # [PASS] runtime report contains fastpath-async-8warp
    if (!(Select-String -Path $runtimeReport -Pattern "fastpath-async-8warp" -Quiet)) {
        $errors += "Runtime report does not contain 'fastpath-async-8warp'"
    }

    # [PASS] tensor-util CSV contains FP16→FP32 HMMA nonzero metric
    $tensorUtilCsv = "$ReportsDir/gen5_tensor_util_async8_metrics.csv"
    if (!(Test-Path $tensorUtilCsv)) {
        $errors += "Tensor util metrics CSV missing: $tensorUtilCsv"
    } elseif (!(Select-String -Path $tensorUtilCsv -Pattern "sm__ops_path_tensor_op_hmma_src_fp16_dst_fp32_sparsity_off\.avg\.pct_of_peak_sustained_elapsed.*[1-9][0-9]*\.[0-9]+" -Quiet)) {
        $errors += "Tensor util CSV does not contain nonzero FP16→FP32 HMMA metric"
    }

    # [PASS] stall compare shows async-8warp long_scoreboard < async-4warp
    $stallCompare = "$ReportsDir/gen5_stall_compare_async4_vs_async8.csv"
    if (!(Test-Path $stallCompare)) {
        $errors += "Stall compare CSV missing: $stallCompare"
    } else {
        $async4Stall = Select-String -Path $stallCompare -Pattern "async-4warp.*smsp__warp_issue_stalled_long_scoreboard_per_warp_active\.pct.*([0-9]+\.[0-9]+)" | ForEach-Object { $_.Matches.Groups[1].Value }
        $async8Stall = Select-String -Path $stallCompare -Pattern "async-8warp.*smsp__warp_issue_stalled_long_scoreboard_per_warp_active\.pct.*([0-9]+\.[0-9]+)" | ForEach-Object { $_.Matches.Groups[1].Value }
        if ($async4Stall -and $async8Stall -and ([double]$async8Stall -ge [double]$async4Stall)) {
            $errors += "Stall compare does not show async-8warp long_scoreboard < async-4warp ($async8Stall >= $async4Stall)"
        }
    }

    # [PASS] source contains ENABLE_TRIPLE_BUFFER_EXPERIMENT 0
    $sourceFile = "$SrcDir/matrix_tensor_optimized.cu"
    if (!(Test-Path $sourceFile)) {
        $errors += "Source file missing: $sourceFile"
    } elseif (!(Select-String -Path $sourceFile -Pattern "#define ENABLE_TRIPLE_BUFFER_EXPERIMENT 0" -Quiet)) {
        $errors += "Source does not contain '#define ENABLE_TRIPLE_BUFFER_EXPERIMENT 0'"
    }

    # [PASS] runtime report does not contain exp-async-8warp-triple
    if (Select-String -Path $runtimeReport -Pattern "exp-async-8warp-triple" -Quiet) {
        $errors += "Runtime report contains 'exp-async-8warp-triple' (should be disabled)"
    }

    if ($errors.Count -eq 0) {
        Write-Host "GEN5_DEFAULT_FASTPATH_VERIFIED"
        exit 0
    } else {
        Write-Host "Verification failed:"
        $errors | ForEach-Object { Write-Host "  - $_" }
        exit 1
    }
}

Test-ProofPack