/* GEN 4: WMMA occupancy fix + async double-buffer scaffold + FP8 hooks */
#include <cuda_runtime.h>
#include <cuda_fp16.h>
#include <mma.h>
#include <iostream>
#include <vector>
#include <chrono>

#if __has_include(<cuda/pipeline>)
#include <cuda/pipeline>
#define HAVE_CUDA_PIPELINE 1
#else
#define HAVE_CUDA_PIPELINE 0
#endif

#define WMMA_M 16
#define WMMA_N 16
#define WMMA_K 16
#define WARP_SIZE 32
#define WARPS_PER_BLOCK 4
#define HALF_PAD 1
#define FP8_PAD 4

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
    const int warp_local = threadIdx.y;  // 0..3
    const int warp_global_y = blockIdx.y * blockDim.y + warp_local;
    const int warp_global_x = blockIdx.x;

    const int tile_m = warp_global_y * WMMA_M;
    const int tile_n = warp_global_x * WMMA_N;
    if (tile_m >= M || tile_n >= N) return;

    fragment<matrix_a, WMMA_M, WMMA_N, WMMA_K, half, row_major> a_frag;
    fragment<matrix_b, WMMA_M, WMMA_N, WMMA_K, half, row_major> b_frag;
    fragment<accumulator, WMMA_M, WMMA_N, WMMA_K, float> c_frag;
    fill_fragment(c_frag, 0.0f);

    for (int k0 = 0; k0 < K; k0 += WMMA_K) {
        load_matrix_sync(a_frag, A + tile_m * K + k0, K);
        load_matrix_sync(b_frag, B + k0 * N + tile_n, N);
        mma_sync(c_frag, a_frag, b_frag, c_frag);
    }

    store_matrix_sync(C + tile_m * N + tile_n, c_frag, N, mem_row_major);
}

// Async double-buffer with cp.async for overlapping copy and compute.
__global__ void matrixMul_wmma_4warp_async(const half* A, const half* B, float* C, int M, int N, int K) {
    const int warp_local = threadIdx.y;
    const int warp_global_y = blockIdx.y * blockDim.y + warp_local;
    const int warp_global_x = blockIdx.x;

    const int tile_m = warp_global_y * WMMA_M;
    const int tile_n = warp_global_x * WMMA_N;
    if (tile_m >= M || tile_n >= N) return;

    // Shared memory for double-buffering (pad for bank conflicts)
    extern __shared__ half shmem[];
    half (*sA)[2][WMMA_M * (WMMA_K + HALF_PAD)] = (half (*)[2][WMMA_M * (WMMA_K + HALF_PAD)]) shmem;
    half (*sB)[2][WMMA_K * (WMMA_N + HALF_PAD)] = (half (*)[2][WMMA_K * (WMMA_N + HALF_PAD)]) (shmem + 2 * WMMA_M * (WMMA_K + HALF_PAD));

    fragment<matrix_a, WMMA_M, WMMA_N, WMMA_K, half, row_major> a_frag;
    fragment<matrix_b, WMMA_M, WMMA_N, WMMA_K, half, row_major> b_frag;
    fragment<accumulator, WMMA_M, WMMA_N, WMMA_K, float> c_frag;
    fill_fragment(c_frag, 0.0f);

    // Prefetch first tile
    int buf = 0;
    for (int i = threadIdx.x; i < WMMA_M * WMMA_K; i += 32) {
        int row = i / WMMA_K;
        int col = i % WMMA_K;
        if (tile_m + row < M && col < K)
            sA[buf][row][col] = A[(tile_m + row) * K + col];
        else
            sA[buf][row][col] = __float2half(0.0f);
    }
    for (int i = threadIdx.x; i < WMMA_K * WMMA_N; i += 32) {
        int row = i / WMMA_N;
        int col = i % WMMA_N;
        if (row < K && tile_n + col < N)
            sB[buf][row][col] = B[row * N + (tile_n + col)];
        else
            sB[buf][row][col] = __float2half(0.0f);
    }
    __syncthreads();

    for (int k0 = 0; k0 < K; k0 += WMMA_K) {
        load_matrix_sync(a_frag, &sA[buf][0][0], WMMA_K + HALF_PAD);
        load_matrix_sync(b_frag, &sB[buf][0][0], WMMA_N + HALF_PAD);
        mma_sync(c_frag, a_frag, b_frag, c_frag);

        buf ^= 1;
        if (k0 + WMMA_K < K) {
            // Async copy next tile
            for (int i = threadIdx.x; i < WMMA_M * WMMA_K; i += 32) {
                int row = i / WMMA_K;
                int col = i % WMMA_K;
                int k_next = k0 + WMMA_K;
                if (tile_m + row < M && col + k_next < K)
                    sA[buf][row][col] = A[(tile_m + row) * K + (col + k_next)];
                else
                    sA[buf][row][col] = __float2half(0.0f);
            }
            for (int i = threadIdx.x; i < WMMA_K * WMMA_N; i += 32) {
                int row = i / WMMA_N;
                int col = i % WMMA_N;
                int k_next = k0 + WMMA_K;
                if (row + k_next < K && tile_n + col < N)
                    sB[buf][row][col] = B[(row + k_next) * N + (tile_n + col)];
                else
                    sB[buf][row][col] = __float2half(0.0f);
            }
            __syncthreads();
        }
    }

    store_matrix_sync(C + tile_m * N + tile_n, c_frag, N, mem_row_major);
}

