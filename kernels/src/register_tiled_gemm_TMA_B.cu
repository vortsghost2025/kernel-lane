#include <cuda_runtime.h>
#include <cuda.h>
#include <cuda/ptx>
#include <cuda/__driver/driver_api.h>
#include <iostream>
#include <cstdlib>
#include <cmath>
#include <cstring>
#include <vector>
#include <cstdio>
#include <algorithm>

#define BLOCK_SIZE 16
#define THREAD_TILE_M 4
#define THREAD_TILE_N 4
#define BK 16  // Tile size in K dimension

// ============================================================================
// Host-side helper: encode a rank-3 CUtensorMap describing the B matrix.
//   cuTensorMap uses column-major convention: globalDim[0] is the FASTEST/contiguous
//   dimension, globalStrides are in BYTES and cover only (rank-1) dimensions.
//   B is row-major [K rows][N cols]; cols are contiguous.
//   -> globalDim = { cols=N, rows=K, 1 }
//   -> globalStrides = { N*4 bytes (row stride), N*4*K (outer trivial stride) }
//   Kernel box  : 64 cols (fastest) x 16 rows x 1, placed at (col_start, k_base, 0).
// ============================================================================
static CUtensorMap make_b_tensormap(const float* dB, int N, int K) {
    namespace drv = cuda::__driver;
    uint64_t gdim[2+1] = { (uint64_t)N, (uint64_t)K, 1u };       // [cols, rows, outer]
    uint64_t gstride[2] = {
        (uint64_t)N * sizeof(float),          // stride between rows (dim0 -> dim1)
        (uint64_t)N * (uint64_t)K * sizeof(float) // stride between dim1 and outer dim
    };
    uint32_t box[3] = { (uint32_t)(BLOCK_SIZE * THREAD_TILE_N), (uint32_t)BK, 1u }; // [64 cols, 16 rows, 1]
    uint32_t estr[3] = { 1u, 1u, 1u };
    return drv::__tensorMapEncodeTiled(
        CU_TENSOR_MAP_DATA_TYPE_FLOAT32,
        3,
        const_cast<float*>(dB),
        gdim, gstride, box, estr,
        CU_TENSOR_MAP_INTERLEAVE_NONE,
        CU_TENSOR_MAP_SWIZZLE_NONE,
        CU_TENSOR_MAP_L2_PROMOTION_NONE,
        CU_TENSOR_MAP_FLOAT_OOB_FILL_NONE);
}

