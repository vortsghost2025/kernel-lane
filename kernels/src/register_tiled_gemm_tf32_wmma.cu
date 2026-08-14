#include <cuda_runtime.h>
#include <mma.h>
#include <iostream>
#include <cstdlib>
#include <cmath>
#include <cstring>
#include <cstdio>

#define WARP_SIZE 32
#define MMA_M 16
#define MMA_N 16
#define MMA_K 8

using namespace nvcuda::wmma;

__global__ void register_tiled_gemm_tf32_wmma(const float* __restrict__ A, const float* __restrict__ B, float* __restrict__ C, int M, int N, int K) {
    const int bx = blockIdx.x;
    const int by = blockIdx.y;
    const int tx = threadIdx.x;

    const int row_start = by * MMA_M;
    const int col_start = bx * MMA_N;

    __shared__ float As_shared[MMA_M][MMA_K];
    __shared__ float Bs_shared[MMA_N][MMA_K];  // Transposed for col_major: [N][K]

    fragment<matrix_a, MMA_M, MMA_N, MMA_K, precision::tf32, row_major> a_frag;
    fragment<matrix_b, MMA_M, MMA_N, MMA_K, precision::tf32, col_major> b_frag;
    fragment<accumulator, MMA_M, MMA_N, MMA_K, float> c_frag;
    fill_fragment(c_frag, 0.0f);

    for (int k_base = 0; k_base < K; k_base += MMA_K) {
        int k_end = k_base + MMA_K;
        if (k_end > K) k_end = K;
        int k_valid = k_end - k_base;

        if (k_valid == MMA_K) {
            int a_row = row_start;
            int a_col = k_base;
            if (a_row < M && a_col < K) {
                for (int i = tx; i < MMA_M * MMA_K; i += WARP_SIZE) {
                    int r = i / MMA_K;
                    int c = i % MMA_K;
                    As_shared[r][c] = __float_to_tf32(A[(a_row + r) * K + a_col + c]);
                }
            } else {
                for (int i = tx; i < MMA_M * MMA_K; i += WARP_SIZE) {
                    As_shared[i / MMA_K][i % MMA_K] = __float_to_tf32(0.0f);
                }
            }

            int b_row = k_base;
            int b_col = col_start;
            if (b_row < K && b_col < N) {
                for (int i = tx; i < MMA_K * MMA_N; i += WARP_SIZE) {
                    int r = i / MMA_N;
                    int c = i % MMA_N;
                    Bs_shared[c][r] = __float_to_tf32(B[(b_row + r) * N + b_col + c]);
                }
            } else {
                for (int i = tx; i < MMA_K * MMA_N; i += WARP_SIZE) {
                    Bs_shared[i % MMA_N][i / MMA_N] = __float_to_tf32(0.0f);
                }
            }
        } else {
            for (int i = tx; i < MMA_M * MMA_K; i += WARP_SIZE) {
                int r = i / MMA_K;
                int c = i % MMA_K;
                int gr = row_start + r;
                int gc = k_base + c;
                As_shared[r][c] = (gr < M && gc < K) ? __float_to_tf32(A[gr * K + gc]) : __float_to_tf32(0.0f);
            }
            for (int i = tx; i < MMA_K * MMA_N; i += WARP_SIZE) {
                int r = i / MMA_N;
                int c = i % MMA_N;
                int gr = k_base + r;
                int gc = col_start + c;
                Bs_shared[c][r] = (gr < K && gc < N) ? __float_to_tf32(B[gr * N + gc]) : __float_to_tf32(0.0f);
            }
        }
        __syncthreads();

        load_matrix_sync(a_frag, &As_shared[0][0], MMA_K);
        load_matrix_sync(b_frag, &Bs_shared[0][0], MMA_K);
        __syncthreads();

        mma_sync(c_frag, a_frag, b_frag, c_frag);
    }

    // Store directly to global memory
    if (row_start < M && col_start < N) {
        store_matrix_sync(&C[row_start * N + col_start], c_frag, N, mem_row_major);
    }
}

