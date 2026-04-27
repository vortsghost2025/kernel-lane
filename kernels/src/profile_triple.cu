#include <cuda_runtime.h>
#include <cuda_fp16.h>
#include <mma.h>
#include <iostream>
#include <vector>

#define WMMA_M 16
#define WMMA_N 16
#define WMMA_K 16
#define WARP_SIZE 32
#define WARPS_PER_BLOCK_8 8
#define ENABLE_TRIPLE_BUFFER_EXPERIMENT 1

using namespace nvcuda::wmma;

static inline void checkCuda(cudaError_t err, const char* msg) {
 if (err != cudaSuccess) {
  std::cerr << msg << ": " << cudaGetErrorString(err) << std::endl;
  std::exit(1);
 }
}

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

int main() {
 const int M = 4096;
 const int N = 4096;
 const int K = 4096;
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

 dim3 block(32, WARPS_PER_BLOCK_8, 1);
 dim3 grid(
  (N + WMMA_N - 1) / WMMA_N,
  ((M + WMMA_M - 1) / WMMA_M + WARPS_PER_BLOCK_8 - 1) / WARPS_PER_BLOCK_8,
  1
 );
 constexpr size_t aStride = WMMA_M * WMMA_K;
 constexpr size_t bStride = WMMA_K * WMMA_N;
 size_t sharedBytes = static_cast<size_t>(WARPS_PER_BLOCK_8) * 3 * (aStride + bStride) * sizeof(half);

 matrixMul_wmma_async_triple<<<grid, block, sharedBytes>>>(dA, dB, dC, M, N, K);
 checkCuda(cudaDeviceSynchronize(), "cudaDeviceSynchronize");

 checkCuda(cudaFree(dA), "cudaFree(dA)");
 checkCuda(cudaFree(dB), "cudaFree(dB)");
 checkCuda(cudaFree(dC), "cudaFree(dC)");
 return 0;
}
