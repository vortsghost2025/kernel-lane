/*
 * GEMM Correctness Test Suite for Kernel Lane
 *
 * Validates numerical accuracy of all WMMA GEMM kernels against
 * a CPU reference implementation. Tests multiple problem sizes
 * and checks relative error tolerances appropriate for each
 * data type (FP16 WMMA, FP8 fallback WMMA, cuBLASLt FP8).
 *
 * Build:
 *   nvcc -arch=sm_120 -lineinfo -std=c++17 \
 *     -DCCCL_IGNORE_DEPRECATED_CPP_DIALECT \
 *     -Xcompiler "/Zc:preprocessor" \
 *     -O3 --use_fast_math \
 *     -lcublasLt -lcublas \
 *     -o kernels/bin/test_gemm_correctness.exe \
 *     kernels/tests/test_gemm_correctness.cu
 *
 * Run:
 *   ./kernels/bin/test_gemm_correctness.exe [size]
 *   Default size: 256 (fast sanity), use 1024 for full validation
 */

#include <cuda_runtime.h>
#include <cuda_fp16.h>
#include <cuda_fp8.h>
#include <mma.h>
#include <cublasLt.h>
#include <cublas_v2.h>
#include <cstdio>
#include <cstdlib>
#include <cmath>
#include <cstring>
#include <vector>
#include <string>
#include <algorithm>

using namespace nvcuda::wmma;

#define WMMA_M 16
#define WMMA_N 16
#define WMMA_K 16
#define WARP_SIZE 32
#define WARPS_PER_BLOCK_4 4
#define WARPS_PER_BLOCK_8 8

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

// ---------------------------------------------------------------------------
// CPU reference GEMM: C = A * B, row-major, FP32 accumulation
// ---------------------------------------------------------------------------
static void cpu_gemm_f32(const float* A, const float* B, float* C,
                         int M, int N, int K) {
    for (int i = 0; i < M; ++i) {
        for (int j = 0; j < N; ++j) {
            float sum = 0.0f;
            for (int k = 0; k < K; ++k) {
                sum += A[i * K + k] * B[k * N + j];
            }
            C[i * N + j] = sum;
        }
    }
}

// ---------------------------------------------------------------------------
// Error metrics
// ---------------------------------------------------------------------------
struct ErrorMetrics {
    float max_rel_err;
    float avg_rel_err;
    int   outliers;
    int   total;
};

static ErrorMetrics compute_error(const float* computed, const float* reference,
                                  int count, float tol, bool is_fp16_vs_fp32 = true) {
    ErrorMetrics m = {0, 0, 0, count};
    double sum_rel = 0.0;
    int skipped = 0;
    for (int i = 0; i < count; ++i) {
        float ref = reference[i];
        float cmp = computed[i];
        float abs_err = std::fabs(cmp - ref);
        float denom = std::fabs(ref);
        // For FP16-vs-FP32 comparison: use max(|ref|,|cmp|) as denominator
        // to avoid division by near-zero. FP16 rounding can produce
        // small values where FP32 was ~zero, causing huge relative errors.
        if (is_fp16_vs_fp32) {
            denom = std::fmax(denom, std::fabs(cmp));
            denom = std::fmax(denom, 1e-3f);  // absolute floor for near-zero
        }
        float rel = (denom > 1e-6f) ? abs_err / denom : abs_err;
        if (rel > m.max_rel_err) m.max_rel_err = rel;
        sum_rel += rel;
        if (rel > tol) m.outliers++;
    }
    m.avg_rel_err = static_cast<float>(sum_rel / count);
    return m;
}

// ---------------------------------------------------------------------------
// GPU kernel declarations (copied from matrix_tensor_optimized.cu)
// These must match the kernel signatures exactly.
// ---------------------------------------------------------------------------

