/* GEN 5: WMMA occupancy + unrolled K-loop + half2 async staging + 8-warp variant */
#include <cuda_runtime.h>
#include <cuda_fp16.h>
#include <mma.h>
#include <iostream>
#include <vector>

#define WMMA_M 16
#define WMMA_N 16
#define WMMA_K 16
#define WARP_SIZE 32
#define WARPS_PER_BLOCK 4
#define WARPS_PER_BLOCK_8 8
#define HALF_PAD 1
#define FP8_PAD 4
#ifndef ENABLE_TRIPLE_BUFFER_EXPERIMENT
#define ENABLE_TRIPLE_BUFFER_EXPERIMENT 0
#endif

using namespace nvcuda::wmma;

static inline void checkCuda(cudaError_t err, const char* msg) {
    if (err != cudaSuccess) {
        std::cerr << msg << ": " << cudaGetErrorString(err) << std::endl;
        std::exit(1);
    }
}

// Baseline kept for A/B profiling: 1 warp per block.
__global__ void matrixMul_wmma_baseline(const half* A, const half* B, float* C, int M, int N, int K) {
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
        if (a_row < M && k0 + WMMA_K <= K) load_matrix_sync(a_frag, A + a_row * K + k0, K);
        if (b_col < N && k0 + WMMA_K <= K) load_matrix_sync(b_frag, B + k0 * N + b_col, N);
        mma_sync(c_frag, a_frag, b_frag, c_frag);
    }

    if (a_row < M && b_col < N) {
        store_matrix_sync(C + a_row * N + b_col, c_frag, N, mem_row_major);
    }
}

// Occupancy fix path: 4 warps per block (dim3(32,4,1)).
__global__ void matrixMul_wmma_4warp_padded(const half* A, const half* B, float* C, int M, int N, int K) {
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

// Async double-buffer with per-warp shared memory and half2 global loads.
__global__ void matrixMul_wmma_async(const half* A, const half* B, float* C, int M, int N, int K) {
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
        if (tile_m + row < M && col + 1 < K) {
            v = reinterpret_cast<const half2*>(A + (tile_m + row) * K + col)[0];
        }
        half* rowPtr = sA + buf * aStride + row * WMMA_K;
        rowPtr[col] = __low2half(v);
        rowPtr[col + 1] = __high2half(v);
    }

    for (int i = threadIdx.x; i < WMMA_K * (WMMA_N / 2); i += 32) {
        const int row = i / (WMMA_N / 2);
        const int col2 = i % (WMMA_N / 2);
        const int col = col2 * 2;
        half2 v = __floats2half2_rn(0.0f, 0.0f);
        if (row < K && tile_n + col + 1 < N) {
            v = reinterpret_cast<const half2*>(B + row * N + tile_n + col)[0];
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
            for (int i = threadIdx.x; i < WMMA_M * (WMMA_K / 2); i += 32) {
                const int row = i / (WMMA_K / 2);
                const int col2 = i % (WMMA_K / 2);
                const int col = col2 * 2;
                half2 v = __floats2half2_rn(0.0f, 0.0f);
                if (tile_m + row < M && col + k_next + 1 < K) {
                    v = reinterpret_cast<const half2*>(A + (tile_m + row) * K + (col + k_next))[0];
                }
                half* rowPtr = sA + buf * aStride + row * WMMA_K;
                rowPtr[col] = __low2half(v);
                rowPtr[col + 1] = __high2half(v);
            }

            for (int i = threadIdx.x; i < WMMA_K * (WMMA_N / 2); i += 32) {
                const int row = i / (WMMA_N / 2);
                const int col2 = i % (WMMA_N / 2);
                const int col = col2 * 2;
                half2 v = __floats2half2_rn(0.0f, 0.0f);
                if (row + k_next < K && tile_n + col + 1 < N) {
                    v = reinterpret_cast<const half2*>(B + (row + k_next) * N + (tile_n + col))[0];
                }
                half* rowPtr = sB + buf * bStride + row * WMMA_N;
                rowPtr[col] = __low2half(v);
                rowPtr[col + 1] = __high2half(v);
            }
            __syncthreads();
        }
    }

    store_matrix_sync(C + tile_m * N + tile_n, c_frag, N, mem_row_major);
}

