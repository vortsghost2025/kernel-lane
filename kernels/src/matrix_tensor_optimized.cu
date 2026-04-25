/* GEN 3: Tensor Core WMMA + Padded Shared Memory */
#include <cuda_runtime.h>
#include <mma.h>
#include <iostream>

#define WMMA_M 16
#define WMMA_N 16  
#define WMMA_K 16
#define WARP_SIZE 32
using namespace nvcuda::wmma;

// Baseline: WMMA direct global memory
__global__ void matrixMul_wmma_baseline(const half* A, const half* B, float* C, int M, int N, int K) {
    int warp_id = (blockIdx.x * blockDim.x + threadIdx.x) / WARP_SIZE;
    int warps_per_row = (N + WMMA_N - 1) / WMMA_N;
    int warp_x = warp_id % warps_per_row;
    int warp_y = warp_id / warps_per_row;
    if (warp_y * WMMA_M >= M || warp_x * WMMA_N >= N) return;
    fragment<matrix_a, WMMA_M, WMMA_N, WMMA_K, half, row_major> a_frag;
    fragment<matrix_b, WMMA_M, WMMA_N, WMMA_K, half, row_major> b_frag;
    fragment<accumulator, WMMA_M, WMMA_N, WMMA_K, float> c_frag;
    fill_fragment(c_frag, 0.0f);
    int a_row = warp_y * WMMA_M, b_col = warp_x * WMMA_N;
    for (int k = 0; k < K; k += WMMA_K) {
        if (a_row < M && k + WMMA_K <= K) load_matrix_sync(a_frag, A + a_row * K + k, K);
        if (b_col < N && k + WMMA_K <= K) load_matrix_sync(b_frag, B + k * N + b_col, N);
        mma_sync(c_frag, a_frag, b_frag, c_frag);
    }
    int c_row = warp_y * WMMA_M, c_col = warp_x * WMMA_N;
    if (c_row < M && c_col < N) store_matrix_sync(C + c_row * N + c_col, c_frag, N, mem_row_major);
}

// OPTIMIZED: Padded shared memory (16x17) eliminates bank conflicts
__global__ void matrixMul_wmma_padded(const half* A, const half* B, float* C, int M, int N, int K) {
    int warp_id = (blockIdx.x * blockDim.x + threadIdx.x) / WARP_SIZE;
    int warps_per_row = (N + WMMA_N - 1) / WMMA_N;
    int warp_x = warp_id % warps_per_row, warp_y = warp_id / warps_per_row;
    if (warp_y * WMMA_M >= M || warp_x * WMMA_N >= N) return;
    fragment<matrix_a, WMMA_M, WMMA_N, WMMA_K, half, row_major> a_frag;
    fragment<matrix_b, WMMA_M, WMMA_N, WMMA_K, half, row_major> b_frag;
    fragment<accumulator, WMMA_M, WMMA_N, WMMA_K, float> c_frag;
    fill_fragment(c_frag, 0.0f);
    int a_row = warp_y * WMMA_M, b_col = warp_x * WMMA_N;
    __shared__ half sA[WMMA_M][WMMA_K + 1];  // 16x17 padding
    __shared__ half sB[WMMA_K][WMMA_N + 1];  // 16x17 padding
    for (int k = 0; k < K; k += WMMA_K) {
        int load_k = k + threadIdx.x;
        if (a_row + threadIdx.y < M && load_k < K) 
            sA[threadIdx.y][threadIdx.x] = A[(a_row + threadIdx.y) * K + load_k];
        else sA[threadIdx.y][threadIdx.x] = 0.0f;
        if (load_k < K && b_col + threadIdx.x < N) 
            sB[threadIdx.x][threadIdx.y] = B[load_k * N + (b_col + threadIdx.y)];
        else sB[threadIdx.x][threadIdx.y] = 0.0f;
        __syncthreads();
        load_matrix_sync(a_frag, &sA[0][0], WMMA_K + 1);
        load_matrix_sync(b_frag, &sB[0][0], WMMA_N + 1);
        mma_sync(c_frag, a_frag, b_frag, c_frag);
        __syncthreads();
    }
    int c_row = warp_y * WMMA_M, c_col = warp_x * WMMA_N;
    if (c_row < M && c_col < N) store_matrix_sync(C + c_row * N + c_col, c_frag, N, mem_row_major);
}