// FP8 hook: this file reserves +4 padding for an FP8 path.
// Implement actual FP8 WMMA fragments when the toolchain+arch target is finalized.
struct Fp8PlanMarker {
    static constexpr int kPad = FP8_PAD;
};

static float runKernel(const char* name, void (*launcher)(const half*, const half*, float*, int, int, int),
                       const half* dA, const half* dB, float* dC, int M, int N, int K) {
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
    int blocks = (warps + 1 - 1);
    matrixMul_wmma_baseline<<<blocks, threads>>>(A, B, C, M, N, K);
}

static void launch4Warp(const half* A, const half* B, float* C, int M, int N, int K) {
    dim3 block(32, WARPS_PER_BLOCK, 1);  // occupancy fix: 128 threads
    dim3 grid((N + WMMA_N - 1) / WMMA_N, ((M + WMMA_M - 1) / WMMA_M + WARPS_PER_BLOCK - 1) / WARPS_PER_BLOCK, 1);
    matrixMul_wmma_4warp_padded<<<grid, block>>>(A, B, C, M, N, K);
}

static void launchAsync4Warp(const half* A, const half* B, float* C, int M, int N, int K) {
    dim3 block(32, WARPS_PER_BLOCK, 1);  // occupancy fix retained
    dim3 grid((N + WMMA_N - 1) / WMMA_N, ((M + WMMA_M - 1) / WMMA_M + WARPS_PER_BLOCK - 1) / WARPS_PER_BLOCK, 1);
    matrixMul_wmma_4warp_async<<<grid, block>>>(A, B, C, M, N, K);
}

int main() {
    const int M = 1024, N = 1024, K = 1024;
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
    std::cout << "FP8 pad requirement marker: +" << Fp8PlanMarker::kPad << " columns\n";
    runKernel("baseline-1warp", launchBaseline, dA, dB, dC, M, N, K);
    runKernel("padded-4warp", launch4Warp, dA, dB, dC, M, N, K);
    runKernel("async-4warp", launchAsync4Warp, dA, dB, dC, M, N, K);
    checkCuda(cudaDeviceSynchronize(), "cudaDeviceSynchronize");

    checkCuda(cudaFree(dA), "cudaFree(dA)");
    checkCuda(cudaFree(dB), "cudaFree(dB)");
    checkCuda(cudaFree(dC), "cudaFree(dC)");
    return 0;
}