__global__ void wmma_baseline(const half* A, const half* B, float* C,
                               int M, int N, int K) {
    int warp_global = (blockIdx.x * blockDim.x + threadIdx.x) / WARP_SIZE;
    int warps_per_row = (N + WMMA_N - 1) / WMMA_N;
    int warp_x = warp_global % warps_per_row;
    int warp_y = warp_global / warps_per_row;
    if (warp_y * WMMA_M >= M || warp_x * WMMA_N >= N) return;

    fragment<matrix_a, WMMA_M, WMMA_N, WMMA_K, half, row_major> a_frag;
    fragment<matrix_b, WMMA_M, WMMA_N, WMMA_K, half, row_major> b_frag;
    fragment<accumulator, WMMA_M, WMMA_N, WMMA_K, float> c_frag;
    fill_fragment(c_frag, 0.0f);

    const int a_row = warp_y * WMMA_M;
    const int b_col = warp_x * WMMA_N;
    for (int k0 = 0; k0 < K; k0 += WMMA_K) {
        if (a_row < M && k0 + WMMA_K <= K)
            load_matrix_sync(a_frag, A + a_row * K + k0, K);
        if (b_col < N && k0 + WMMA_K <= K)
            load_matrix_sync(b_frag, B + k0 * N + b_col, N);
        mma_sync(c_frag, a_frag, b_frag, c_frag);
    }
    if (a_row < M && b_col < N)
        store_matrix_sync(C + a_row * N + b_col, c_frag, N, mem_row_major);
}

__global__ void wmma_4warp_padded(const half* A, const half* B, float* C,
                                   int M, int N, int K) {
    const int warp_local = threadIdx.y;
    const int warp_global_y = blockIdx.y * blockDim.y + warp_local;
    const int warp_global_x = blockIdx.x;
    const int tile_m = warp_global_y * WMMA_M;
    const int tile_n = warp_global_x * WMMA_N;
    if (tile_m >= M || tile_n >= N) return;

    fragment<matrix_a, WMMA_M, WMMA_N, WMMA_K, half, row_major> a_frag;
    fragment<matrix_b, WMMA_M, WMMA_N, WMMA_K, half, row_major> b_frag;
    fragment<accumulator, WMMA_M, WMMA_N, WMMA_K, float> c_frag;
    fill_fragment(c_frag, 0.0f);

    for (int k0 = 0; k0 < K; k0 += WMMA_K * 4) {
        #pragma unroll
        for (int step = 0; step < 4; ++step) {
            const int kk = k0 + step * WMMA_K;
            if (kk < K) {
                load_matrix_sync(a_frag, A + tile_m * K + kk, K);
                load_matrix_sync(b_frag, B + kk * N + tile_n, N);
                mma_sync(c_frag, a_frag, b_frag, c_frag);
            }
        }
    }
    store_matrix_sync(C + tile_m * N + tile_n, c_frag, N, mem_row_major);
}

__global__ void wmma_async_8warp(const half* A, const half* B, float* C,
                                  int M, int N, int K) {
    const int warp_local = threadIdx.y;
    const int warp_global_y = blockIdx.y * blockDim.y + warp_local;
    const int warp_global_x = blockIdx.x;
    const int tile_m = warp_global_y * WMMA_M;
    const int tile_n = warp_global_x * WMMA_N;
    if (tile_m >= M || tile_n >= N) return;

    extern __shared__ half shmem[];
    constexpr int aStride = WMMA_M * WMMA_K;
    constexpr int bStride = WMMA_K * WMMA_N;
    constexpr int warpSharedHalfCount = 2 * (aStride + bStride);
    half* warpShmem = shmem + warp_local * warpSharedHalfCount;
    half* sA = warpShmem;
    half* sB = warpShmem + 2 * aStride;

    fragment<matrix_a, WMMA_M, WMMA_N, WMMA_K, half, row_major> a_frag;
    fragment<matrix_b, WMMA_M, WMMA_N, WMMA_K, half, row_major> b_frag;
    fragment<accumulator, WMMA_M, WMMA_N, WMMA_K, float> c_frag;
    fill_fragment(c_frag, 0.0f);

    int buf = 0;
    for (int i = threadIdx.x; i < WMMA_M * (WMMA_K / 2); i += 32) {
        const int row = i / (WMMA_K / 2);
        const int col2 = i % (WMMA_K / 2);
        const int col = col2 * 2;
        half2 v = __floats2half2_rn(0.0f, 0.0f);
        if (tile_m + row < M && col + 1 < K)
            v = reinterpret_cast<const half2*>(A + (tile_m + row) * K + col)[0];
        half* rowPtr = sA + buf * aStride + row * WMMA_K;
        rowPtr[col] = __low2half(v);
        rowPtr[col + 1] = __high2half(v);
    }
    for (int i = threadIdx.x; i < WMMA_K * (WMMA_N / 2); i += 32) {
        const int row = i / (WMMA_N / 2);
        const int col2 = i % (WMMA_N / 2);
        const int col = col2 * 2;
        half2 v = __floats2half2_rn(0.0f, 0.0f);
        if (row < K && tile_n + col + 1 < N)
            v = reinterpret_cast<const half2*>(B + row * N + tile_n + col)[0];
        half* rowPtr = sB + buf * bStride + row * WMMA_N;
        rowPtr[col] = __low2half(v);
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
            for (int i = threadIdx.x; i < WMMA_M * (WMMA_K / 2); i += 32) {
                const int row = i / (WMMA_K / 2);
                const int col2 = i % (WMMA_K / 2);
                const int col = col2 * 2;
                half2 v = __floats2half2_rn(0.0f, 0.0f);
                if (tile_m + row < M && col + k_next + 1 < K)
                    v = reinterpret_cast<const half2*>(A + (tile_m + row) * K + (col + k_next))[0];
                half* rowPtr = sA + buf * aStride + row * WMMA_K;
                rowPtr[col] = __low2half(v);
                rowPtr[col + 1] = __high2half(v);
            }
            for (int i = threadIdx.x; i < WMMA_K * (WMMA_N / 2); i += 32) {
                const int row = i / (WMMA_N / 2);
                const int col2 = i % (WMMA_N / 2);
                const int col = col2 * 2;
                half2 v = __floats2half2_rn(0.0f, 0.0f);
                if (row + k_next < K && tile_n + col + 1 < N)
                    v = reinterpret_cast<const half2*>(B + (row + k_next) * N + (tile_n + col))[0];
                half* rowPtr = sB + buf * bStride + row * WMMA_N;
                rowPtr[col] = __low2half(v);
                rowPtr[col + 1] = __high2half(v);
            }
            __syncthreads();
        }
    }
    store_matrix_sync(C + tile_m * N + tile_n, c_frag, N, mem_row_major);
}

