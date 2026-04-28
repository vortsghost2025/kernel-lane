# GEN5 FP8 Investigation Archive

**Date:** 2026-04-26
**Status:** Complete — hypothesis disproven
**Tag:** `GEN5_FP8_FASTPATH_VERIFIED` — **DO NOT APPLY**

## Summary

The investigation into native FP8 tensor-core GEMM on SM 120 (GeForce RTX 5060) concluded:

- SM 120 (Blackwell consumer) does NOT support `tcgen05.mma` — the FP8 tensor-core CTA-level instruction requires SM 100/103/110 (data-center Blackwell).
- WMMA FP8 fragments (16x16x16) do NOT exist in CUDA 13.2 for any architecture.
- FP8→FP16 WMMA fallback uses FP16 tensor cores after conversion; no native FP8 tensor throughput advantage.
- cuBLASLt FP8 achieves 7-31× speedup over the custom FP16 WMMA kernel, indicating NVIDIA's library uses an internal native FP8 path unavailable through public WMMA API.

## Archived Report

- `gen5_fp8_vs_fp16.md` — Full benchmark report with timing results, architecture analysis, and convergence gate.
- Supporting artifacts: `benchmarks/reports/gen5_fp8_benchmark.json`, `benchmarks/reports/gen5_fp8_vs_fp16.csv`

## Key Finding (for cross-lane indexing)

> **Spec revision:** cuBLASLt is the practical FP8 fast path on SM 120; WMMA FP8 fragments are N/A in current CUDA headers for this use case. Any tag asserting native FP8 WMMA verification should be rejected.
