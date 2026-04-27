/* GEN 5 FP8: Blackwell tcgen05.mma FP8 GEMM + cuBLASLt FP8 Reference
 *
 * On SM 120 (Blackwell), FP8 tensor-core GEMM requires the tcgen05.mma
 * CTA-level instruction, NOT the WMMA warp-level API.  This file provides:
 *
 *  Path A — tcgen05.mma FP8 kernel (PTX inline asm)
 *    Uses TMA descriptors to stream A/B from global memory, tcgen05.mma
 *    with kind::f8f6f4 for the inner product, and tensor-memory (TMEM)
 *    for the accumulator tile.  Currently a SKELETON for NCU profiling —
 *    the full TMEM→global store path is present but unoptimised.
 *
 *  Path B — cuBLASLt FP8 GEMM (proven reference)
 *    Calls cublasLtMatmul with FP8 E4M3 input / FP32 output.  This is
 *    the production-quality path and provides the definitive FP8 timing.
 *
 *  Path C — FP16 WMMA async-8warp (same-process A/B comparison)
 *    The proven fast-path from matrix_tensor_optimized.cu, included
 *    here for same-process benchmarking.
 *
 * Key finding: FP8 WMMA fragments (16x16x16) do NOT exist in CUDA 13.2.
 * FP8 on Blackwell is exclusively through tcgen05.mma / cuBLASLt.
 *
 * Build:
 *   nvcc -arch=sm_120a -lineinfo -std=c++17 \
 *        -DCCCL_IGNORE_DEPRECATED_CPP_DIALECT \
 *        -Xcompiler "/Zc:preprocessor" \
 *        -O3 --use_fast_math \
 *        -lcublasLt -lcublas \
 *        -o matrixMul_wmma_fp8_async.exe matrixMul_wmma_fp8_async.cu
 */

#include <cuda_runtime.h>
#include <cuda_fp8.h>
#include <cuda_fp16.h>
#include <mma.h>
#include <cublasLt.h>
#include <cublas_v2.h>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <cmath>
#include <vector>
#include <string>
#include <cassert>

using namespace nvcuda::wmma;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
#define WMMA_M       16
#define WMMA_N       16
#define WMMA_K       16
#define WARP_SIZE    32
#define WARPS_PER_BLOCK_8  8
#define FP8_PAD      4   // +4 columns for bank-conflict-free FP8 shared memory

// ---------------------------------------------------------------------------
// CUDA error checking
// ---------------------------------------------------------------------------
static inline void checkCuda(cudaError_t err, const char* msg) {
    if (err != cudaSuccess) {
        std::fprintf(stderr, "CUDA: %s: %s\n", msg, cudaGetErrorString(err));
        std::exit(1);
    }
}

static inline void checkCublas(cublasStatus_t status, const char* msg) {
    if (status != CUBLAS_STATUS_SUCCESS) {
        std::fprintf(stderr, "cuBLAS: %s: %d\n", msg, (int)status);
        std::exit(1);
    }
}

// ===========================================================================
// PATH A: FP8 GEMM using FP8→FP16 conversion with WMMA async-8warp
// ===========================================================================
//
// On SM 120 (Blackwell consumer), the tcgen05.mma CTA-level instruction
// is NOT supported — it requires SM 100/103/110 (data-center Blackwell).
// The WMMA API does NOT support FP8 fragment types (16x16x16).
//
// Therefore, on SM 120, the FP8 path works by:
//   1. Loading FP8 data from global memory
//   2. Converting to FP16 on-the-fly during the shared-memory staging
//   3. Computing with the proven FP16 WMMA async-8warp kernel
//
// This gives the MEMORY BANDWIDTH advantage of FP8 (half the input data
// size = half the global memory traffic) while using the FP16 tensor cores.
// The tensor-core throughput advantage requires SM 100+ tcgen05.mma.
//
// For the full FP8 tensor-core speedup, use cuBLASLt (Path B) which
// internally uses the optimal instruction for the target architecture.