// Triple-buffer staging variant to reduce handoff stalls between tiles.
#if ENABLE_TRIPLE_BUFFER_EXPERIMENT
__global__ void matrixMul_wmma_async_triple(const half* A, const half* B, float* C, int M, int N, int K) {
    const int warp_local = threadIdx.y;
    const int warp_global_y = blockIdx.y * blockDim.y + warp_local;
    const int warp_global_x = blockIdx.x;

    const int tile_m = warp_global_y * WMMA_M;
    const int tile_n = warp_global_x * WMMA_N;
    if (tile_m >= M || tile_n >= N) return;

    extern __shared__ half shmem[];
    constexpr int aStride = WMMA_M * WMMA_K;
    constexpr int bStride = WMMA_K * WMMA_N;
    constexpr int warpSharedHalfCount = 3 * (aStride + bStride);
    half* warpShmem = shmem + warp_local * warpSharedHalfCount;
    half* sA = warpShmem;
    half* sB = warpShmem + 3 * aStride;

    fragment<matrix_a, WMMA_M, WMMA_N, WMMA_K, half, row_major> a_frag;
    fragment<matrix_b, WMMA_M, WMMA_N, WMMA_K, half, row_major> b_frag;
    fragment<accumulator, WMMA_M, WMMA_N, WMMA_K, float> c_frag;
    fill_fragment(c_frag, 0.0f);

    int prefetchCount = (K >= WMMA_K) ? 1 : 0;
    if (K >= 2 * WMMA_K) prefetchCount = 2;
    if (K >= 3 * WMMA_K) prefetchCount = 3;

    for (int b = 0; b < prefetchCount; ++b) {
        int kBase = b * WMMA_K;
        for (int i = threadIdx.x; i < WMMA_M * (WMMA_K / 2); i += 32) {
            const int row = i / (WMMA_K / 2);
            const int col2 = i % (WMMA_K / 2);
            const int col = col2 * 2;
            half2 v = __floats2half2_rn(0.0f, 0.0f);
            if (tile_m + row < M && col + kBase + 1 < K) {
                v = reinterpret_cast<const half2*>(A + (tile_m + row) * K + (col + kBase))[0];
            }
            half* rowPtr = sA + b * aStride + row * WMMA_K;
            rowPtr[col] = __low2half(v);
            rowPtr[col + 1] = __high2half(v);
        }
        for (int i = threadIdx.x; i < WMMA_K * (WMMA_N / 2); i += 32) {
            const int row = i / (WMMA_N / 2);
            const int col2 = i % (WMMA_N / 2);
            const int col = col2 * 2;
            half2 v = __floats2half2_rn(0.0f, 0.0f);
            if (row + kBase < K && tile_n + col + 1 < N) {
                v = reinterpret_cast<const half2*>(B + (row + kBase) * N + tile_n + col)[0];
            }
            half* rowPtr = sB + b * bStride + row * WMMA_N;
            rowPtr[col] = __low2half(v);
            rowPtr[col + 1] = __high2half(v);
        }
    }
    __syncthreads();

    for (int k0 = 0; k0 < K; k0 += WMMA_K) {
        const int computeBuf = (k0 / WMMA_K) % 3;
        load_matrix_sync(a_frag, sA + computeBuf * aStride, WMMA_K);
        load_matrix_sync(b_frag, sB + computeBuf * bStride, WMMA_N);
        mma_sync(c_frag, a_frag, b_frag, c_frag);

        const int nextK = k0 + prefetchCount * WMMA_K;
        if (nextK < K) {
            const int fillBuf = (nextK / WMMA_K) % 3;
            for (int i = threadIdx.x; i < WMMA_M * (WMMA_K / 2); i += 32) {
                const int row = i / (WMMA_K / 2);
                const int col2 = i % (WMMA_K / 2);
                const int col = col2 * 2;
                half2 v = __floats2half2_rn(0.0f, 0.0f);
                if (tile_m + row < M && col + nextK + 1 < K) {
                    v = reinterpret_cast<const half2*>(A + (tile_m + row) * K + (col + nextK))[0];
                }
                half* rowPtr = sA + fillBuf * aStride + row * WMMA_K;
                rowPtr[col] = __low2half(v);
                rowPtr[col + 1] = __high2half(v);
            }
            for (int i = threadIdx.x; i < WMMA_K * (WMMA_N / 2); i += 32) {
                const int row = i / (WMMA_N / 2);
                const int col2 = i % (WMMA_N / 2);
                const int col = col2 * 2;
                half2 v = __floats2half2_rn(0.0f, 0.0f);
                if (row + nextK < K && tile_n + col + 1 < N) {
                    v = reinterpret_cast<const half2*>(B + (row + nextK) * N + tile_n + col)[0];
                }
                half* rowPtr = sB + fillBuf * bStride + row * WMMA_N;
                rowPtr[col] = __low2half(v);
                rowPtr[col + 1] = __high2half(v);
            }
            __syncthreads();
        }
    }

    store_matrix_sync(C + tile_m * N + tile_n, c_frag, N, mem_row_major);
}
#endif

