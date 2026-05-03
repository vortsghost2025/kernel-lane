/*
* Optimized CUDA kernel for batch token embedding & attention
* Ported to SM 120 (Blackwell) with WMMA tensor-core matmul
* Compile: nvcc -arch=sm_120 -O3 -o inference_kernel inference_kernel.cu
*/

#include <cuda_runtime.h>
#include <device_launch_parameters.h>
#include <stdio.h>

#define BLOCK_SIZE 256
#define WARP_SIZE 32

/**
 * Batch embedding lookup kernel
 */
__global__ void batch_embed_lookup(
    const int* __restrict__ token_ids,
    const float* __restrict__ embedding_table,
    float* __restrict__ embeddings,
    int batch_size,
    int seq_len,
    int vocab_size,
    int embed_dim
) {
    int idx = blockIdx.x * blockDim.x + threadIdx.x;
    int total_tokens = batch_size * seq_len;
    
    if (idx >= total_tokens * embed_dim) return;
    
    int token_idx = idx / embed_dim;
    int embed_idx = idx % embed_dim;
    
    int token_id = token_ids[token_idx];
    if (token_id < 0 || token_id >= vocab_size) {
        embeddings[idx] = 0.0f;
        return;
    }
    
    embeddings[idx] = embedding_table[token_id * embed_dim + embed_idx];
}

/**
 * Fused layer norm kernel — one block per row for proper reduction.
 * Computes: y = (x - mean) / sqrt(var + eps) * weight + bias
 */
__global__ void fused_layer_norm(
    const float* __restrict__ input,
    const float* __restrict__ weight,
    const float* __restrict__ bias,
    float* __restrict__ output,
    int N,
    int hidden_size,
    float eps
) {
    int row = blockIdx.x;
    if (row >= N) return;

    int tid = threadIdx.x;

    // Shared memory for reduction
    extern __shared__ float shared[];
    float* s_sum = shared;
    float* s_var = &shared[blockDim.x];

    // Phase 1: Compute mean
    float thread_sum = 0.0f;
    for (int i = tid; i < hidden_size; i += blockDim.x) {
        thread_sum += input[row * hidden_size + i];
    }
    s_sum[tid] = thread_sum;
    __syncthreads();

    // Block reduction for sum
    for (int s = blockDim.x / 2; s > 0; s >>= 1) {
        if (tid < s) {
            s_sum[tid] += s_sum[tid + s];
        }
        __syncthreads();
    }
    float mean = s_sum[0] / (float)hidden_size;
    __syncthreads();

    // Phase 2: Compute variance
    float thread_var = 0.0f;
    for (int i = tid; i < hidden_size; i += blockDim.x) {
        float d = input[row * hidden_size + i] - mean;
        thread_var += d * d;
    }
    s_var[tid] = thread_var;
    __syncthreads();

    for (int s = blockDim.x / 2; s > 0; s >>= 1) {
        if (tid < s) {
            s_var[tid] += s_var[tid + s];
        }
        __syncthreads();
    }
    float variance = s_var[0] / (float)hidden_size;
    float inv_std = rsqrtf(variance + eps);
    __syncthreads();

    // Phase 3: Normalize and apply affine
    for (int i = tid; i < hidden_size; i += blockDim.x) {
        float normalized = (input[row * hidden_size + i] - mean) * inv_std;
        output[row * hidden_size + i] = normalized * weight[i] + bias[i];
    }
}

/**
 * Softmax kernel (for attention scores)
 * Numerically stable implementation
 */
__global__ void batch_softmax(
    float* __restrict__ scores,
    int batch_size,
    int seq_len
) {
    int row = blockIdx.x * blockDim.x + threadIdx.x;
    int total_rows = batch_size * seq_len;

    if (row >= total_rows) return;
    if (seq_len <= 0) return;

    float max_val = -3.402823466e+38f; // -FLT_MAX

    // Find max for numerical stability
    for (int i = 0; i < seq_len; i++) {
        float v = scores[row * seq_len + i];
        if (v > max_val) max_val = v;
    }

    // Compute exp and sum
    float sum_exp = 0.0f;
    for (int i = 0; i < seq_len; i++) {
        float exp_val = expf(scores[row * seq_len + i] - max_val);
        scores[row * seq_len + i] = exp_val;
        sum_exp += exp_val;
    }

    // Normalize (guard against divide-by-zero)
    if (sum_exp == 0.0f) sum_exp = 1e-6f;
    for (int i = 0; i < seq_len; i++) {
        scores[row * seq_len + i] /= sum_exp;
    }
}