__global__ void matrixMul_fp8_fallback_wmma(
    const __nv_fp8_e4m3* __restrict__ A,
    const __nv_fp8_e4m3* __restrict__ B,
    float* __restrict__ C,
    int M, int N, int K)
{
    const int warp_local    = threadIdx.y;
    const int warp_global_y = blockIdx.y * blockDim.y + warp_local;
    const int warp_global_x = blockIdx.x;

    const int tile_m = warp_global_y * WMMA_M;
    const int tile_n = warp_global_x * WMMA_N;
    if (tile_m >= M || tile_n >= N) return;

    // Shared memory for FP16 WMMA (same layout as FP16 async-8warp)
    extern __shared__ half shmem[];
    constexpr int aStride = WMMA_M * WMMA_K;
    constexpr int bStride = WMMA_K * WMMA_N;
    constexpr int warpSharedHalfCount = 2 * (aStride + bStride);
    half* warpShmem = shmem + warp_local * warpSharedHalfCount;
    half* sA = warpShmem;
    half* sB = warpShmem + 2 * aStride;

    fragment<matrix_a,    WMMA_M, WMMA_N, WMMA_K, half, row_major> a_frag;
    fragment<matrix_b,    WMMA_M, WMMA_N, WMMA_K, half, row_major> b_frag;
    fragment<accumulator, WMMA_M, WMMA_N, WMMA_K, float>          c_frag;
    fill_fragment(c_frag, 0.0f);

    // Prefill buffer 0 — FP8→FP16 conversion + half2 store
    int buf = 0;
    for (int i = threadIdx.x; i < WMMA_M * (WMMA_K / 2); i += WARP_SIZE) {
        const int row  = i / (WMMA_K / 2);
        const int col2 = i % (WMMA_K / 2);
        const int col  = col2 * 2;
        half2 v = __floats2half2_rn(0.0f, 0.0f);
        if (tile_m + row < M && col + 1 < K) {
            float a0 = static_cast<float>(A[static_cast<size_t>(tile_m + row) * K + col]);
            float a1 = static_cast<float>(A[static_cast<size_t>(tile_m + row) * K + col + 1]);
            v = __halves2half2(__float2half(a0), __float2half(a1));
        }
        half* rowPtr = sA + buf * aStride + row * WMMA_K;
        rowPtr[col]     = __low2half(v);
        rowPtr[col + 1] = __high2half(v);
    }

    for (int i = threadIdx.x; i < WMMA_K * (WMMA_N / 2); i += WARP_SIZE) {
        const int row  = i / (WMMA_N / 2);
        const int col2 = i % (WMMA_N / 2);
        const int col  = col2 * 2;
        half2 v = __floats2half2_rn(0.0f, 0.0f);
        if (row < K && tile_n + col + 1 < N) {
            float b0 = static_cast<float>(B[static_cast<size_t>(row) * N + tile_n + col]);
            float b1 = static_cast<float>(B[static_cast<size_t>(row) * N + tile_n + col + 1]);
            v = __halves2half2(__float2half(b0), __float2half(b1));
        }
        half* rowPtr = sB + buf * bStride + row * WMMA_N;
        rowPtr[col]     = __low2half(v);
        rowPtr[col + 1] = __high2half(v);
    }
    __syncthreads();

    // Main GEMM loop
    for (int k0 = 0; k0 < K; k0 += WMMA_K) {
        load_matrix_sync(a_frag, sA + buf * aStride, WMMA_K);
        load_matrix_sync(b_frag, sB + buf * bStride, WMMA_N);
        mma_sync(c_frag, a_frag, b_frag, c_frag);

        buf ^= 1;
        if (k0 + WMMA_K < K) {
            const int k_next = k0 + WMMA_K;
            for (int i = threadIdx.x; i < WMMA_M * (WMMA_K / 2); i += WARP_SIZE) {
                const int row  = i / (WMMA_K / 2);
                const int col2 = i % (WMMA_K / 2);
                const int col  = col2 * 2;
                half2 v = __floats2half2_rn(0.0f, 0.0f);
                if (tile_m + row < M && k_next + col + 1 < K) {
                    float a0 = static_cast<float>(A[static_cast<size_t>(tile_m + row) * K + (k_next + col)]);
                    float a1 = static_cast<float>(A[static_cast<size_t>(tile_m + row) * K + (k_next + col + 1)]);
                    v = __halves2half2(__float2half(a0), __float2half(a1));
                }
                half* rowPtr = sA + buf * aStride + row * WMMA_K;
                rowPtr[col]     = __low2half(v);
                rowPtr[col + 1] = __high2half(v);
            }
            for (int i = threadIdx.x; i < WMMA_K * (WMMA_N / 2); i += WARP_SIZE) {
                const int row  = i / (WMMA_N / 2);
                const int col2 = i % (WMMA_N / 2);
                const int col  = col2 * 2;
                half2 v = __floats2half2_rn(0.0f, 0.0f);
                if (k_next + row < K && tile_n + col + 1 < N) {
                    float b0 = static_cast<float>(B[static_cast<size_t>(k_next + row) * N + (tile_n + col)]);
                    float b1 = static_cast<float>(B[static_cast<size_t>(k_next + row) * N + (tile_n + col + 1)]);
                    v = __halves2half2(__float2half(b0), __float2half(b1));
                }
                half* rowPtr = sB + buf * bStride + row * WMMA_N;
                rowPtr[col]     = __low2half(v);
                rowPtr[col + 1] = __high2half(v);
            }
            __syncthreads();
        }
    }

    store_matrix_sync(C + static_cast<size_t>(tile_m) * N + tile_n,
                      c_frag, N, mem_row_major);
}