// FP8→FP16 fallback kernel (same as matrixMul_fp8_fallback_wmma)
__global__ void fp8_fallback_wmma(const __nv_fp8_e4m3* A, const __nv_fp8_e4m3* B,
                                   float* C, int M, int N, int K) {
    const int warp_local = threadIdx.y;
    const int warp_global_y = blockIdx.y * blockDim.y + warp_local;
    const int warp_global_x = blockIdx.x;
    const int tile_m = warp_global_y * WMMA_M;
    const int tile_n = warp_global_x * WMMA_N;
    if (tile_m >= M || tile_n >= N) return;

    extern __shared__ half shmem[];
    constexpr int aStride = WMMA_M * WMMA_K;
    constexpr int bStride = WMMA_K * WMMA_N;
    constexpr int warpSharedHalfCount = 2 * (aStride + bStride);
    half* warpShmem = shmem + warp_local * warpSharedHalfCount;
    half* sA = warpShmem;
    half* sB = warpShmem + 2 * aStride;

    fragment<matrix_a, WMMA_M, WMMA_N, WMMA_K, half, row_major> a_frag;
    fragment<matrix_b, WMMA_M, WMMA_N, WMMA_K, half, row_major> b_frag;
    fragment<accumulator, WMMA_M, WMMA_N, WMMA_K, float> c_frag;
    fill_fragment(c_frag, 0.0f);

    int buf = 0;
    for (int i = threadIdx.x; i < WMMA_M * (WMMA_K / 2); i += WARP_SIZE) {
        const int row = i / (WMMA_K / 2);
        const int col2 = i % (WMMA_K / 2);
        const int col = col2 * 2;
        half2 v = __floats2half2_rn(0.0f, 0.0f);
        if (tile_m + row < M && col + 1 < K) {
            float a0 = static_cast<float>(A[static_cast<size_t>(tile_m + row) * K + col]);
            float a1 = static_cast<float>(A[static_cast<size_t>(tile_m + row) * K + col + 1]);
            v = __halves2half2(__float2half(a0), __float2half(a1));
        }
        half* rowPtr = sA + buf * aStride + row * WMMA_K;
        rowPtr[col] = __low2half(v);
        rowPtr[col + 1] = __high2half(v);
    }
    for (int i = threadIdx.x; i < WMMA_K * (WMMA_N / 2); i += WARP_SIZE) {
        const int row = i / (WMMA_N / 2);
        const int col2 = i % (WMMA_N / 2);
        const int col = col2 * 2;
        half2 v = __floats2half2_rn(0.0f, 0.0f);
        if (row < K && tile_n + col + 1 < N) {
            float b0 = static_cast<float>(B[static_cast<size_t>(row) * N + tile_n + col]);
            float b1 = static_cast<float>(B[static_cast<size_t>(row) * N + tile_n + col + 1]);
            v = __halves2half2(__float2half(b0), __float2half(b1));
        }
        half* rowPtr = sB + buf * bStride + row * WMMA_N;
        rowPtr[col] = __low2half(v);
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
                const int row = i / (WMMA_K / 2);
                const int col2 = i % (WMMA_K / 2);
                const int col = col2 * 2;
                half2 v = __floats2half2_rn(0.0f, 0.0f);
                if (tile_m + row < M && k_next + col + 1 < K) {
                    float a0 = static_cast<float>(A[static_cast<size_t>(tile_m + row) * K + (k_next + col)]);
                    float a1 = static_cast<float>(A[static_cast<size_t>(tile_m + row) * K + (k_next + col + 1)]);
                    v = __halves2half2(__float2half(a0), __float2half(a1));
                }
                half* rowPtr = sA + buf * aStride + row * WMMA_K;
                rowPtr[col] = __low2half(v);
                rowPtr[col + 1] = __high2half(v);
            }
            for (int i = threadIdx.x; i < WMMA_K * (WMMA_N / 2); i += WARP_SIZE) {
                const int row = i / (WMMA_N / 2);
                const int col2 = i % (WMMA_N / 2);
                const int col = col2 * 2;
                half2 v = __floats2half2_rn(0.0f, 0.0f);
                if (k_next + row < K && tile_n + col + 1 < N) {
                    float b0 = static_cast<float>(B[static_cast<size_t>(k_next + row) * N + (tile_n + col)]);
                    float b1 = static_cast<float>(B[static_cast<size_t>(k_next + row) * N + (tile_n + col + 1)]);
                    v = __halves2half2(__float2half(b0), __float2half(b1));
                }
                half* rowPtr = sB + buf * bStride + row * WMMA_N;
                rowPtr[col] = __low2half(v);
                rowPtr[col + 1] = __high2half(v);
            }
            __syncthreads();
        }
    }
    store_matrix_sync(C + static_cast<size_t>(tile_m) * N + tile_n,
                      c_frag, N, mem_row_major);
}

