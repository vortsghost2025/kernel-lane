/*
 * Optimized CUDA kernel for batch token embedding & attention
 * Compile: nvcc -arch=sm_89 -O3 -o inference_kernel inference_kernel.cu
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