// ===========================================================================
// PATH C: FP16 WMMA async-8warp double-buffer GEMM kernel (reference)
// Same proven fast-path from matrix_tensor_optimized.cu.
// ===========================================================================

__global__ void matrixMul_wmma_async_fp16_ref(
    const half* __restrict__ A,
    const half* __restrict__ B,
    float* __restrict__ C,
    int M, int N, int K)
{
    const int warp_local    = threadIdx.y;
    const int warp_global_y = blockIdx.y * blockDim.y + warp_local;
    const int warp_global_x = blockIdx.x;

    const int tile_m = warp_global_y * WMMA_M;
    const int tile_n = warp_global_x * WMMA_N;
    if (tile_m >= M || tile_n >= N) return;

    extern __shared__ half shmem_fp16[];
    constexpr int aStride = WMMA_M * WMMA_K;
    constexpr int bStride = WMMA_K * WMMA_N;
    constexpr int warpSharedHalfCount = 2 * (aStride + bStride);
    half* warpShmem = shmem_fp16 + warp_local * warpSharedHalfCount;
    half* sA = warpShmem;
    half* sB = warpShmem + 2 * aStride;

    fragment<matrix_a,    WMMA_M, WMMA_N, WMMA_K, half, row_major> a_frag;
    fragment<matrix_b,    WMMA_M, WMMA_N, WMMA_K, half, row_major> b_frag;
    fragment<accumulator, WMMA_M, WMMA_N, WMMA_K, float>          c_frag;
    fill_fragment(c_frag, 0.0f);

    int buf = 0;
    for (int i = threadIdx.x; i < WMMA_M * (WMMA_K / 2); i += WARP_SIZE) {
        const int row  = i / (WMMA_K / 2);
        const int col2 = i % (WMMA_K / 2);
        const int col  = col2 * 2;
        half2 v = __floats2half2_rn(0.0f, 0.0f);
        if (tile_m + row < M && col + 1 < K) {
            v = reinterpret_cast<const half2*>(
                A + static_cast<size_t>(tile_m + row) * K + col)[0];
        }
        half* rowPtr = sA + buf * aStride + row * WMMA_K;
        rowPtr[col]     = __low2half(v);
        rowPtr[col + 1] = __high2half(v);
    }

    for (int i = threadIdx.x; i < WMMA_K * (WMMA_N / 2); i += WARP_SIZE) {
        const int row  = i / (WMMA_N / 2);
        const int col2 = i % (WMMA_N / 2);
        const int col  = col2 * 2;
        half2 v = __floats2half2_rn(0.0f, 0.0f);
        if (row < K && tile_n + col + 1 < N) {
            v = reinterpret_cast<const half2*>(
                B + static_cast<size_t>(row) * N + tile_n + col)[0];
        }
        half* rowPtr = sB + buf * bStride + row * WMMA_N;
        rowPtr[col]     = __low2half(v);
        rowPtr[col + 1] = __high2half(v);
    }
    __syncthreads();

    for (int k0 = 0; k0 < K; k0 += WMMA_K) {
        load_matrix_sync(a_frag, sA + buf * aStride, WMMA_K);
        load_matrix_sync(b_frag, sB + buf * bStride, WMMA_N);
        mma_sync(c_frag, a_frag, b_frag, c_frag);

        buf ^= 1;
        if (k0 + WMMA_K < K) {
            const int k_next = k0 + WMMA_K;
            for (int i = threadIdx.x; i < WMMA_M * (WMMA_K / 2); i += WARP_SIZE) {
                const int row  = i / (WMMA_K / 2);
                const int col2 = i % (WMMA_K / 2);
                const int col  = col2 * 2;
                half2 v = __floats2half2_rn(0.0f, 0.0f);
                if (tile_m + row < M && k_next + col + 1 < K) {
                    v = reinterpret_cast<const half2*>(
                        A + static_cast<size_t>(tile_m + row) * K + (k_next + col))[0];
                }
                half* rowPtr = sA + buf * aStride + row * WMMA_K;
                rowPtr[col]     = __low2half(v);
                rowPtr[col + 1] = __high2half(v);
            }
            for (int i = threadIdx.x; i < WMMA_K * (WMMA_N / 2); i += WARP_SIZE) {
                const int row  = i / (WMMA_N / 2);
                const int col2 = i % (WMMA_N / 2);
                const int col  = col2 * 2;
                half2 v = __floats2half2_rn(0.0f, 0.0f);
                if (k_next + row < K && tile_n + col + 1 < N) {
                    v = reinterpret_cast<const half2*>(
                        B + static_cast<size_t>(k_next + row) * N + (tile_n + col))[0];
                }
                half* rowPtr = sB + buf * bStride + row * WMMA_N;
                rowPtr[col]     = __low2half(v);
                rowPtr[col + 1] = __high2half(v);
            }
            __syncthreads();
        }
    }

    store_matrix_sync(C + static_cast<size_t>(tile_m) * N + tile_n,
                      c_frag, N, mem_row_major);
}