// ---------------------------------------------------------------------------
// Launch helpers
// ---------------------------------------------------------------------------
static void launchBaseline(const half* A, const half* B, float* C, int M, int N, int K) {
    int warps = ((M + WMMA_M - 1) / WMMA_M) * ((N + WMMA_N - 1) / WMMA_N);
    wmma_baseline<<<warps, 32>>>(A, B, C, M, N, K);
}

static void launch4Warp(const half* A, const half* B, float* C, int M, int N, int K) {
    dim3 block(32, WARPS_PER_BLOCK_4, 1);
    dim3 grid((N + WMMA_N - 1) / WMMA_N,
              ((M + WMMA_M - 1) / WMMA_M + WARPS_PER_BLOCK_4 - 1) / WARPS_PER_BLOCK_4, 1);
    wmma_4warp_padded<<<grid, block>>>(A, B, C, M, N, K);
}

static void launchAsync8Warp(const half* A, const half* B, float* C, int M, int N, int K) {
    dim3 block(32, WARPS_PER_BLOCK_8, 1);
    dim3 grid((N + WMMA_N - 1) / WMMA_N,
              ((M + WMMA_M - 1) / WMMA_M + WARPS_PER_BLOCK_8 - 1) / WARPS_PER_BLOCK_8, 1);
    constexpr size_t aStride = WMMA_M * WMMA_K;
    constexpr size_t bStride = WMMA_K * WMMA_N;
    size_t sharedBytes = static_cast<size_t>(WARPS_PER_BLOCK_8) * 2 * (aStride + bStride) * sizeof(half);
    wmma_async_8warp<<<grid, block, sharedBytes>>>(A, B, C, M, N, K);
}