template <bool K_aligned, bool N_aligned>
__global__ void register_tiled_gemm(const float* __restrict__ A, const float* __restrict__ B, float* __restrict__ C,
                                    int M, int N, int K, const CUtensorMap* __restrict__ tm) {
    // Block index
    int bx = blockIdx.x, by = blockIdx.y;
    // Thread index
    int tx = threadIdx.x, ty = threadIdx.y;

    // Calculate the starting row and column of the tile that this block is responsible for
    int row_start = by * BLOCK_SIZE * THREAD_TILE_M;
    int col_start = bx * BLOCK_SIZE * THREAD_TILE_N;

    // Shared memory: AsT transpose layout for A (unchanged), Bs direct for B (TMA writes it)
    __shared__ __align__(16) float AsT[BK][BLOCK_SIZE * THREAD_TILE_M];
    __shared__ __align__(16) float Bs[BK][BLOCK_SIZE * THREAD_TILE_N];
    // mbarrier for TMA completion (only used when this block stages B via TMA)
    __shared__ __align__(8) unsigned long long mbar;

    // Allocate registers for the thread's tile of C
    float C_local[THREAD_TILE_M][THREAD_TILE_N] = {{0.0f}};

    int tid = ty * BLOCK_SIZE + tx;  // linear thread index in the block [0, 255]

    // TMA is safe for B only when every logical 16x64 B tile this block touches is fully
    // inside B's [0,K) x [0,N) extent.  That requires this block's column band to be within N
    // AND K to have no tail tile (each k-tile is a full 16 rows).
    bool tma_b = (col_start + BLOCK_SIZE * THREAD_TILE_N <= N) && (K % BK == 0);

    // Initialize the mbarrier with arrival count == number of threads in the block.
    if (tid == 0) {
        cuda::ptx::mbarrier_init((unsigned long long*)&mbar, (unsigned)(BLOCK_SIZE * BLOCK_SIZE));
    }
    __syncthreads();  // ensure mbarrier initialized before any thread arrives

    // Loop over K in tiles of BK
    int kt = 0;
    for (int k_base = 0; k_base < K; k_base += BK, ++kt) {
        int k_end = k_base + BK;
        if (k_end > K) k_end = K;
        int k_valid = k_end - k_base;

        // ---- Load tile of A into shared memory AsT (unchanged: accepted transpose path) ----
        int row_in_tile_A = tid / 4;           // row in A tile [0, 63]
        int lane_in_row_A = tid % 4;           // which float4 chunk in this row [0, 3]
        int k_base_in_tile_A = lane_in_row_A * 4; // k offset [0, 4, 8, 12]
        int global_row_A = row_start + row_in_tile_A;
        int global_col_A = k_base + k_base_in_tile_A;
        if (global_row_A < M && global_col_A + 3 < K) {
            const float* a_src = &A[global_row_A * K + global_col_A];
            if (K_aligned) {
                float4 a_vec = *reinterpret_cast<const float4*>(a_src);
                AsT[k_base_in_tile_A + 0][row_in_tile_A] = a_vec.x;
                AsT[k_base_in_tile_A + 1][row_in_tile_A] = a_vec.y;
                AsT[k_base_in_tile_A + 2][row_in_tile_A] = a_vec.z;
                AsT[k_base_in_tile_A + 3][row_in_tile_A] = a_vec.w;
            } else {
                for (int k = 0; k < 4; ++k) {
                    AsT[k_base_in_tile_A + k][row_in_tile_A] = a_src[k];
                }
            }
        } else if (global_row_A < M) {
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

        // ---- Load tile of B into shared memory Bs ----
        if (tma_b) {
            // Bulk (TMA) global->shared copy of the logical 16 x 64 B tile into Bs[16][64].
            // One elected thread issues the TMA; all threads participate in the mbarrier.
            const unsigned b_bytes = (unsigned)(BK * (BLOCK_SIZE * THREAD_TILE_N) * sizeof(float)); // 4096
            if (tid == 0) {
                int32_t tcoords[3] = { col_start, k_base, 0 };  // [dim0 fast=col, dim1=row(k), outer]
                // Elected thread: one arrival + register expected transaction bytes.
                cuda::ptx::mbarrier_arrive_expect_tx(
                    cuda::ptx::sem_release, cuda::ptx::scope_cta, cuda::ptx::space_shared,
                    (unsigned long long*)&mbar, b_bytes);
                // Issue the bulk tensor copy.  complete_tx::bytes will decrement the expected tx count.
                cuda::ptx::cp_async_bulk_tensor(
                    cuda::ptx::space_shared, cuda::ptx::space_global,
                    &Bs[0][0], tm, tcoords, (unsigned long long*)&mbar);
            } else {
                cuda::ptx::mbarrier_arrive((unsigned long long*)&mbar, 1u);
            }
            // All threads wait for the phase: 256 arrivals AND the expected tx bytes to complete.
            while (!cuda::ptx::mbarrier_try_wait_parity((unsigned long long*)&mbar, (unsigned)kt)) {}
        } else {
            // Boundary block: fall back to the accepted synchronous B staging (exact zero-fill).
            int k_in_tile_B = tid / 16;           // row in B tile [0, 15]
            int lane_in_row_B = tid % 16;         // which float4 chunk [0, 15]
            int col_base_in_tile_B = lane_in_row_B * 4;
            int global_row_B = k_base + k_in_tile_B;
            int global_col_B = col_start + col_base_in_tile_B;
            if (global_row_B < K && global_col_B + 3 < N) {
                const float* b_src = &B[global_row_B * N + global_col_B];
                if (N_aligned) {
                    float4 b_vec = *reinterpret_cast<const float4*>(b_src);
                    Bs[k_in_tile_B][col_base_in_tile_B + 0] = b_vec.x;
                    Bs[k_in_tile_B][col_base_in_tile_B + 1] = b_vec.y;
                    Bs[k_in_tile_B][col_base_in_tile_B + 2] = b_vec.z;
                    Bs[k_in_tile_B][col_base_in_tile_B + 3] = b_vec.w;
                } else {
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
        }

        __syncthreads();  // AsT (A staging) and Bs (TMA completed / sync staged) are ready

        // Now compute the product for this thread's tile (unchanged)
        for (int k = 0; k < k_valid; ++k) {
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

    // Store the thread's tile of C to global memory (unchanged)
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
static CUtensorMap* g_tm_dev = nullptr;
static const float* g_tm_B = nullptr;
static int g_tm_N = 0, g_tm_K = 0;

// Cache a device-resident copy of the B tensor map.  Re-encode only when the
// backing B pointer or its shape changes; otherwise reuse so timed launches incur
// no host-side encode overhead.
static const CUtensorMap* cached_b_tensormap(float* B, int N, int K) {
    if (g_tm_dev && g_tm_B == B && g_tm_N == N && g_tm_K == K) {
        return g_tm_dev;
    }
    if (g_tm_dev) cudaFree(g_tm_dev);
    CUtensorMap tm_host = make_b_tensormap(B, N, K);
    cudaMalloc(&g_tm_dev, sizeof(CUtensorMap));
    cudaMemcpy(g_tm_dev, &tm_host, sizeof(CUtensorMap), cudaMemcpyHostToDevice);
    g_tm_B = B; g_tm_N = N; g_tm_K = K;
    return g_tm_dev;
}

static void launch_register_tiled_gemm(float* A, float* B, float* C, int M, int N, int K) {
    dim3 block(BLOCK_SIZE, BLOCK_SIZE);
    dim3 grid((N + (BLOCK_SIZE * THREAD_TILE_N) - 1) / (BLOCK_SIZE * THREAD_TILE_N),
              (M + (BLOCK_SIZE * THREAD_TILE_M) - 1) / (BLOCK_SIZE * THREAD_TILE_M));

    bool K_aligned = (K % 4 == 0);
    bool N_aligned = (N % 4 == 0);

    const CUtensorMap* tm = cached_b_tensormap(B, N, K);

    if (K_aligned && N_aligned) {
        register_tiled_gemm<true, true><<<grid, block>>>(A, B, C, M, N, K, tm);
    } else if (K_aligned && !N_aligned) {
        register_tiled_gemm<true, false><<<grid, block>>>(A, B, C, M, N, K, tm);
    } else if (!K_aligned && N_aligned) {
        register_tiled_gemm<false, true><<<grid, block>>>(A, B, C, M, N, K, tm);
    } else {
        register_tiled_gemm<false, false><<<grid, block>>>(A, B, C, M, N, K, tm);
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
    std::printf("[CORRECTNESS] %-22s max_rel=%.6f max_abs=%.6f rel=%d abs=%d outliers=%d/%zu => %s\n",
                label, max_rel, max_abs, rel_count, abs_count, outliers, nC,
                pass ? "PASS" : "FAIL");
    return pass ? 0 : 1;
}

static int run_correctness_test() {
    return run_correctness_shape(256, 256, 256, "TMA_B_256x256x256");
}

// The established gate: 256 + 8 general/awkward shapes (matches prior accepted suite).
static int run_all_shapes() {
    static const struct { int M, N, K; const char* name; } shapes[] = {
        {256, 256, 256, "TMA_B_256"},
        {1024, 1024, 1000, "TMA_B_M1024_N1024_K1000"},
        {1000, 1024, 1024, "TMA_B_M1000_N1024_K1024"},
        {1024, 1000, 1024, "TMA_B_M1024_N1000_K1024"},
        {1000, 1000, 1000, "TMA_B_M1000_N1000_K1000"},
        {768, 768, 768, "TMA_B_M768_N768_K768"},
        {512, 512, 512, "TMA_B_M512_N512_K512"},
        {1000, 1000, 1002, "TMA_B_M1000_N1000_K1002"},
        {1024, 1020, 1024, "TMA_B_M1024_N1020_K1024"},
    };
    int fail = 0;
    for (const auto& s : shapes) {
        fail += run_correctness_shape(s.M, s.N, s.K, s.name);
    }
    std::printf("[ALL_SHAPES] %d shape(s) failed\n", fail);
    return fail;
}

int main(int argc, char* argv[]) {
    bool skip_timing = (argc > 1 && std::strcmp(argv[1], "--correctness-only") == 0);
    bool timing_only = (argc > 1 && std::strcmp(argv[1], "--timing-only") == 0);
    bool all_shapes  = (argc > 1 && std::strcmp(argv[1], "--all-shapes") == 0);

    if (all_shapes) {
        return run_all_shapes();
    }

    if (argc == 5 && std::strcmp(argv[1], "--test-shape") == 0) {
        int M = std::atoi(argv[2]);
        int N = std::atoi(argv[3]);
        int K = std::atoi(argv[4]);
        if (M <= 0 || N <= 0 || K <= 0) {
            std::cerr << "[CORRECTNESS] invalid shape\n";
            return 2;
        }
        char label[64];
        std::snprintf(label, sizeof(label), "TMA_B_M%d_N%d_K%d", M, N, K);
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
    std::printf("TMA_B %dx%dx%d: %.6f ms, %.6f TFLOPS\n", M, N, K, ms, tflops);

    cudaFree(d_A); cudaFree(d_B); cudaFree(d_C);
    free(h_A); free(h_B); free(h_C);
    return 0;
}