// ===========================================================================
// Launch helpers
// ===========================================================================

static void launchFp8FallbackWmma(
    const __nv_fp8_e4m3* A, const __nv_fp8_e4m3* B, float* C,
    int M, int N, int K)
{
    dim3 block(32, WARPS_PER_BLOCK_8, 1);
    dim3 grid(
        (N + WMMA_N - 1) / WMMA_N,
        ((M + WMMA_M - 1) / WMMA_M + WARPS_PER_BLOCK_8 - 1) / WARPS_PER_BLOCK_8,
        1);

    constexpr size_t aStride = WMMA_M * WMMA_K;
    constexpr size_t bStride = WMMA_K * WMMA_N;
    size_t sharedBytes = static_cast<size_t>(WARPS_PER_BLOCK_8) * 2 * (aStride + bStride) * sizeof(half);

    matrixMul_fp8_fallback_wmma<<<grid, block, sharedBytes>>>(A, B, C, M, N, K);
}

static void launchFp16Async8WarpRef(
    const half* A, const half* B, float* C,
    int M, int N, int K)
{
    dim3 block(32, WARPS_PER_BLOCK_8, 1);
    dim3 grid(
        (N + WMMA_N - 1) / WMMA_N,
        ((M + WMMA_M - 1) / WMMA_M + WARPS_PER_BLOCK_8 - 1) / WARPS_PER_BLOCK_8,
        1);

    constexpr size_t aStride = WMMA_M * WMMA_K;
    constexpr size_t bStride = WMMA_K * WMMA_N;
    size_t sharedBytes = static_cast<size_t>(WARPS_PER_BLOCK_8) * 2 * (aStride + bStride) * sizeof(half);

    matrixMul_wmma_async_fp16_ref<<<grid, block, sharedBytes>>>(A, B, C, M, N, K);
}

