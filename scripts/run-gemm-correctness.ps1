<#
.SYNOPSIS
Run GEMM correctness tests with optional size parameter.

.DESCRIPTION
Compiles and runs the CUDA correctness test suite, comparing all
WMMA GEMM kernels against a CPU FP32 reference. Produces pass/fail
output with per-kernel error metrics.

.PARAMETER Size
Problem size (must be multiple of 16). Default: 256 (fast sanity).
Use 1024 for full validation.

.PARAMETER SkipBuild
Skip compilation (use existing binary).

.EXAMPLE
.\scripts\run-gemm-correctness.ps1 -Size 256
.\scripts\run-gemm-correctness.ps1 -Size 1024
#>
param(
    [int]$Size = 256,
    [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"

$projectRoot = Join-Path $PSScriptRoot ".."
$testExe = Join-Path $projectRoot "kernels\bin\test_gemm_correctness.exe"

if (-not $SkipBuild) {
    & (Join-Path $PSScriptRoot "build-kernels.ps1") -Configuration Release
    if ($LASTEXITCODE -ne 0) {
        Write-Host "[ERROR] Build failed"
        exit $LASTEXITCODE
    }
}

if (-not (Test-Path $testExe)) {
    Write-Host "[ERROR] Test binary not found: $testExe"
    Write-Host "[HINT] Run with -SkipBuild after building, or remove -SkipBuild"
    exit 1
}

Write-Host "`n[TEST] Running GEMM correctness test at size ${Size}^3..."
& $testExe $Size
$testExit = $LASTEXITCODE

if ($testExit -eq 0) {
    Write-Host "`n[RESULT] All correctness tests PASSED" -ForegroundColor Green
} else {
    Write-Host "`n[RESULT] Some correctness tests FAILED (exit $testExit)" -ForegroundColor Red
}

exit $testExit
