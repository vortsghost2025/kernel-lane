#include <cuda_runtime.h>
#include <iostream>

#define BLOCK_SIZE 16
#define THREAD_TILE_M 4
#define THREAD_TILE_N 4
#define BK 16  // Tile size in K dimension

__global__ void register_tiled_gemm(const float* __restrict__ A, const float* __restrict__ B, float* __restrict__ C, int M, int N, int K) {
    // Block index
    int bx = blockIdx.x, by = blockIdx.y;
    // Thread index
    int tx = threadIdx.x, ty = threadIdx.y;

    // Calculate the starting row and column of the tile that this block is responsible for
    int row_start = by * BLOCK_SIZE * THREAD_TILE_M;
    int col_start = bx * BLOCK_SIZE * THREAD_TILE_N;

    // Allocate shared memory for tiles of A and B
    // As: [BLOCK_SIZE * THREAD_TILE_M][BK]
    // Bs: [BK][BLOCK_SIZE * THREAD_TILE_N]
    __shared__ float As[BLOCK_SIZE * THREAD_TILE_M][BK];
    __shared__ float Bs[BK][BLOCK_SIZE * THREAD_TILE_N];

    // Allocate registers for the thread's tile of C
    float C_local[THREAD_TILE_M][THREAD_TILE_N] = {{0.0f}};

    // Loop over K in tiles of BK
    for (int k_base = 0; k_base < K; k_base += BK) {
        int k_end = k_base + BK;
        if (k_end > K) k_end = K;
        int k_valid = k_end - k_base;

        // Load tile of A into shared memory As
        // We need to load a tile of size [BLOCK_SIZE * THREAD_TILE_M, BK]
        // We'll have the threads in the block load this tile in a coalesced manner.
        // Each thread will load multiple elements if necessary.
        int num_elements_A = BLOCK_SIZE * THREAD_TILE_M * BK;
        int tid = ty * BLOCK_SIZE + tx;  // linear thread index in the block
        for (int idx = tid; idx < num_elements_A; idx += blockDim.x * blockDim.y) {
            int row_in_tile = idx / (BK);  // row in the A tile [0, BLOCK_SIZE*THREAD_TILE_M)
            int k_in_tile = idx % BK;      // column in the A tile [0, BK)
            int global_row = row_start + row_in_tile;
            int global_col = k_base + k_in_tile;
            if (global_row < M && global_col < K) {
                As[row_in_tile][k_in_tile] = A[global_row * K + global_col];
            } else {
                As[row_in_tile][k_in_tile] = 0.0f;
            }
        }

        // Load tile of B into shared memory Bs
        // We need to load a tile of size [BK, BLOCK_SIZE * THREAD_TILE_N]
        int num_elements_B = BK * BLOCK_SIZE * THREAD_TILE_N;
        for (int idx = tid; idx < num_elements_B; idx += blockDim.x * blockDim.y) {
            int k_in_tile = idx / (BLOCK_SIZE * THREAD_TILE_N);  // row in the B tile [0, BK)
            int col_in_tile = idx % (BLOCK_SIZE * THREAD_TILE_N); // column in the B tile [0, BLOCK_SIZE*THREAD_TILE_N)
            int global_row = k_base + k_in_tile;
            int global_col = col_start + col_in_tile;
            if (global_row < K && global_col < N) {
                Bs[k_in_tile][col_in_tile] = B[global_row * N + global_col];
            } else {
                Bs[k_in_tile][col_in_tile] = 0.0f;
            }
        }

        __syncthreads();

        // Now compute the product for this thread's tile
        // Each thread (ty, tx) is responsible for a tile of C:
        //   rows: [row_start + ty * THREAD_TILE_M, row_start + (ty+1) * THREAD_TILE_M)
        //   cols: [col_start + tx * THREAD_TILE_N, col_start + (tx+1) * THREAD_TILE_N)
        for (int k = 0; k < k_valid; ++k) {
            // Load a row segment of As and a column segment of Bs for this thread's tile
            // We can load the entire row segment of As and column segment of Bs into registers? 
            // Instead, we'll loop over the thread's tile and accumulate.
            for (int i = 0; i < THREAD_TILE_M; ++i) {
                float a_val = As[ty * THREAD_TILE_M + i][k];
                for (int j = 0; j < THREAD_TILE_N; ++j) {
                    float b_val = Bs[k][tx * THREAD_TILE_N + j];
                    C_local[i][j] += a_val * b_val;
                }
            }
        }

        __syncthreads();  // Make sure we are done with shared memory before loading the next tile
    }

    // Store the thread's tile of C to global memory
    for (int i = 0; i < THREAD_TILE_M; ++i) {
        for (int j = 0; j < THREAD_TILE_N; ++j) {
            int global_row = row_start + ty * THREAD_TILE_M + i;
            int global_col = col_start + tx * THREAD_TILE_N + j;
            if (global_row < M && global_col < N) {
                C[global_row * N + global_col] = C_local[i][j];
            }
        }
    }
}

// Host function to launch the kernel
void launch_register_tiled_gemm(float* A, float* B, float* C, int M, int N, int K) {
    dim3 block(BLOCK_SIZE, BLOCK_SIZE);
    dim3 grid((N + (BLOCK_SIZE * THREAD_TILE_N) - 1) / (BLOCK_SIZE * THREAD_TILE_N),
              (M + (BLOCK_SIZE * THREAD_TILE_M) - 1) / (BLOCK_SIZE * THREAD_TILE_M));

    register_tiled_gemm<<<grid, block>>>(A, B, C, M, N, K);
    cudaDeviceSynchronize();
}

// Simple test with random matrices
int main() {
    int M = 1024, N = 1024, K = 1024;
    size_t bytes_A = M * K * sizeof(float);
    size_t bytes_B = K * N * sizeof(float);
    size_t bytes_C = M * N * sizeof(float);
    float *h_A, *h_B, *h_C, *d_A, *d_B, *d_C;
    h_A = (float*)malloc(bytes_A);
    h_B = (float*)malloc(bytes_B);
    h_C = (float*)malloc(bytes_C);
    for (int i = 0; i < M * K; ++i) h_A[i] = rand() / (float)RAND_MAX;
    for (int i = 0; i < K * N; ++i) h_B[i] = rand() / (float)RAND_MAX;

    cudaMalloc(&d_A, bytes_A);
    cudaMalloc(&d_B, bytes_B);
    cudaMalloc(&d_C, bytes_C);
    cudaMemcpy(d_A, h_A, bytes_A, cudaMemcpyHostToDevice);
    cudaMemcpy(d_B, h_B, bytes_B, cudaMemcpyHostToDevice);

    // Warm-up
    launch_register_tiled_gemm(d_A, d_B, d_C, M, N, K);

    // Timing
    cudaEvent_t start, stop;
    cudaEventCreate(&start);
    cudaEventCreate(&stop);
    cudaEventRecord(start);
    launch_register_tiled_gemm(d_A, d_B, d_C, M, N, K);
    cudaEventRecord(stop);
    cudaEventSynchronize(stop);
    float ms = 0;
    cudaEventElapsedTime(&ms, start, stop);

    double flops = 2.0 * M * N * K;
    double tflops = flops / (ms / 1000.0) / 1e12;
    std::cout << "Register Tiled GEMM (" << M << "x" << N << "x" << K << "): "
              << ms << " ms, " << tflops << " TFLOPS\n";

    // Optional: copy back and check against a naive implementation (for small matrices)
    // For now, we just run and report time.

    cudaFree(d_A); cudaFree(d_B); cudaFree(d_C);
    free(h_A); free(h_B); free(h_C);
    return 0;
}