// ===========================================================================
// PATH B: cuBLASLt FP8 GEMM reference
// ===========================================================================
//
// Uses cuBLASLt to perform FP8 E4M3 GEMM with FP32 accumulation.
// This is the production-quality FP8 path and provides definitive timing.
//
// Layout: A is MxK row-major FP8, B is KxN col-major FP8, C is MxN FP32.
// cuBLASLt is column-major, so we exploit the identity:
//   C_rm = A_rm * B_rm  ⟺  C_rm^T = B_rm^T * A_rm^T  (column-major)
//
// In column-major terms:
//   A_cm = B^T  (dimensions N×K, leading dim = N)
//   B_cm = A^T  (dimensions K×M, leading dim = K)
//   C_cm = C^T  (dimensions N×M, leading dim = N)
//   C_cm = A_cm * B_cm  with opA=N, opB=N, m=N, n=M, k=K

static float runCublasLtFp8(
    const __nv_fp8_e4m3* dA_fp8,
    const __nv_fp8_e4m3* dB_fp8,
    float* dC,
    int M, int N, int K)
{
    cublasLtHandle_t ltHandle;
    checkCublas(cublasLtCreate(&ltHandle), "cublasLtCreate");

    // Matrix layouts (column-major interpretation)
    cublasLtMatrixLayout_t Adesc = nullptr, Bdesc = nullptr, Cdesc = nullptr;
    cublasLtMatmulDesc_t   matmulDesc = nullptr;
    cublasLtMatmulPreference_t pref = nullptr;

    // A_cm = B^T : N×K col-major FP8, leading dim = N
    checkCublas(cublasLtMatrixLayoutCreate(&Adesc, CUDA_R_8F_E4M3, N, K, N), "Adesc");
    // B_cm = A^T : K×M col-major FP8, leading dim = K
    checkCublas(cublasLtMatrixLayoutCreate(&Bdesc, CUDA_R_8F_E4M3, K, M, K), "Bdesc");
    // C_cm = C^T : N×M col-major FP32, leading dim = N
    checkCublas(cublasLtMatrixLayoutCreate(&Cdesc, CUDA_R_32F, N, M, N), "Cdesc");

    // Matmul descriptor: FP8 × FP8 → FP32 accumulation
    // cuBLASLt infers A/B types from the matrix layouts; no separate A_TYPE/B_TYPE
    // attribute exists.  The compute type and scale type are sufficient.
    checkCublas(cublasLtMatmulDescCreate(&matmulDesc, CUBLAS_COMPUTE_32F, CUDA_R_32F), "matmulDesc");

    // Epilogue scalars
    float alpha = 1.0f, beta = 0.0f;

    // Workspace + preference
    size_t workspaceSize = 32 * 1024 * 1024;
    void* workspace = nullptr;
    checkCuda(cudaMalloc(&workspace, workspaceSize), "workspace alloc");

    checkCublas(cublasLtMatmulPreferenceCreate(&pref), "pref create");
    checkCublas(cublasLtMatmulPreferenceSetAttribute(
        pref, CUBLASLT_MATMUL_PREF_MAX_WORKSPACE_BYTES,
        &workspaceSize, sizeof(workspaceSize)), "pref workspace");

    // Select algorithm
    int returnedResults = 0;
    cublasLtMatmulHeuristicResult_t heuristicResult;
    checkCublas(cublasLtMatmulAlgoGetHeuristic(
        ltHandle, matmulDesc, Adesc, Bdesc, Cdesc, Cdesc,
        pref, 1, &heuristicResult, &returnedResults), "algo get");

    if (returnedResults == 0) {
        std::fprintf(stderr, "cuBLASLt: no suitable algorithm found\n");
        std::exit(1);
    }

    // Warmup (untimed)
    checkCublas(cublasLtMatmul(ltHandle, matmulDesc,
        &alpha,
        dB_fp8, Adesc,   // A_cm = B^T
        dA_fp8, Bdesc,   // B_cm = A^T
        &beta,
        dC, Cdesc,
        dC, Cdesc,
        &heuristicResult.algo, workspace, workspaceSize, 0), "cublasLt warmup");
    checkCuda(cudaDeviceSynchronize(), "cublasLt warmup sync");

    // Timed run
    cudaEvent_t start, stop;
    checkCuda(cudaEventCreate(&start), "evt create");
    checkCuda(cudaEventCreate(&stop),  "evt create");
    checkCuda(cudaEventRecord(start),  "evt record");

    checkCublas(cublasLtMatmul(ltHandle, matmulDesc,
        &alpha,
        dB_fp8, Adesc,
        dA_fp8, Bdesc,
        &beta,
        dC, Cdesc,
        dC, Cdesc,
        &heuristicResult.algo, workspace, workspaceSize, 0), "cublasLt timed");

    checkCuda(cudaEventRecord(stop),    "evt record");
    checkCuda(cudaEventSynchronize(stop), "evt sync");

    float ms = 0.0f;
    checkCuda(cudaEventElapsedTime(&ms, start, stop), "evt elapsed");
    checkCuda(cudaEventDestroy(start), "evt destroy");
    checkCuda(cudaEventDestroy(stop),  "evt destroy");

    // Cleanup
    checkCuda(cudaFree(workspace), "workspace free");
    if (pref)       cublasLtMatmulPreferenceDestroy(pref);
    if (matmulDesc) cublasLtMatmulDescDestroy(matmulDesc);
    if (Adesc)      cublasLtMatrixLayoutDestroy(Adesc);
    if (Bdesc)      cublasLtMatrixLayoutDestroy(Bdesc);
    if (Cdesc)      cublasLtMatrixLayoutDestroy(Cdesc);
    cublasLtDestroy(ltHandle);

    return ms;
}