/**
 * Naive matrix multiply: C = A @ B
 * A: [M, K], B: [K, N], C: [M, N]
 * NOTE: This is a naive implementation. For production use, consider cuBLAS or a tiled kernel.
 */
__global__ void naive_matmul(
    const float* __restrict__ A,
    const float* __restrict__ B,
    float* __restrict__ C,
    int M, int K, int N
) {
    int row = blockIdx.y * blockDim.y + threadIdx.y;
    int col = blockIdx.x * blockDim.x + threadIdx.x;
    
    if (row >= M || col >= N) return;
    
    float sum = 0.0f;
    for (int k = 0; k < K; k++) {
        sum += A[row * K + k] * B[k * N + col];
    }
    C[row * N + col] = sum;
}

#include <cuda_fp16.h>
#include <mma.h>
#include <cstdio>
#include <chrono>

using namespace nvcuda::wmma;

#define INF_WMMA_M 16
#define INF_WMMA_N 16
#define INF_WMMA_K 16
#define INF_WARPS_PER_BLOCK 8

__global__ void inference_wmma_matmul(
    const half* __restrict__ A, const half* __restrict__ B,
    float* __restrict__ C, int M, int N, int K)
{
    const int warp_local = threadIdx.y;
    const int warp_global_y = blockIdx.y * blockDim.y + warp_local;
    const int warp_global_x = blockIdx.x;
    const int tile_m = warp_global_y * INF_WMMA_M;
    const int tile_n = warp_global_x * INF_WMMA_N;
    if (tile_m >= M || tile_n >= N) return;

    extern __shared__ half shmem[];
    constexpr int aStride = INF_WMMA_M * INF_WMMA_K;
    constexpr int bStride = INF_WMMA_K * INF_WMMA_N;
    constexpr int warpSharedHalfCount = 2 * (aStride + bStride);
    half* warpShmem = shmem + warp_local * warpSharedHalfCount;
    half* sA = warpShmem;
    half* sB = warpShmem + 2 * aStride;

    fragment<matrix_a, INF_WMMA_M, INF_WMMA_N, INF_WMMA_K, half, row_major> a_frag;
    fragment<matrix_b, INF_WMMA_M, INF_WMMA_N, INF_WMMA_K, half, row_major> b_frag;
    fragment<accumulator, INF_WMMA_M, INF_WMMA_N, INF_WMMA_K, float> c_frag;
    fill_fragment(c_frag, 0.0f);

    int buf = 0;
    for (int i = threadIdx.x; i < INF_WMMA_M * (INF_WMMA_K / 2); i += 32) {
        const int row = i / (INF_WMMA_K / 2);
        const int col2 = i % (INF_WMMA_K / 2);
        const int col = col2 * 2;
        half2 v = __floats2half2_rn(0.0f, 0.0f);
        if (tile_m + row < M && col + 1 < K)
            v = reinterpret_cast<const half2*>(A + (tile_m + row) * K + col)[0];
        half* rowPtr = sA + buf * aStride + row * INF_WMMA_K;
        rowPtr[col] = __low2half(v);
        rowPtr[col + 1] = __high2half(v);
    }
    for (int i = threadIdx.x; i < INF_WMMA_K * (INF_WMMA_N / 2); i += 32) {
        const int row = i / (INF_WMMA_N / 2);
        const int col2 = i % (INF_WMMA_N / 2);
        const int col = col2 * 2;
        half2 v = __floats2half2_rn(0.0f, 0.0f);
        if (row < K && tile_n + col + 1 < N)
            v = reinterpret_cast<const half2*>(B + row * N + tile_n + col)[0];
        half* rowPtr = sB + buf * bStride + row * INF_WMMA_N;
        rowPtr[col] = __low2half(v);
        rowPtr[col + 1] = __high2half(v);
    }
    __syncthreads();

    for (int k0 = 0; k0 < K; k0 += INF_WMMA_K) {
        load_matrix_sync(a_frag, sA + buf * aStride, INF_WMMA_K);
        load_matrix_sync(b_frag, sB + buf * bStride, INF_WMMA_N);
        mma_sync(c_frag, a_frag, b_frag, c_frag);
        buf ^= 1;
        if (k0 + INF_WMMA_K < K) {
            const int k_next = k0 + INF_WMMA_K;
            for (int i = threadIdx.x; i < INF_WMMA_M * (INF_WMMA_K / 2); i += 32) {
                const int row = i / (INF_WMMA_K / 2);
                const int col2 = i % (INF_WMMA_K / 2);
                const int col = col2 * 2;
                half2 v = __floats2half2_rn(0.0f, 0.0f);
                if (tile_m + row < M && col + k_next + 1 < K)
                    v = reinterpret_cast<const half2*>(A + (tile_m + row) * K + (col + k_next))[0];
                half* rowPtr = sA + buf * aStride + row * INF_WMMA_K;
                rowPtr[col] = __low2half(v);
                rowPtr[col + 1] = __high2half(v);
            }
            for (int i = threadIdx.x; i < INF_WMMA_K * (INF_WMMA_N / 2); i += 32) {
                const int row = i / (INF_WMMA_N / 2);
                const int col2 = i % (INF_WMMA_N / 2);
                const int col = col2 * 2;
                half2 v = __floats2half2_rn(0.0f, 0.0f);
                if (k_next + row < K && tile_n + col + 1 < N)
                    v = reinterpret_cast<const half2*>(B + (k_next + row) * N + (tile_n + col))[0];
                half* rowPtr = sB + buf * bStride + row * INF_WMMA_N;
                rowPtr[col] = __low2half(v);
                rowPtr[col + 1] = __high2half(v);
            }
            __syncthreads();
        }
    }
    store_matrix_sync(C + static_cast<size_t>(tile_m) * N + tile_n,
                      c_frag, N, mem_row_major);
}