void launch_register_tiled_gemm_tf32_wmma(const float* A, const float* B, float* C, int M, int N, int K) {
    dim3 block(WARP_SIZE);
    dim3 grid((N + MMA_N - 1) / MMA_N, (M + MMA_M - 1) / MMA_M);

    register_tiled_gemm_tf32_wmma<<<grid, block>>>(A, B, C, M, N, K);
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

    float* hA = new float[nA];
    float* hB = new float[nB];
    float* hC_ref = new float[nC];
    float* hC_gpu = new float[nC];
    for (size_t i = 0; i < nC; ++i) hC_ref[i] = 0.0f;

    std::srand(1337);
    for (size_t i = 0; i < nA; ++i) hA[i] = (std::rand() / static_cast<float>(RAND_MAX)) * 2.0f - 1.0f;
    for (size_t i = 0; i < nB; ++i) hB[i] = (std::rand() / static_cast<float>(RAND_MAX)) * 2.0f - 1.0f;

    cpu_gemm_f32(hA, hB, hC_ref, M, N, K);

    float *dA = nullptr, *dB = nullptr, *dC = nullptr;
    cudaError_t allocErr = cudaSuccess;
    allocErr = cudaMalloc(&dA, M * K * sizeof(float));
    if (allocErr == cudaSuccess) allocErr = cudaMalloc(&dB, K * N * sizeof(float));
    if (allocErr == cudaSuccess) allocErr = cudaMalloc(&dC, M * N * sizeof(float));
    if (allocErr != cudaSuccess) {
        std::cerr << "[CORRECTNESS] allocation failed: " << cudaGetErrorString(allocErr) << "\n";
        delete[] hA; delete[] hB; delete[] hC_ref; delete[] hC_gpu;
        cudaFree(dA); cudaFree(dB); cudaFree(dC);
        return 1;
    }
    cudaMemcpy(dA, hA, M * K * sizeof(float), cudaMemcpyHostToDevice);
    cudaMemcpy(dB, hB, K * N * sizeof(float), cudaMemcpyHostToDevice);
    cudaMemset(dC, 0, M * N * sizeof(float));
    launch_register_tiled_gemm_tf32_wmma(dA, dB, dC, M, N, K);
    cudaError_t err = cudaDeviceSynchronize();
    if (err != cudaSuccess) {
        std::cerr << "[CORRECTNESS] " << label << " kernel failed: " << cudaGetErrorString(err) << "\n";
        delete[] hA; delete[] hB; delete[] hC_ref; delete[] hC_gpu;
        cudaFree(dA); cudaFree(dB); cudaFree(dC);
        return 1;
    }
    cudaMemcpy(hC_gpu, dC, M * N * sizeof(float), cudaMemcpyDeviceToHost);

    const float rel_tol = 0.01f;
    const float abs_tol = 1e-3f;
    const float near_zero = 1e-3f;
    float max_rel = 0.0f, max_abs = 0.0f;
    int outliers = 0, rel_count = 0, abs_count = 0;
    for (size_t i = 0; i < M * N; ++i) {
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
    std::printf("[CORRECTNESS] %-30s max_rel=%.6f max_abs=%.6f rel=%d abs=%d outliers=%d/%zu => %s\n",
                label, max_rel, max_abs, rel_count, abs_count, outliers, (size_t)M * N,
                pass ? "PASS" : "FAIL");

    delete[] hA; delete[] hB; delete[] hC_ref; delete[] hC_gpu;
    cudaFree(dA); cudaFree(dB); cudaFree(dC);

    return pass ? 0 : 1;
}

static int run_correctness_test() {
    int result = 0;
    result |= run_correctness_shape(256, 256, 256, "TF32_WMMA_256");
    result |= run_correctness_shape(1024, 1024, 1000, "TF32_WMMA_M1024_N1024_K1000");
    result |= run_correctness_shape(1000, 1024, 1024, "TF32_WMMA_M1000_N1024_K1024");
    result |= run_correctness_shape(1024, 1000, 1024, "TF32_WMMA_M1024_N1000_K1024");
    result |= run_correctness_shape(1000, 1000, 1000, "TF32_WMMA_M1000_N1000_K1000");
    result |= run_correctness_shape(768, 768, 768, "TF32_WMMA_M768_N768_K768");
    result |= run_correctness_shape(512, 512, 512, "TF32_WMMA_M512_N512_K512");
    result |= run_correctness_shape(1000, 1000, 1002, "TF32_WMMA_M1000_N1000_K1002");
    result |= run_correctness_shape(1024, 1020, 1024, "TF32_WMMA_M1024_N1020_K1024");
    return result;
}

int main(int argc, char* argv[]) {
    bool skip_timing = (argc > 1 && std::strcmp(argv[1], "--correctness-only") == 0);
    bool timing_only = (argc > 1 && std::strcmp(argv[1], "--timing-only") == 0);

    if (argc == 5 && std::strcmp(argv[1], "--test-shape") == 0) {
        int M = std::atoi(argv[2]);
        int N = std::atoi(argv[3]);
        int K = std::atoi(argv[4]);
        if (M <= 0 || N <= 0 || K <= 0) {
            std::cerr << "[CORRECTNESS] invalid shape\n";
            return 2;
        }
        char label[64];
        std::snprintf(label, sizeof(label), "TF32_WMMA_M%d_N%d_K%d", M, N, K);
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

    launch_register_tiled_gemm_tf32_wmma(d_A, d_B, d_C, M, N, K);

    cudaEvent_t start, stop;
    cudaEventCreate(&start);
    cudaEventCreate(&stop);

    cudaEventRecord(start);
    launch_register_tiled_gemm_tf32_wmma(d_A, d_B, d_C, M, N, K);
    cudaEventRecord(stop);
    cudaEventSynchronize(stop);
    float ms = 0;
    cudaEventElapsedTime(&ms, start, stop);

    double flops = 2.0 * M * N * K;
    double tflops = flops / (ms / 1000.0) / 1e12;
    std::printf("TF32_WMMA %dx%dx%d: %.6f ms, %.6f TFLOPS\n", M, N, K, ms, tflops);

    cudaFree(d_A); cudaFree(d_B); cudaFree(d_C);
    free(h_A); free(h_B); free(h_C);
    return 0;
}