// FP8 hook: this file reserves +4 padding for an FP8 path.
struct Fp8PlanMarker {
    static constexpr int kPad = FP8_PAD;
};

static float runKernel(
    const char* name,
    void (*launcher)(const half*, const half*, float*, int, int, int),
    const half* dA,
    const half* dB,
    float* dC,
    int M,
    int N,
    int K
) {
    cudaEvent_t start{}, stop{};
    checkCuda(cudaEventCreate(&start), "cudaEventCreate(start)");
    checkCuda(cudaEventCreate(&stop), "cudaEventCreate(stop)");
    checkCuda(cudaEventRecord(start), "cudaEventRecord(start)");
    launcher(dA, dB, dC, M, N, K);
    checkCuda(cudaEventRecord(stop), "cudaEventRecord(stop)");
    checkCuda(cudaEventSynchronize(stop), "cudaEventSynchronize(stop)");
    float ms = 0.0f;
    checkCuda(cudaEventElapsedTime(&ms, start, stop), "cudaEventElapsedTime");
    checkCuda(cudaEventDestroy(start), "cudaEventDestroy(start)");
    checkCuda(cudaEventDestroy(stop), "cudaEventDestroy(stop)");
    std::cout << name << ": " << ms << " ms" << std::endl;
    return ms;
}

static void launchBaseline(const half* A, const half* B, float* C, int M, int N, int K) {
    int warps = ((M + WMMA_M - 1) / WMMA_M) * ((N + WMMA_N - 1) / WMMA_N);
    int threads = 32;
    int blocks = warps;
    matrixMul_wmma_baseline<<<blocks, threads>>>(A, B, C, M, N, K);
}

static void launch4Warp(const half* A, const half* B, float* C, int M, int N, int K) {
    dim3 block(32, WARPS_PER_BLOCK, 1);
    dim3 grid(
        (N + WMMA_N - 1) / WMMA_N,
        ((M + WMMA_M - 1) / WMMA_M + WARPS_PER_BLOCK - 1) / WARPS_PER_BLOCK,
        1
    );
    matrixMul_wmma_4warp_padded<<<grid, block>>>(A, B, C, M, N, K);
}

static void launchAsync4Warp(const half* A, const half* B, float* C, int M, int N, int K) {
    dim3 block(32, WARPS_PER_BLOCK, 1);
    dim3 grid(
        (N + WMMA_N - 1) / WMMA_N,
        ((M + WMMA_M - 1) / WMMA_M + WARPS_PER_BLOCK - 1) / WARPS_PER_BLOCK,
        1
    );
    constexpr size_t aStride = WMMA_M * WMMA_K;
    constexpr size_t bStride = WMMA_K * WMMA_N;
    size_t sharedBytes = static_cast<size_t>(WARPS_PER_BLOCK) * 2 * (aStride + bStride) * sizeof(half);
    matrixMul_wmma_async<<<grid, block, sharedBytes>>>(A, B, C, M, N, K);
}

