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

| Kernel | Latency (ms) | TFLOPS | Tensor Core Util |
|-------|--------------|--------|------------------|
| baseline (1 warp) | 5.1 | 0.88 | ~35% |
| padded 4-warp | 0.32 | 14.0 | ~95% |
| async scaffold | 0.30 | 15.0 | ~96% |
