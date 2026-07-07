# Kernel Sources – RTX 5060 (SM 120)

## Overview
- `matrix_tensor_async.cu`: Async double-buffered WMMA GEMM (FP16 & FP8) with 4‑warp blocks.
- `matrix_tensor_optimized.cu`: Baseline, padded 4‑warp, async scaffold kernels.
- Other helper kernels and benchmarks.

## Build
Run the provided script:

```powershell
.\scripts\build-kernels.ps1 -Configuration Release
```

The script:
- Imports MSVC environment if needed.
- Compiles `.cu` files with `nvcc -arch=sm_120 -lineinfo -O3 --use_fast_math`.
- Places executables in `kernels\bin\`.

## Profiling
Use `scripts\run-headless-profiling.ps1`:

```powershell
.\scripts\run-headless-profiling.ps1 -Executable kernels\bin\matrix_tensor_async.exe -Mode fp16
```

Produces CSV reports under `profiles/headless/`.

## RTX 5060 Benchmark (1024×1024, FP16)

> **Benchmark numbers are versioned — read before quoting TFLOPS.**
>
> The table below is an **early async scaffold run** (pre-GEN5). It used an
> earlier kernel + timing method and is **superseded**. The corrected,
> evidence-backed figures live in **`kernels/benchmark_report.json`** (GEN5
> release run, with correctness checks + Nsight Compute evidence) — that file
> is the **source of truth**.
>
> For 1024×1024 FP16 the GEN5 report gives ~6.14 TFLOPS for the
> `fastpath-async-8warp` kernel (vs the 14–15 TFLOPS shown here). The higher
> scaffold figures came from a different timing method and are not the current
> canonical result.

| Kernel | Latency (ms) | TFLOPS | Tensor Core Util | Version |
|-------|--------------|--------|------------------|---------|
| baseline (1 warp) | 5.1 | 0.88 | ~35% | scaffold (pre-GEN5) |
| padded 4-warp | 0.32 | 14.0 | ~95% | scaffold (pre-GEN5) |
| async scaffold | 0.30 | 15.0 | ~96% | scaffold (pre-GEN5) |

**Source of truth:** `kernels/benchmark_report.json` (report version GEN5).