static void launchFp8Fallback(const __nv_fp8_e4m3* A, const __nv_fp8_e4m3* B,
                               float* C, int M, int N, int K) {
    dim3 block(32, WARPS_PER_BLOCK_8, 1);
    dim3 grid((N + WMMA_N - 1) / WMMA_N,
              ((M + WMMA_M - 1) / WMMA_M + WARPS_PER_BLOCK_8 - 1) / WARPS_PER_BLOCK_8, 1);
    constexpr size_t aStride = WMMA_M * WMMA_K;
    constexpr size_t bStride = WMMA_K * WMMA_N;
    size_t sharedBytes = static_cast<size_t>(WARPS_PER_BLOCK_8) * 2 * (aStride + bStride) * sizeof(half);
    fp8_fallback_wmma<<<grid, block, sharedBytes>>>(A, B, C, M, N, K);
}

// ---------------------------------------------------------------------------
// cuBLASLt FP8 reference
// ---------------------------------------------------------------------------
static void runCublasLtFp8(const __nv_fp8_e4m3* dA_fp8, const __nv_fp8_e4m3* dB_fp8,
                            float* dC, int M, int N, int K) {
    cublasLtHandle_t ltHandle;
    checkCublas(cublasLtCreate(&ltHandle), "cublasLtCreate");

    cublasLtMatrixLayout_t Adesc = nullptr, Bdesc = nullptr, Cdesc = nullptr;
    cublasLtMatmulDesc_t matmulDesc = nullptr;
    cublasLtMatmulPreference_t pref = nullptr;

    checkCublas(cublasLtMatrixLayoutCreate(&Adesc, CUDA_R_8F_E4M3, N, K, N), "Adesc");
    checkCublas(cublasLtMatrixLayoutCreate(&Bdesc, CUDA_R_8F_E4M3, K, M, K), "Bdesc");
    checkCublas(cublasLtMatrixLayoutCreate(&Cdesc, CUDA_R_32F, N, M, N), "Cdesc");
    checkCublas(cublasLtMatmulDescCreate(&matmulDesc, CUBLAS_COMPUTE_32F, CUDA_R_32F), "matmulDesc");

    float alpha = 1.0f, beta = 0.0f;
    size_t workspaceSize = 32 * 1024 * 1024;
    void* workspace = nullptr;
    checkCuda(cudaMalloc(&workspace, workspaceSize), "workspace alloc");

    checkCublas(cublasLtMatmulPreferenceCreate(&pref), "pref create");
    checkCublas(cublasLtMatmulPreferenceSetAttribute(
        pref, CUBLASLT_MATMUL_PREF_MAX_WORKSPACE_BYTES,
        &workspaceSize, sizeof(workspaceSize)), "pref workspace");

    int returnedResults = 0;
    cublasLtMatmulHeuristicResult_t heuristicResult;
    checkCublas(cublasLtMatmulAlgoGetHeuristic(
        ltHandle, matmulDesc, Adesc, Bdesc, Cdesc, Cdesc,
        pref, 1, &heuristicResult, &returnedResults), "algo get");

    if (returnedResults == 0) {
        std::fprintf(stderr, "cuBLASLt: no suitable algorithm found\n");
        std::exit(1);
    }

    checkCublas(cublasLtMatmul(ltHandle, matmulDesc,
        &alpha, dB_fp8, Adesc, dA_fp8, Bdesc, &beta,
        dC, Cdesc, dC, Cdesc,
        &heuristicResult.algo, workspace, workspaceSize, 0), "cublasLt matmul");
    checkCuda(cudaDeviceSynchronize(), "cublasLt sync");

    checkCuda(cudaFree(workspace), "workspace free");
    if (pref) cublasLtMatmulPreferenceDestroy(pref);
    if (matmulDesc) cublasLtMatmulDescDestroy(matmulDesc);
    if (Adesc) cublasLtMatrixLayoutDestroy(Adesc);
    if (Bdesc) cublasLtMatrixLayoutDestroy(Bdesc);
    if (Cdesc) cublasLtMatrixLayoutDestroy(Cdesc);
    cublasLtDestroy(ltHandle);
}

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------
static int g_pass = 0;
static int g_fail = 0;

static void report_test(const char* name, const ErrorMetrics& m, float tol) {
    bool ok = (m.outliers == 0 && m.max_rel_err < tol);
    const char* status = ok ? "PASS" : "FAIL";
    if (ok) g_pass++; else g_fail++;
    std::printf("  [%s] %-35s max_rel=%.6f avg_rel=%.6f outliers=%d/%d\n",
                status, name, m.max_rel_err, m.avg_rel_err, m.outliers, m.total);
}