/**
 * Host wrapper: batch embedding lookup
 */
extern "C" {
    int cuda_embed_lookup(
        int* token_ids,
        float* embedding_table,
        float* embeddings,
        int batch_size,
        int seq_len,
        int vocab_size,
        int embed_dim
    ) {
        int total_tokens = batch_size * seq_len;
        int grid_size = (total_tokens * embed_dim + BLOCK_SIZE - 1) / BLOCK_SIZE;
        
        batch_embed_lookup<<<grid_size, BLOCK_SIZE>>>(
            token_ids, embedding_table, embeddings,
            batch_size, seq_len, vocab_size, embed_dim
        );
        
        cudaError_t err = cudaGetLastError();
        if (err != cudaSuccess) {
            printf("CUDA error: %s\n", cudaGetErrorString(err));
            return -1;
        }
        return 0;
    }
    
    int cuda_layer_norm(
        float* input,
        float* weight,
        float* bias,
        float* output,
        int N,
        int hidden_size,
        float eps
    ) {
        // One block per row, BLOCK_SIZE threads per block
        int threads = BLOCK_SIZE;
        int shared_mem = 2 * threads * sizeof(float);
        
        fused_layer_norm<<<N, threads, shared_mem>>>(
            input, weight, bias, output,
            N, hidden_size, eps
        );
        
        cudaError_t err = cudaGetLastError();
        if (err != cudaSuccess) {
            printf("CUDA error: %s\n", cudaGetErrorString(err));
            return -1;
        }
        return 0;
    }
    
    int cuda_softmax(float* scores, int batch_size, int seq_len) {
        int grid_size = (batch_size * seq_len + BLOCK_SIZE - 1) / BLOCK_SIZE;
        batch_softmax<<<grid_size, BLOCK_SIZE>>>(scores, batch_size, seq_len);
        
        cudaError_t err = cudaGetLastError();
        if (err != cudaSuccess) {
            printf("CUDA error: %s\n", cudaGetErrorString(err));
            return -1;
        }
        return 0;
    }
    
int cuda_matmul(float* A, float* B, float* C, int M, int K, int N) {
    dim3 block(16, 16);
    dim3 grid((N + 15) / 16, (M + 15) / 16);

    naive_matmul<<<grid, block>>>(A, B, C, M, K, N);

    cudaError_t err = cudaGetLastError();
    if (err != cudaSuccess) {
        printf("CUDA error: %s\n", cudaGetErrorString(err));
        return -1;
    }
    return 0;
}
}

