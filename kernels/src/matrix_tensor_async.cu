// Async double-buffered WMMA GEMM for RTX 5060 (SM 120)
// Includes both half (FP16) and FP8 (e4m3) variants
// Based on NSIGHT_WMMA_ANALYSIS_SM120.md

#include <cuda_runtime.h>
#include <mma.h>
#include <cuda/pipeline>
#include <chrono>
#include <iostream>

using namespace nvcuda::wmma;

constexpr int WMMA_M = 16;
constexpr int WMMA_N = 16;
constexpr int WMMA_K = 16;
// Padding: +1 column for half (2 bytes), +4 for FP8 (1 byte)
constexpr int PAD_HALF = 1;
constexpr int PAD_FP8 = 4;

// ------------------------------------------------------------
// Half-precision async kernel
// ------------------------------------------------------------
template<class T, int PAD>
__global__ void wmma_gemm_async(const T* __restrict__ A,
                                 const T* __restrict__ B,
                                 float* __restrict__ C,
                                 int M, int N, int K)
{
    // 4 warps per block (128 threads)
    const int warp_id = threadIdx.x / warpSize; // 0-3
    const int lane_id = threadIdx.x % warpSize;
    const int tile_m = (blockIdx.y * 4 + warp_id) * WMMA_M; // 4 warps in Y
    const int tile_n = blockIdx.x * WMMA_N;

    // Shared memory double‑buffered layout
    // Each buffer contains A and B tiles. Total shared memory per block:
    //   4 * WMMA_M * (WMMA_K + PAD) elements of type T.
    extern __shared__ T shmem[];

    using pipeline = cuda::pipeline<cuda::thread_scope_block>;
    pipeline pipe = pipeline::create();

    fragment<matrix_a, WMMA_M, WMMA_N, WMMA_K, T, row_major> a_frag;
    fragment<matrix_b, WMMA_M, WMMA_N, WMMA_K, T, col_major> b_frag;
    fragment<accumulator, WMMA_M, WMMA_N, WMMA_K, float> c_frag;
    fill_fragment(c_frag, 0.0f);

    int buf = 0;
    // Prefetch first K tile
    {
        const T* srcA = A + tile_m * K;           // start of row tile
        const T* srcB = B + tile_n;              // start of column tile
    cuda::memcpy_async((T*)(shmem + buf * 2 * WMMA_M * (WMMA_K + PAD)),
                       srcA, WMMA_M * (WMMA_K + PAD) * sizeof(T), pipe);
    cuda::memcpy_async((T*)(shmem + buf * 2 * WMMA_M * (WMMA_K + PAD) + WMMA_M * (WMMA_K + PAD)),
                       srcB, WMMA_K * (WMMA_N + PAD) * sizeof(T), pipe);
        pipe.producer_commit();
    }

    for (int k = 0; k < K; k += WMMA_K) {
        pipe.consumer_wait();
        load_matrix_sync(a_frag, (T*)(shmem + buf * 2 * WMMA_M * (WMMA_K + PAD)), WMMA_K + PAD);
        load_matrix_sync(b_frag, (T*)(shmem + buf * 2 * WMMA_M * (WMMA_K + PAD) + WMMA_M * (WMMA_K + PAD)), WMMA_N + PAD);
        mma_sync(c_frag, a_frag, b_frag, c_frag);
        // Prepare next tile
        buf ^= 1;
        if (k + WMMA_K < K) {
            const T* srcA = A + tile_m * K + (k + WMMA_K);
            const T* srcB = B + (k + WMMA_K) * N + tile_n;
cuda::memcpy_async((T*)(shmem + buf * 2 * WMMA_M * (WMMA_K + PAD)), srcA,
                               WMMA_M * (WMMA_K + PAD) * sizeof(T), pipe);
cuda::memcpy_async((T*)(shmem + buf * 2 * WMMA_M * (WMMA_K + PAD) + WMMA_M * (WMMA_K + PAD)), srcB,
                               WMMA_K * (WMMA_N + PAD) * sizeof(T), pipe);
            pipe.producer_commit();
        }
    }

    if (tile_m < M && tile_n < N) {
        store_matrix_sync(C + tile_m * N + tile_n, c_frag, N, mem_row_major);
    }
}

// ------------------------------------------------------------
// Helper to launch half or FP8 kernels
// ------------------------------------------------------------
void run_async(const std::string& mode, int M, int N, int K) {
    // Allocate device buffers
    size_t sizeA = static_cast<size_t>(M) * K * sizeof(half);
    size_t sizeB = static_cast<size_t>(K) * N * sizeof(half);
    size_t sizeC = static_cast<size_t>(M) * N * sizeof(float);
    half *dA, *dB; float *dC;
    cudaMalloc(&dA, sizeA);
    cudaMalloc(&dB, sizeB);
    cudaMalloc(&dC, sizeC);
    // Simple init
    cudaMemset(dA, 0, sizeA);
    cudaMemset(dB, 0, sizeB);
    cudaMemset(dC, 0, sizeC);
    dim3 grid((N + WMMA_N - 1) / WMMA_N, (M + 63) / 64);
    dim3 block(32,4,1); // 128 threads
    size_t shmemBytes = 4 * WMMA_M * (WMMA_K + PAD_HALF) * sizeof(half);
    // Choose kernel based on mode
    if (mode == "fp16") {
        wmma_gemm_async<half,PAD_HALF><<<grid, block, shmemBytes>>>(dA, dB, dC, M, N, K);
    } else if (mode == "fp8") {
        // FP8: allocate half-size buffers (1 byte per element) using __nv_fp8_e4m3
        // Reallocate with correct size
        cudaFree(dA); cudaFree(dB);
        cudaMalloc(&dA, static_cast<size_t>(M) * K * sizeof(__nv_fp8_e4m3));
        cudaMalloc(&dB, static_cast<size_t>(K) * N * sizeof(__nv_fp8_e4m3));
        // Note: For simplicity we reuse the same kernel template with T=__nv_fp8_e4m3 and PAD=PAD_FP8
        wmma_gemm_async<__nv_fp8_e4m3,PAD_FP8><<<grid, block, 4 * WMMA_M * (WMMA_K + PAD_FP8) * sizeof(__nv_fp8_e4m3)>>>(
            reinterpret_cast<const __nv_fp8_e4m3*>(dA),
            reinterpret_cast<const __nv_fp8_e4m3*>(dB),
            dC, M, N, K);
    } else {
        std::cerr << "Unsupported mode: " << mode << std::endl;
        return;
    }
    cudaDeviceSynchronize();
    cudaFree(dA); cudaFree(dB); cudaFree(dC);
}

int main(int argc, char* argv[]) {
    int M = 1024, N = 1024, K = 1024;
    std::string mode = "fp16"; // half by default
    if (argc > 1) M = std::atoi(argv[1]);
    if (argc > 2) N = std::atoi(argv[2]);
    if (argc > 3) K = std::atoi(argv[3]);
    if (argc > 4) mode = argv[4]; // fp16 or fp8
    auto start = std::chrono::high_resolution_clock::now();
    run_async(mode, M, N, K);
    auto end = std::chrono::high_resolution_clock::now();
    std::chrono::duration<double> diff = end - start;
    std::cout << "Async GEMM " << mode << " completed in " << diff.count() << " s\n";
    return 0;
}