static void launchAsync8Warp(const half* A, const half* B, float* C, int M, int N, int K) {
    dim3 block(32, WARPS_PER_BLOCK_8, 1);
    dim3 grid(
        (N + WMMA_N - 1) / WMMA_N,
        ((M + WMMA_M - 1) / WMMA_M + WARPS_PER_BLOCK_8 - 1) / WARPS_PER_BLOCK_8,
        1
    );
    constexpr size_t aStride = WMMA_M * WMMA_K;
    constexpr size_t bStride = WMMA_K * WMMA_N;
    size_t sharedBytes = static_cast<size_t>(WARPS_PER_BLOCK_8) * 2 * (aStride + bStride) * sizeof(half);
    matrixMul_wmma_async<<<grid, block, sharedBytes>>>(A, B, C, M, N, K);
}

#if ENABLE_TRIPLE_BUFFER_EXPERIMENT
static void launchAsync8WarpTriple(const half* A, const half* B, float* C, int M, int N, int K) {
    dim3 block(32, WARPS_PER_BLOCK_8, 1);
    dim3 grid(
        (N + WMMA_N - 1) / WMMA_N,
        ((M + WMMA_M - 1) / WMMA_M + WARPS_PER_BLOCK_8 - 1) / WARPS_PER_BLOCK_8,
        1
    );
    constexpr size_t aStride = WMMA_M * WMMA_K;
    constexpr size_t bStride = WMMA_K * WMMA_N;
    size_t sharedBytes = static_cast<size_t>(WARPS_PER_BLOCK_8) * 3 * (aStride + bStride) * sizeof(half);
    matrixMul_wmma_async_triple<<<grid, block, sharedBytes>>>(A, B, C, M, N, K);
}
#endif

int main() {
    const int M = 1024;
    const int N = 1024;
    const int K = 1024;
    const size_t aCount = static_cast<size_t>(M) * K;
    const size_t bCount = static_cast<size_t>(K) * N;
    const size_t cCount = static_cast<size_t>(M) * N;

    std::vector<half> hA(aCount, __float2half(1.0f));
    std::vector<half> hB(bCount, __float2half(1.0f));

    half* dA = nullptr;
    half* dB = nullptr;
    float* dC = nullptr;
    checkCuda(cudaMalloc(&dA, aCount * sizeof(half)), "cudaMalloc(dA)");
    checkCuda(cudaMalloc(&dB, bCount * sizeof(half)), "cudaMalloc(dB)");
    checkCuda(cudaMalloc(&dC, cCount * sizeof(float)), "cudaMalloc(dC)");
    checkCuda(cudaMemcpy(dA, hA.data(), aCount * sizeof(half), cudaMemcpyHostToDevice), "cudaMemcpy(dA)");
    checkCuda(cudaMemcpy(dB, hB.data(), bCount * sizeof(half), cudaMemcpyHostToDevice), "cudaMemcpy(dB)");
    checkCuda(cudaMemset(dC, 0, cCount * sizeof(float)), "cudaMemset(dC)");

    std::cout << "WMMA benchmark (M=N=K=1024)\n";
    std::cout << "Default fast path: async-8warp\n";
    std::cout << "FP8 pad requirement marker: +" << Fp8PlanMarker::kPad << " columns\n";
    runKernel("baseline-1warp", launchBaseline, dA, dB, dC, M, N, K);
    runKernel("padded-4warp", launch4Warp, dA, dB, dC, M, N, K);
    runKernel("async-4warp", launchAsync4Warp, dA, dB, dC, M, N, K);
    runKernel("fastpath-async-8warp", launchAsync8Warp, dA, dB, dC, M, N, K);
#if ENABLE_TRIPLE_BUFFER_EXPERIMENT
    runKernel("exp-async-8warp-triple", launchAsync8WarpTriple, dA, dB, dC, M, N, K);
#endif
    checkCuda(cudaDeviceSynchronize(), "cudaDeviceSynchronize");

    checkCuda(cudaFree(dA), "cudaFree(dA)");
    checkCuda(cudaFree(dB), "cudaFree(dB)");
    checkCuda(cudaFree(dC), "cudaFree(dC)");
    return 0;
}
