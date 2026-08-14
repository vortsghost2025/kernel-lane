#include <cuda_runtime.h>
#include <iostream>
#include <cstdlib>
#include <cmath>
#include <cstring>
#include <vector>
#include <cstdio>

#define BLOCK_SIZE 16
#define THREAD_TILE_M 4
#define THREAD_TILE_N 4
#define BK 16  // Tile size in K dimension

template <bool K_aligned, bool N_aligned>
__global__ void register_tiled_gemm(const float* __restrict__ A, const float* __restrict__ B, float* __restrict__ C, int M, int N, int K) {
    // Block index
    int bx = blockIdx.x, by = blockIdx.y;
    // Thread index
    int tx = threadIdx.x, ty = threadIdx.y;

    // Calculate the starting row and column of the tile that this block is responsible for
    int row_start = by * BLOCK_SIZE * THREAD_TILE_M;
    int col_start = bx * BLOCK_SIZE * THREAD_TILE_N;

    // Allocate shared memory for tiles of A and B
    // AsT: [BK][BLOCK_SIZE * THREAD_TILE_M]  (transposed: AsT[k][row])
    // Bs: [BK][BLOCK_SIZE * THREAD_TILE_N]
    __shared__ float AsT[BK][BLOCK_SIZE * THREAD_TILE_M];
    __shared__ float Bs[BK][BLOCK_SIZE * THREAD_TILE_N];

    // Allocate registers for the thread's tile of C
    float C_local[THREAD_TILE_M][THREAD_TILE_N] = {{0.0f}};

    // Loop over K in tiles of BK
    for (int k_base = 0; k_base < K; k_base += BK) {
        int k_end = k_base + BK;
        if (k_end > K) k_end = K;
        int k_valid = k_end - k_base;

        // Load tile of A into shared memory AsT using float4 vectorized loads
        // AsT: [16 k rows][64 tile rows]. 256 threads: 4 threads per row, each loads float4 (4 k values)
        int tid = ty * BLOCK_SIZE + tx;  // linear thread index in the block [0, 255]
        int row_in_tile_A = tid / 4;           // row in A tile [0, 63]
        int lane_in_row_A = tid % 4;           // which float4 chunk in this row [0, 3]
        int k_base_in_tile_A = lane_in_row_A * 4; // k offset [0, 4, 8, 12]
        int global_row_A = row_start + row_in_tile_A;
        int global_col_A = k_base + k_base_in_tile_A;
        if (global_row_A < M && global_col_A + 3 < K) {
            const float* a_src = &A[global_row_A * K + global_col_A];
            if (K_aligned) {
                // 16-byte aligned guaranteed: fast float4 path
                float4 a_vec = *reinterpret_cast<const float4*>(a_src);
                AsT[k_base_in_tile_A + 0][row_in_tile_A] = a_vec.x;
                AsT[k_base_in_tile_A + 1][row_in_tile_A] = a_vec.y;
                AsT[k_base_in_tile_A + 2][row_in_tile_A] = a_vec.z;
                AsT[k_base_in_tile_A + 3][row_in_tile_A] = a_vec.w;
            } else {
                // Potential unaligned: scalar fallback
                for (int k = 0; k < 4; ++k) {
                    AsT[k_base_in_tile_A + k][row_in_tile_A] = a_src[k];
                }
            }
        } else if (global_row_A < M) {
            // Handle boundary: scalar fallback for last tile
            for (int k = 0; k < 4; ++k) {
                int gc = global_col_A + k;
                AsT[k_base_in_tile_A + k][row_in_tile_A] = (gc < K) ? A[global_row_A * K + gc] : 0.0f;
            }
        } else {
            AsT[k_base_in_tile_A + 0][row_in_tile_A] = 0.0f;
            AsT[k_base_in_tile_A + 1][row_in_tile_A] = 0.0f;
            AsT[k_base_in_tile_A + 2][row_in_tile_A] = 0.0f;
            AsT[k_base_in_tile_A + 3][row_in_tile_A] = 0.0f;
        }

        // Load tile of B into shared memory Bs using float4 vectorized loads
        // Bs tile: [16 rows][64 cols]. 256 threads: 16 threads per row, each loads float4 (4 elements)
        int k_in_tile_B = tid / 16;           // row in B tile [0, 15]
        int lane_in_row_B = tid % 16;         // which float4 chunk in this row [0, 15]
        int col_base_in_tile_B = lane_in_row_B * 4; // column offset [0, 4, ..., 60]
        int global_row_B = k_base + k_in_tile_B;
        int global_col_B = col_start + col_base_in_tile_B;
        if (global_row_B < K && global_col_B + 3 < N) {
            const float* b_src = &B[global_row_B * N + global_col_B];
            if (N_aligned) {
                // 16-byte aligned guaranteed: fast float4 path
                float4 b_vec = *reinterpret_cast<const float4*>(b_src);
                Bs[k_in_tile_B][col_base_in_tile_B + 0] = b_vec.x;
                Bs[k_in_tile_B][col_base_in_tile_B + 1] = b_vec.y;
                Bs[k_in_tile_B][col_base_in_tile_B + 2] = b_vec.z;
                Bs[k_in_tile_B][col_base_in_tile_B + 3] = b_vec.w;
            } else {
                // Potential unaligned: scalar fallback
                for (int c = 0; c < 4; ++c) {
                    Bs[k_in_tile_B][col_base_in_tile_B + c] = b_src[c];
                }
            }
        } else if (global_row_B < K) {
            for (int c = 0; c < 4; ++c) {
                int gc = global_col_B + c;
                Bs[k_in_tile_B][col_base_in_tile_B + c] = (gc < N) ? B[global_row_B * N + gc] : 0.0f;
            }
        } else {
            Bs[k_in_tile_B][col_base_in_tile_B + 0] = 0.0f;
            Bs[k_in_tile_B][col_base_in_tile_B + 1] = 0.0f;
            Bs[k_in_tile_B][col_base_in_tile_B + 2] = 0.0f;
            Bs[k_in_tile_B][col_base_in_tile_B + 3] = 0.0f;
        }

        __syncthreads();

        // Now compute the product for this thread's tile
        // Each thread (ty, tx) is responsible for a tile of C:
        //   rows: [row_start + ty * THREAD_TILE_M, row_start + (ty+1) * THREAD_TILE_M)
        //   cols: [col_start + tx * THREAD_TILE_N, col_start + (tx+1) * THREAD_TILE_N)
        for (int k = 0; k < k_valid; ++k) {
            // AsT[k][ty*THREAD_TILE_M + 0..3] are contiguous -> 128-bit A shared load opportunity
            for (int i = 0; i < THREAD_TILE_M; ++i) {
                float a_val = AsT[k][ty * THREAD_TILE_M + i];
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

    // Check alignment: cudaMalloc guarantees 128-byte alignment.
    // A rows are aligned if K % 4 == 0 (stride in floats is K).
    // B rows are aligned if N % 4 == 0 (stride in floats is N).
    bool K_aligned = (K % 4 == 0);
    bool N_aligned = (N % 4 == 0);

    if (K_aligned && N_aligned) {
        register_tiled_gemm<true, true><<<grid, block>>>(A, B, C, M, N, K);
    } else if (K_aligned && !N_aligned) {
        register_tiled_gemm<true, false><<<grid, block>>>(A, B, C, M, N, K);
    } else if (!K_aligned && N_aligned) {
        register_tiled_gemm<false, true><<<grid, block>>>(A, B, C, M, N, K);
    } else {
        register_tiled_gemm<false, false><<<grid, block>>>(A, B, C, M, N, K);
    }
    cudaDeviceSynchronize();
}

static void cpu_gemm_f32(const float* A, const float* B, float* C, int M, int N, int K) {
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

static int run_correctness_shape(int M, int N, int K, const char* label) {
    const size_t nA = static_cast<size_t>(M) * K;
    const size_t nB = static_cast<size_t>(K) * N;
    const size_t nC = static_cast<size_t>(M) * N;

    std::vector<float> hA(nA), hB(nB), hC_ref(nC, 0.0f), hC_gpu(nC, 0.0f);
    std::srand(1337);
    for (size_t i = 0; i < nA; ++i) hA[i] = (std::rand() / static_cast<float>(RAND_MAX)) * 2.0f - 1.0f;
    for (size_t i = 0; i < nB; ++i) hB[i] = (std::rand() / static_cast<float>(RAND_MAX)) * 2.0f - 1.0f;

    cpu_gemm_f32(hA.data(), hB.data(), hC_ref.data(), M, N, K);

    float *dA = nullptr, *dB = nullptr, *dC = nullptr;
    cudaError_t allocErr = cudaSuccess;
    allocErr = cudaMalloc(&dA, nA * sizeof(float));
    if (allocErr == cudaSuccess) allocErr = cudaMalloc(&dB, nB * sizeof(float));
    if (allocErr == cudaSuccess) allocErr = cudaMalloc(&dC, nC * sizeof(float));
    if (allocErr != cudaSuccess) {
        std::cerr << "[CORRECTNESS] allocation failed: " << cudaGetErrorString(allocErr) << "\n";
        cudaFree(dA); cudaFree(dB); cudaFree(dC);
        return 1;
    }
    cudaMemcpy(dA, hA.data(), nA * sizeof(float), cudaMemcpyHostToDevice);
    cudaMemcpy(dB, hB.data(), nB * sizeof(float), cudaMemcpyHostToDevice);
    cudaMemset(dC, 0, nC * sizeof(float));
    launch_register_tiled_gemm(dA, dB, dC, M, N, K);
    cudaError_t err = cudaDeviceSynchronize();
    if (err != cudaSuccess) {
        std::cerr << "[CORRECTNESS] " << label << " kernel failed: " << cudaGetErrorString(err) << "\n";
        cudaFree(dA); cudaFree(dB); cudaFree(dC);
        return 1;
    }
    cudaMemcpy(hC_gpu.data(), dC, nC * sizeof(float), cudaMemcpyDeviceToHost);
    cudaFree(dA); cudaFree(dB); cudaFree(dC);

    const float rel_tol = 0.01f;
    const float abs_tol = 1e-3f;
    const float near_zero = 1e-3f;
    float max_rel = 0.0f, max_abs = 0.0f;
    int outliers = 0, rel_count = 0, abs_count = 0;
    for (size_t i = 0; i < nC; ++i) {
        float ref = hC_ref[i];
        float cmp = hC_gpu[i];
        float a = std::fabs(cmp - ref);
        if (std::fabs(ref) < near_zero) {
            abs_count++;
            if (a > max_abs) max_abs = a;
            if (a > abs_tol) outliers++;
        } else {
            rel_count++;
            float r = a / std::fabs(ref);
            if (r > max_rel) max_rel = r;
            if (r > rel_tol) outliers++;
        }
    }
    bool pass = (outliers == 0);
    std::printf("[CORRECTNESS] %-20s max_rel=%.6f max_abs=%.6f rel=%d abs=%d outliers=%d/%zu => %s\n",
                label, max_rel, max_abs, rel_count, abs_count, outliers, nC,
                pass ? "PASS" : "FAIL");
    return pass ? 0 : 1;
}

static int run_correctness_test() {
    return run_correctness_shape(256, 256, 256, "register_tiled_gemm");
}

// Correctness + optional timing
int main(int argc, char* argv[]) {
    bool skip_timing = (argc > 1 && std::strcmp(argv[1], "--correctness-only") == 0);
    bool timing_only = (argc > 1 && std::strcmp(argv[1], "--timing-only") == 0);

    // --test-shape M N K: validate the production kernel at an arbitrary shape
    if (argc == 5 && std::strcmp(argv[1], "--test-shape") == 0) {
        int M = std::atoi(argv[2]);
        int N = std::atoi(argv[3]);
        int K = std::atoi(argv[4]);
        if (M <= 0 || N <= 0 || K <= 0) {
            std::cerr << "[CORRECTNESS] invalid shape\n";
            return 2;
        }
        char label[64];
        std::snprintf(label, sizeof(label), "M%d_N%d_K%d", M, N, K);
        return run_correctness_shape(M, N, K, label);
    }

    if (!timing_only) {
        int correctness_result = run_correctness_test();
        if (correctness_result != 0) {
            std::cerr << "[CORRECTNESS] FAILED, skipping timing\n";
            return correctness_result;
        }
    }
    if (skip_timing) {
        return 0;
    }

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

    // Timing (correctness already validated at 256 above).
    // The correctness block handled the CPU reference check; this block only measures.

    cudaFree(d_A); cudaFree(d_B); cudaFree(d_C);
    free(h_A); free(h_B); free(h_C);
    return 0;
}