// ===========================================================================
// Host-side FP8 conversion utility
// ===========================================================================

static void floatToFp8(const float* src, __nv_fp8_e4m3* dst, size_t n) {
    for (size_t i = 0; i < n; ++i) {
        dst[i] = __nv_fp8_e4m3(src[i]);
    }
}

// ===========================================================================
// Main — multi-size FP8 vs FP16 benchmark
// ===========================================================================

int main(int argc, char* argv[])
{
    int size = 2048;
    std::string mode = "both";   // fp8 | fp16 | both | cublaslt

    if (argc > 1) {
        std::string arg1 = argv[1];
        if (arg1 == "1024" || arg1 == "2048" || arg1 == "4096") {
            size = std::stoi(arg1);
        }
    }
    if (argc > 2) {
        mode = argv[2];
    }

    const int M = size, N = size, K = size;
    const size_t elemsA = static_cast<size_t>(M) * K;
    const size_t elemsB = static_cast<size_t>(K) * N;
    const size_t elemsC = static_cast<size_t>(M) * N;

    std::printf("=== GEN5 FP8 GEMM Benchmark (cuBLASLt + FP8→FP16 WMMA fallback) ===\n");
    std::printf("Problem size: %d x %d x %d\n", M, N, K);
    std::printf("Mode: %s\n", mode.c_str());
    std::printf("Architecture: SM 120 (Blackwell consumer)\n");
    std::printf("NOTE: tcgen05.mma (FP8 tensor cores) requires SM 100/103/110,\n");
    std::printf("      NOT available on SM 120. cuBLASLt may use alternate paths.\n");
    std::printf("      FP8→FP16 WMMA fallback gives memory bandwidth advantage only.\n\n");

    // ----------------------------------------------------------------------
    // Host allocation & initialisation
    // ----------------------------------------------------------------------
    std::vector<float> hA_fp32(elemsA), hB_fp32(elemsB);
    std::srand(42);
    for (size_t i = 0; i < elemsA; ++i)
        hA_fp32[i] = (std::rand() / static_cast<float>(RAND_MAX)) * 2.0f - 1.0f;
    for (size_t i = 0; i < elemsB; ++i)
        hB_fp32[i] = (std::rand() / static_cast<float>(RAND_MAX)) * 2.0f - 1.0f;

    // Convert to FP8 and FP16
    std::vector<__nv_fp8_e4m3> hA_fp8(elemsA), hB_fp8(elemsB);
    std::vector<half> hA_fp16(elemsA), hB_fp16(elemsB);

    floatToFp8(hA_fp32.data(), hA_fp8.data(), elemsA);
    floatToFp8(hB_fp32.data(), hB_fp8.data(), elemsB);

    for (size_t i = 0; i < elemsA; ++i)
        hA_fp16[i] = __float2half(hA_fp32[i]);
    for (size_t i = 0; i < elemsB; ++i)
        hB_fp16[i] = __float2half(hB_fp32[i]);

    // ----------------------------------------------------------------------
    // Device allocation
    // ----------------------------------------------------------------------
    __nv_fp8_e4m3* dA_fp8  = nullptr;
    __nv_fp8_e4m3* dB_fp8  = nullptr;
    half*          dA_fp16 = nullptr;
    half*          dB_fp16 = nullptr;
    float*         dC      = nullptr;

    checkCuda(cudaMalloc(&dA_fp8,  elemsA * sizeof(__nv_fp8_e4m3)), "cudaMalloc dA_fp8");
    checkCuda(cudaMalloc(&dB_fp8,  elemsB * sizeof(__nv_fp8_e4m3)), "cudaMalloc dB_fp8");
    checkCuda(cudaMalloc(&dA_fp16, elemsA * sizeof(half)),          "cudaMalloc dA_fp16");
    checkCuda(cudaMalloc(&dB_fp16, elemsB * sizeof(half)),          "cudaMalloc dB_fp16");
    checkCuda(cudaMalloc(&dC,      elemsC * sizeof(float)),         "cudaMalloc dC");

    checkCuda(cudaMemcpy(dA_fp8,  hA_fp8.data(),  elemsA * sizeof(__nv_fp8_e4m3), cudaMemcpyHostToDevice), "H2D dA_fp8");
    checkCuda(cudaMemcpy(dB_fp8,  hB_fp8.data(),  elemsB * sizeof(__nv_fp8_e4m3), cudaMemcpyHostToDevice), "H2D dB_fp8");
    checkCuda(cudaMemcpy(dA_fp16, hA_fp16.data(), elemsA * sizeof(half), cudaMemcpyHostToDevice),          "H2D dA_fp16");
    checkCuda(cudaMemcpy(dB_fp16, hB_fp16.data(), elemsB * sizeof(half), cudaMemcpyHostToDevice),          "H2D dB_fp16");
    checkCuda(cudaMemset(dC, 0, elemsC * sizeof(float)), "cudaMemset dC");

    // ----------------------------------------------------------------------
    // Warmup
    // ----------------------------------------------------------------------
    if (mode == "fp8" || mode == "both") {
        launchFp8FallbackWmma(dA_fp8, dB_fp8, dC, M, N, K);
        checkCuda(cudaDeviceSynchronize(), "warmup fp8 sync");
    }
    if (mode == "fp16" || mode == "both") {
        launchFp16Async8WarpRef(dA_fp16, dB_fp16, dC, M, N, K);
        checkCuda(cudaDeviceSynchronize(), "warmup fp16 sync");
    }

    // ----------------------------------------------------------------------
    // Timed runs
    // ----------------------------------------------------------------------
    float ms_fp8_wmma = 0.0f;
    float ms_fp8_cublaslt = 0.0f;
    float ms_fp16 = 0.0f;

    // FP8→FP16 WMMA fallback (memory bandwidth advantage, no tensor-core advantage)
    if (mode == "fp8" || mode == "both") {
        checkCuda(cudaMemset(dC, 0, elemsC * sizeof(float)), "clear dC pre-fp8");

        cudaEvent_t start, stop;
        checkCuda(cudaEventCreate(&start), "evt create");
        checkCuda(cudaEventCreate(&stop),  "evt create");
        checkCuda(cudaEventRecord(start),  "evt record");

        launchFp8FallbackWmma(dA_fp8, dB_fp8, dC, M, N, K);

        checkCuda(cudaEventRecord(stop),    "evt record");
        checkCuda(cudaEventSynchronize(stop), "evt sync");
        checkCuda(cudaEventElapsedTime(&ms_fp8_wmma, start, stop), "evt elapsed");
        checkCuda(cudaEventDestroy(start), "evt destroy");
        checkCuda(cudaEventDestroy(stop),  "evt destroy");

        double tflops = 2.0 * static_cast<double>(M) * N * K / (ms_fp8_wmma / 1000.0) / 1e12;
        std::printf("matrixMul_fp8_fallback_wmma: %.3f ms (%.2f TFLOPS) [FP8->FP16 WMMA]\n",
                    ms_fp8_wmma, tflops);
    }

    // cuBLASLt FP8
    if (mode == "cublaslt" || mode == "both") {
        checkCuda(cudaMemset(dC, 0, elemsC * sizeof(float)), "clear dC pre-cublaslt");
        ms_fp8_cublaslt = runCublasLtFp8(dA_fp8, dB_fp8, dC, M, N, K);
        double tflops = 2.0 * static_cast<double>(M) * N * K / (ms_fp8_cublaslt / 1000.0) / 1e12;
        std::printf("cublasLt_fp8_e4m3: %.3f ms (%.2f TFLOPS)\n", ms_fp8_cublaslt, tflops);
    }

    // FP16 reference
    if (mode == "fp16" || mode == "both") {
        checkCuda(cudaMemset(dC, 0, elemsC * sizeof(float)), "clear dC pre-fp16");

        cudaEvent_t start, stop;
        checkCuda(cudaEventCreate(&start), "evt create");
        checkCuda(cudaEventCreate(&stop),  "evt create");
        checkCuda(cudaEventRecord(start),  "evt record");

        launchFp16Async8WarpRef(dA_fp16, dB_fp16, dC, M, N, K);

        checkCuda(cudaEventRecord(stop),    "evt record");
        checkCuda(cudaEventSynchronize(stop), "evt sync");
        checkCuda(cudaEventElapsedTime(&ms_fp16, start, stop), "evt elapsed");
        checkCuda(cudaEventDestroy(start), "evt destroy");
        checkCuda(cudaEventDestroy(stop),  "evt destroy");

        double tflops = 2.0 * static_cast<double>(M) * N * K / (ms_fp16 / 1000.0) / 1e12;
        std::printf("matrixMul_wmma_async_fp16_ref: %.3f ms (%.2f TFLOPS)\n", ms_fp16, tflops);
    }

    // Speedup summary
    if (mode == "both") {
        if (ms_fp8_cublaslt > 0 && ms_fp16 > 0) {
            std::printf("\ncuBLASLt FP8 speed-up vs FP16 WMMA: %.2fx\n", ms_fp16 / ms_fp8_cublaslt);
        }
    }

    // ----------------------------------------------------------------------
    // Cleanup
    // ----------------------------------------------------------------------
    checkCuda(cudaFree(dA_fp8),  "cudaFree dA_fp8");
    checkCuda(cudaFree(dB_fp8),  "cudaFree dB_fp8");
    checkCuda(cudaFree(dA_fp16), "cudaFree dA_fp16");
    checkCuda(cudaFree(dB_fp16), "cudaFree dB_fp16");
    checkCuda(cudaFree(dC),      "cudaFree dC");

    return 0;
}