int main(int argc, char* argv[]) {
    int size = 256;
    if (argc > 1) size = std::atoi(argv[1]);
    if (size < 16 || size % 16 != 0) {
        std::fprintf(stderr, "Size must be multiple of 16 (WMMA tile)\n");
        return 1;
    }

    const int M = size, N = size, K = size;
    const size_t elemsA = static_cast<size_t>(M) * K;
    const size_t elemsB = static_cast<size_t>(K) * N;
    const size_t elemsC = static_cast<size_t>(M) * N;

    std::printf("=== GEMM Correctness Test (M=N=K=%d) ===\n\n", M);

    // Host data: random values in [-1, 1]
    std::srand(42);
    std::vector<float> hA_fp32(elemsA), hB_fp32(elemsB), hC_ref(elemsC), hC_gpu(elemsC);
    for (size_t i = 0; i < elemsA; ++i)
        hA_fp32[i] = (std::rand() / static_cast<float>(RAND_MAX)) * 2.0f - 1.0f;
    for (size_t i = 0; i < elemsB; ++i)
        hB_fp32[i] = (std::rand() / static_cast<float>(RAND_MAX)) * 2.0f - 1.0f;

    // CPU reference
    std::printf("[REF] Computing CPU FP32 reference...\n");
    cpu_gemm_f32(hA_fp32.data(), hB_fp32.data(), hC_ref.data(), M, N, K);

    // Convert to FP16
    std::vector<half> hA_fp16(elemsA), hB_fp16(elemsB);
    for (size_t i = 0; i < elemsA; ++i) hA_fp16[i] = __float2half(hA_fp32[i]);
    for (size_t i = 0; i < elemsB; ++i) hB_fp16[i] = __float2half(hB_fp32[i]);

    // Convert to FP8
    std::vector<__nv_fp8_e4m3> hA_fp8(elemsA), hB_fp8(elemsB);
    for (size_t i = 0; i < elemsA; ++i) hA_fp8[i] = __nv_fp8_e4m3(hA_fp32[i]);
    for (size_t i = 0; i < elemsB; ++i) hB_fp8[i] = __nv_fp8_e4m3(hB_fp32[i]);

    // Device allocation
    half *dA_fp16 = nullptr, *dB_fp16 = nullptr;
    __nv_fp8_e4m3 *dA_fp8 = nullptr, *dB_fp8 = nullptr;
    float *dC = nullptr;

    checkCuda(cudaMalloc(&dA_fp16, elemsA * sizeof(half)), "dA_fp16");
    checkCuda(cudaMalloc(&dB_fp16, elemsB * sizeof(half)), "dB_fp16");
    checkCuda(cudaMalloc(&dA_fp8, elemsA * sizeof(__nv_fp8_e4m3)), "dA_fp8");
    checkCuda(cudaMalloc(&dB_fp8, elemsB * sizeof(__nv_fp8_e4m3)), "dB_fp8");
    checkCuda(cudaMalloc(&dC, elemsC * sizeof(float)), "dC");

    checkCuda(cudaMemcpy(dA_fp16, hA_fp16.data(), elemsA * sizeof(half), cudaMemcpyHostToDevice), "H2D A16");
    checkCuda(cudaMemcpy(dB_fp16, hB_fp16.data(), elemsB * sizeof(half), cudaMemcpyHostToDevice), "H2D B16");
    checkCuda(cudaMemcpy(dA_fp8, hA_fp8.data(), elemsA * sizeof(__nv_fp8_e4m3), cudaMemcpyHostToDevice), "H2D A8");
    checkCuda(cudaMemcpy(dB_fp8, hB_fp8.data(), elemsB * sizeof(__nv_fp8_e4m3), cudaMemcpyHostToDevice), "H2D B8");

    // FP16 tolerance: FP16→FP32 WMMA accumulation introduces rounding error
    // compared to pure FP32. On random [-1,1] data, many output elements are
    // near zero (sum of ~256 products of small numbers), causing large
    // relative error even with small absolute error. We use a hybrid metric:
    // - Relative error for elements where |ref| > threshold
    // - Absolute error for near-zero elements
    // A 1% relative tolerance is appropriate for non-trivial outputs;
    // near-zero outputs are checked with absolute tolerance only.
    const float fp16_tol = 0.01f;
    // FP8 tolerance: FP8 has ~3 decimal digits, so 1% is expected
    const float fp8_tol = 0.05f;

    std::printf("\n--- FP16 WMMA Kernels ---\n");

    // Test 1: Baseline 1-warp
    {
        checkCuda(cudaMemset(dC, 0, elemsC * sizeof(float)), "clear");
        launchBaseline(dA_fp16, dB_fp16, dC, M, N, K);
        checkCuda(cudaDeviceSynchronize(), "sync baseline");
        checkCuda(cudaMemcpy(hC_gpu.data(), dC, elemsC * sizeof(float), cudaMemcpyDeviceToHost), "D2H baseline");
        auto m = compute_error(hC_gpu.data(), hC_ref.data(), elemsC, fp16_tol);
        report_test("baseline-1warp", m, fp16_tol);

        // FP16-vs-FP32 absolute error check: FP16 rounding error accumulates
        // proportionally to K. Each FP16 multiply-accumulate can introduce
        // ~0.5 ULP error; over K iterations, worst-case is ~K * FP16_EPS.
        // For K=1024, FP16_EPS=2^-10≈0.001, bound ≈ K*FP16_EPS ≈ 1.0.
        // In practice, errors are much smaller due to cancellation.
        // Empirical: max_abs ~ sqrt(K) * FP16_EPS. Use K/256 * 0.01 as tol.
        float abs_tol = (K / 256.0f) * 0.01f;
        if (abs_tol < 0.01f) abs_tol = 0.01f;
        int abs_outliers = 0;
        float max_abs = 0.0f;
        for (size_t i = 0; i < elemsC; ++i) {
            float a = std::fabs(hC_gpu[i] - hC_ref[i]);
            if (a > max_abs) max_abs = a;
            if (a > abs_tol) abs_outliers++;
        }
        bool abs_ok = (max_abs < abs_tol);
        if (abs_ok) g_pass++; else g_fail++;
        std::printf("  [%s] %-35s max_abs=%.6f tol=%.6f outliers=%d/%d\n",
                    abs_ok ? "PASS" : "FAIL", "baseline-1warp-abs", max_abs, abs_tol, abs_outliers, (int)elemsC);
    }

    // Test 2: 4-warp padded
    {
        checkCuda(cudaMemset(dC, 0, elemsC * sizeof(float)), "clear");
        launch4Warp(dA_fp16, dB_fp16, dC, M, N, K);
        checkCuda(cudaDeviceSynchronize(), "sync 4warp");
        checkCuda(cudaMemcpy(hC_gpu.data(), dC, elemsC * sizeof(float), cudaMemcpyDeviceToHost), "D2H 4warp");
        auto m = compute_error(hC_gpu.data(), hC_ref.data(), elemsC, fp16_tol);
        report_test("padded-4warp", m, fp16_tol);
    }

    // Test 3: async-8warp (default fast path)
    {
        checkCuda(cudaMemset(dC, 0, elemsC * sizeof(float)), "clear");
        launchAsync8Warp(dA_fp16, dB_fp16, dC, M, N, K);
        checkCuda(cudaDeviceSynchronize(), "sync async8");
        checkCuda(cudaMemcpy(hC_gpu.data(), dC, elemsC * sizeof(float), cudaMemcpyDeviceToHost), "D2H async8");
        auto m = compute_error(hC_gpu.data(), hC_ref.data(), elemsC, fp16_tol);
        report_test("fastpath-async-8warp", m, fp16_tol);
    }

    // Test 4: Cross-kernel consistency (baseline vs async8 should agree within FP16 rounding)
    {
        std::vector<float> hC_baseline(elemsC);
        checkCuda(cudaMemset(dC, 0, elemsC * sizeof(float)), "clear");
        launchBaseline(dA_fp16, dB_fp16, dC, M, N, K);
        checkCuda(cudaDeviceSynchronize(), "sync");
        checkCuda(cudaMemcpy(hC_baseline.data(), dC, elemsC * sizeof(float), cudaMemcpyDeviceToHost), "D2H");

        checkCuda(cudaMemset(dC, 0, elemsC * sizeof(float)), "clear");
        launchAsync8Warp(dA_fp16, dB_fp16, dC, M, N, K);
        checkCuda(cudaDeviceSynchronize(), "sync");
        checkCuda(cudaMemcpy(hC_gpu.data(), dC, elemsC * sizeof(float), cudaMemcpyDeviceToHost), "D2H");

        // Two FP16 kernels should agree to within rounding tolerance
        auto m = compute_error(hC_gpu.data(), hC_baseline.data(), elemsC, 0.001f);
        report_test("baseline-vs-async8-consistency", m, 0.001f);
    }

    std::printf("\n--- FP8 Kernels ---\n");

    // Test 5: FP8→FP16 fallback WMMA
    {
        checkCuda(cudaMemset(dC, 0, elemsC * sizeof(float)), "clear");
        launchFp8Fallback(dA_fp8, dB_fp8, dC, M, N, K);
        checkCuda(cudaDeviceSynchronize(), "sync fp8");
        checkCuda(cudaMemcpy(hC_gpu.data(), dC, elemsC * sizeof(float), cudaMemcpyDeviceToHost), "D2H fp8");

        // Build FP8 CPU reference (quantized to FP8 then back to FP32)
        std::vector<float> hA_q(elemsA), hB_q(elemsB), hC_fp8ref(elemsC);
        for (size_t i = 0; i < elemsA; ++i) hA_q[i] = static_cast<float>(hA_fp8[i]);
        for (size_t i = 0; i < elemsB; ++i) hB_q[i] = static_cast<float>(hB_fp8[i]);
        cpu_gemm_f32(hA_q.data(), hB_q.data(), hC_fp8ref.data(), M, N, K);

        auto m = compute_error(hC_gpu.data(), hC_fp8ref.data(), elemsC, fp8_tol);
        report_test("fp8-fallback-wmma", m, fp8_tol);
    }

    // Test 6: cuBLASLt FP8
    {
        checkCuda(cudaMemset(dC, 0, elemsC * sizeof(float)), "clear");
        runCublasLtFp8(dA_fp8, dB_fp8, dC, M, N, K);
        checkCuda(cudaMemcpy(hC_gpu.data(), dC, elemsC * sizeof(float), cudaMemcpyDeviceToHost), "D2H cublaslt");

        std::vector<float> hA_q(elemsA), hB_q(elemsB), hC_fp8ref(elemsC);
        for (size_t i = 0; i < elemsA; ++i) hA_q[i] = static_cast<float>(hA_fp8[i]);
        for (size_t i = 0; i < elemsB; ++i) hB_q[i] = static_cast<float>(hB_fp8[i]);
        cpu_gemm_f32(hA_q.data(), hB_q.data(), hC_fp8ref.data(), M, N, K);

        auto m = compute_error(hC_gpu.data(), hC_fp8ref.data(), elemsC, fp8_tol);
        report_test("cublaslt-fp8-e4m3", m, fp8_tol);
    }

    // Test 7: FP8 fallback vs cuBLASLt consistency
    {
        std::vector<float> hC_fb(elemsC), hC_cublt(elemsC);
        checkCuda(cudaMemset(dC, 0, elemsC * sizeof(float)), "clear");
        launchFp8Fallback(dA_fp8, dB_fp8, dC, M, N, K);
        checkCuda(cudaDeviceSynchronize(), "sync");
        checkCuda(cudaMemcpy(hC_fb.data(), dC, elemsC * sizeof(float), cudaMemcpyDeviceToHost), "D2H");

        checkCuda(cudaMemset(dC, 0, elemsC * sizeof(float)), "clear");
        runCublasLtFp8(dA_fp8, dB_fp8, dC, M, N, K);
        checkCuda(cudaMemcpy(hC_cublt.data(), dC, elemsC * sizeof(float), cudaMemcpyDeviceToHost), "D2H");

        auto m = compute_error(hC_fb.data(), hC_cublt.data(), elemsC, fp8_tol);
        report_test("fp8-fallback-vs-cublaslt", m, fp8_tol);
    }

    // Cleanup
    checkCuda(cudaFree(dA_fp16), "free");
    checkCuda(cudaFree(dB_fp16), "free");
    checkCuda(cudaFree(dA_fp8), "free");
    checkCuda(cudaFree(dB_fp8), "free");
    checkCuda(cudaFree(dC), "free");

    std::printf("\n=== Results: %d PASS, %d FAIL ===\n", g_pass, g_fail);
    return g_fail > 0 ? 1 : 0;
}