// =========================================================================
// Benchmark main
// =========================================================================
int main() {
    int device;
    cudaGetDevice(&device);
    cudaDeviceProp prop;
    cudaGetDeviceProperties(&prop, device);
    std::printf("=== Inference Kernel Benchmark (SM 120) ===\n");
    std::printf("GPU: %s\n", prop.name);
    std::printf("SM count: %d\n\n", prop.multiProcessorCount);

    // --- Embedding lookup benchmark ---
    {
        const int batch = 32, seq = 128, vocab = 32000, dim = 768;
        const int total_tokens = batch * seq;
        size_t emb_bytes = (size_t)vocab * dim * sizeof(float);
        size_t out_bytes = (size_t)total_tokens * dim * sizeof(float);
        size_t id_bytes = total_tokens * sizeof(int);

        float *d_table, *d_emb;
        int *d_ids;
        cudaMalloc(&d_table, emb_bytes);
        cudaMalloc(&d_emb, out_bytes);
        cudaMalloc(&d_ids, id_bytes);
        cudaMemset(d_table, 0, emb_bytes);
        cudaMemset(d_ids, 0, id_bytes);

        int grid = (total_tokens * dim + BLOCK_SIZE - 1) / BLOCK_SIZE;

        batch_embed_lookup<<<grid, BLOCK_SIZE>>>(d_ids, d_table, d_emb, batch, seq, vocab, dim);
        cudaDeviceSynchronize();

        cudaEvent_t s, e;
        cudaEventCreate(&s); cudaEventCreate(&e);
        cudaEventRecord(s);
        for (int i = 0; i < 100; ++i)
            batch_embed_lookup<<<grid, BLOCK_SIZE>>>(d_ids, d_table, d_emb, batch, seq, vocab, dim);
        cudaEventRecord(e);
        cudaEventSynchronize(e);
        float ms = 0; cudaEventElapsedTime(&ms, s, e);
        std::printf("batch_embed_lookup (batch=%d seq=%d dim=%d): %.3f ms/iter\n",
                    batch, seq, dim, ms / 100.0f);
        cudaEventDestroy(s); cudaEventDestroy(e);
        cudaFree(d_table); cudaFree(d_emb); cudaFree(d_ids);
    }

    // --- Layer norm benchmark ---
    {
        const int rows = 32768, hidden = 768;
        size_t bytes = (size_t)rows * hidden * sizeof(float);
        float *d_in, *d_w, *d_b, *d_out;
        cudaMalloc(&d_in, bytes); cudaMalloc(&d_w, hidden * sizeof(float));
        cudaMalloc(&d_b, hidden * sizeof(float)); cudaMalloc(&d_out, bytes);
        cudaMemset(d_in, 0, bytes);

        int threads = BLOCK_SIZE;
        int shared_mem = 2 * threads * sizeof(float);

        fused_layer_norm<<<rows, threads, shared_mem>>>(d_in, d_w, d_b, d_out, rows, hidden, 1e-5f);
        cudaDeviceSynchronize();

        cudaEvent_t s, e;
        cudaEventCreate(&s); cudaEventCreate(&e);
        cudaEventRecord(s);
        for (int i = 0; i < 100; ++i)
            fused_layer_norm<<<rows, threads, shared_mem>>>(d_in, d_w, d_b, d_out, rows, hidden, 1e-5f);
        cudaEventRecord(e);
        cudaEventSynchronize(e);
        float ms = 0; cudaEventElapsedTime(&ms, s, e);
        std::printf("fused_layer_norm (rows=%d hidden=%d): %.3f ms/iter\n",
                    rows, hidden, ms / 100.0f);
        cudaEventDestroy(s); cudaEventDestroy(e);
        cudaFree(d_in); cudaFree(d_w); cudaFree(d_b); cudaFree(d_out);
    }

    // --- WMMA matmul benchmark (inference-typical sizes) ---
    {
        const int M = 32, N = 768, K = 768;
        size_t a_bytes = (size_t)M * K * sizeof(half);
        size_t b_bytes = (size_t)K * N * sizeof(half);
        size_t c_bytes = (size_t)M * N * sizeof(float);
        half *dA, *dB; float *dC;
        cudaMalloc(&dA, a_bytes); cudaMalloc(&dB, b_bytes); cudaMalloc(&dC, c_bytes);
        cudaMemset(dA, 0, a_bytes); cudaMemset(dB, 0, b_bytes);

        dim3 block(32, INF_WARPS_PER_BLOCK, 1);
        dim3 grid((N + INF_WMMA_N - 1) / INF_WMMA_N,
                  ((M + INF_WMMA_M - 1) / INF_WMMA_M + INF_WARPS_PER_BLOCK - 1) / INF_WARPS_PER_BLOCK, 1);
        constexpr size_t aStride = INF_WMMA_M * INF_WMMA_K;
        constexpr size_t bStride = INF_WMMA_K * INF_WMMA_N;
        size_t sharedBytes = (size_t)INF_WARPS_PER_BLOCK * 2 * (aStride + bStride) * sizeof(half);

        inference_wmma_matmul<<<grid, block, sharedBytes>>>(dA, dB, dC, M, N, K);
        cudaDeviceSynchronize();

        cudaEvent_t s, e;
        cudaEventCreate(&s); cudaEventCreate(&e);
        cudaEventRecord(s);
        for (int i = 0; i < 1000; ++i)
            inference_wmma_matmul<<<grid, block, sharedBytes>>>(dA, dB, dC, M, N, K);
        cudaEventRecord(e);
        cudaEventSynchronize(e);
        float ms = 0; cudaEventElapsedTime(&ms, s, e);
        double flops = 2.0 * M * N * K;
        double tflops = flops / (ms / 1000.0 / 1000.0) / 1e12;
        std::printf("inference_wmma_matmul (%dx%dx%d): %.3f us/iter (%.2f TFLOPS)\n",
                    M, N, K, ms * 1000.0f / 1000.0f, tflops);
        cudaEventDestroy(s); cudaEventDestroy(e);
        cudaFree(dA); cudaFree(dB); cudaFree(dC);
    }

    // --- Naive vs WMMA at 1024^3 ---
    {
        const int M = 1024, N = 1024, K = 1024;
        size_t a_bytes = (size_t)M * K * sizeof(float);
        size_t b_bytes = (size_t)K * N * sizeof(float);
        size_t c_bytes = (size_t)M * N * sizeof(float);
        float *dA, *dB, *dC;
        cudaMalloc(&dA, a_bytes); cudaMalloc(&dB, b_bytes); cudaMalloc(&dC, c_bytes);
        cudaMemset(dA, 0, a_bytes); cudaMemset(dB, 0, b_bytes);

        dim3 naive_block(16, 16);
        dim3 naive_grid((N + 15) / 16, (M + 15) / 16);

        naive_matmul<<<naive_grid, naive_block>>>(dA, dB, dC, M, K, N);
        cudaDeviceSynchronize();

        cudaEvent_t s, e;
        cudaEventCreate(&s); cudaEventCreate(&e);
        cudaEventRecord(s);
        for (int i = 0; i < 10; ++i)
            naive_matmul<<<naive_grid, naive_block>>>(dA, dB, dC, M, K, N);
        cudaEventRecord(e);
        cudaEventSynchronize(e);
        float ms_naive = 0; cudaEventElapsedTime(&ms_naive, s, e);
        std::printf("naive_matmul (%dx%dx%d): %.3f ms/iter\n", M, N, K, ms_naive / 10.0f);

        size_t a16 = (size_t)M * K * sizeof(half);
        size_t b16 = (size_t)K * N * sizeof(half);
        half *dA16, *dB16;
        cudaMalloc(&dA16, a16); cudaMalloc(&dB16, b16);
        cudaMemset(dA16, 0, a16); cudaMemset(dB16, 0, b16);

        dim3 wmma_block(32, INF_WARPS_PER_BLOCK, 1);
        dim3 wmma_grid((N + INF_WMMA_N - 1) / INF_WMMA_N,
                       ((M + INF_WMMA_M - 1) / INF_WMMA_M + INF_WARPS_PER_BLOCK - 1) / INF_WARPS_PER_BLOCK, 1);
        constexpr size_t aStride = INF_WMMA_M * INF_WMMA_K;
        constexpr size_t bStride = INF_WMMA_K * INF_WMMA_N;
        size_t sharedBytes = (size_t)INF_WARPS_PER_BLOCK * 2 * (aStride + bStride) * sizeof(half);

        inference_wmma_matmul<<<wmma_grid, wmma_block, sharedBytes>>>(dA16, dB16, dC, M, N, K);
        cudaDeviceSynchronize();
        cudaEventRecord(s);
        for (int i = 0; i < 10; ++i)
            inference_wmma_matmul<<<wmma_grid, wmma_block, sharedBytes>>>(dA16, dB16, dC, M, N, K);
        cudaEventRecord(e);
        cudaEventSynchronize(e);
        float ms_wmma = 0; cudaEventElapsedTime(&ms_wmma, s, e);
        double flops = 2.0 * M * N * K;
        double tflops = flops / (ms_wmma / 10.0 / 1000.0) / 1e12;
        std::printf("inference_wmma_matmul (%dx%dx%d): %.3f ms/iter (%.2f TFLOPS, %.1fx vs naive)\n",
                    M, N, K, ms_wmma / 10.0f, tflops, ms_naive / ms_wmma);

        cudaEventDestroy(s); cudaEventDestroy(e);
        cudaFree(dA); cudaFree(dB); cudaFree(dC);
        cudaFree(dA16); cudaFree(dB16);
    }

    return 0;
}
