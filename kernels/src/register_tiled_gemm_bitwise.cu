#include <cuda_runtime.h>
#include <cuda.h>
#include <cuda/ptx>
#include <cuda/__driver/driver_api.h>
#include <cstdio>
#include <cstdlib>
#include <cmath>
#include <cstring>
#include <vector>
#include <cstdint>

#define BLOCK_SIZE 16
#define THREAD_TILE_M 4
#define THREAD_TILE_N 4
#define BK 16

// ============================================================
// OLD production kernel (byte-for-byte body from register_tiled_gemm.cu,
// symbol renamed to gemm_old).
// ============================================================
template <bool K_aligned, bool N_aligned>
__global__ void gemm_old(const float* __restrict__ A, const float* __restrict__ B, float* __restrict__ C, int M, int N, int K) {
    int bx = blockIdx.x, by = blockIdx.y;
    int tx = threadIdx.x, ty = threadIdx.y;
    int row_start = by * BLOCK_SIZE * THREAD_TILE_M;
    int col_start = bx * BLOCK_SIZE * THREAD_TILE_N;
    __shared__ float AsT[BK][BLOCK_SIZE * THREAD_TILE_M];
    __shared__ float Bs[BK][BLOCK_SIZE * THREAD_TILE_N];
    float C_local[THREAD_TILE_M][THREAD_TILE_N] = {{0.0f}};
    for (int k_base = 0; k_base < K; k_base += BK) {
        int k_end = k_base + BK;
        if (k_end > K) k_end = K;
        int k_valid = k_end - k_base;
        int tid = ty * BLOCK_SIZE + tx;
        int row_in_tile_A = tid / 4;
        int lane_in_row_A = tid % 4;
        int k_base_in_tile_A = lane_in_row_A * 4;
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
                for (int k = 0; k < 4; ++k) { AsT[k_base_in_tile_A + k][row_in_tile_A] = a_src[k]; }
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
        int k_in_tile_B = tid / 16;
        int lane_in_row_B = tid % 16;
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
                for (int c = 0; c < 4; ++c) { Bs[k_in_tile_B][col_base_in_tile_B + c] = b_src[c]; }
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
        for (int k = 0; k < k_valid; ++k) {
            for (int i = 0; i < THREAD_TILE_M; ++i) {
                float a_val = AsT[k][ty * THREAD_TILE_M + i];
                for (int j = 0; j < THREAD_TILE_N; ++j) {
                    float b_val = Bs[k][tx * THREAD_TILE_N + j];
                    C_local[i][j] += a_val * b_val;
                }
            }
        }
        __syncthreads();
    }
    for (int i = 0; i < THREAD_TILE_M; ++i) {
        for (int j = 0; j < THREAD_TILE_N; ++j) {
            int global_row = row_start + ty * THREAD_TILE_M + i;
            int global_col = col_start + tx * THREAD_TILE_N + j;
            if (global_row < M && global_col < N) { C[global_row * N + global_col] = C_local[i][j]; }
        }
    }
}

static void launch_old(float* A, float* B, float* C, int M, int N, int K) {
    dim3 block(BLOCK_SIZE, BLOCK_SIZE);
    dim3 grid((N + (BLOCK_SIZE * THREAD_TILE_N) - 1) / (BLOCK_SIZE * THREAD_TILE_N),
              (M + (BLOCK_SIZE * THREAD_TILE_M) - 1) / (BLOCK_SIZE * THREAD_TILE_M));
    bool K_aligned = (K % 4 == 0);
    bool N_aligned = (N % 4 == 0);
    if (K_aligned && N_aligned)       gemm_old<true, true><<<grid, block>>>(A, B, C, M, N, K);
    else if (K_aligned && !N_aligned) gemm_old<true, false><<<grid, block>>>(A, B, C, M, N, K);
    else if (!K_aligned && N_aligned) gemm_old<false, true><<<grid, block>>>(A, B, C, M, N, K);
    else                              gemm_old<false, false><<<grid, block>>>(A, B, C, M, N, K);
    cudaDeviceSynchronize();
}

// ============================================================
// NEW pipelined B-TMA kernel (byte-for-byte body from
// register_tiled_gemm_TMA_B_pipeline.cu, symbol renamed to gemm_new).
// ============================================================
static CUtensorMap make_b_tensormap(const float* dB, int N, int K) {
    namespace drv = cuda::__driver;
    uint64_t gdim[3]     = { (uint64_t)N, (uint64_t)K, 1u };
    uint64_t gstride[2]  = { (uint64_t)N * sizeof(float), (uint64_t)N * (uint64_t)K * sizeof(float) };
    uint32_t box[3]      = { (uint32_t)(BLOCK_SIZE * THREAD_TILE_N), (uint32_t)BK, 1u };
    uint32_t estr[3]     = { 1u, 1u, 1u };
    return drv::__tensorMapEncodeTiled(
        CU_TENSOR_MAP_DATA_TYPE_FLOAT32, 3, const_cast<float*>(dB), gdim, gstride, box, estr,
        CU_TENSOR_MAP_INTERLEAVE_NONE, CU_TENSOR_MAP_SWIZZLE_NONE,
        CU_TENSOR_MAP_L2_PROMOTION_NONE, CU_TENSOR_MAP_FLOAT_OOB_FILL_NONE);
}

template <bool K_aligned, bool N_aligned>
__global__ void gemm_new(const float* __restrict__ A, const float* __restrict__ B, float* __restrict__ C,
                         int M, int N, int K, const CUtensorMap* __restrict__ tm) {
    int bx = blockIdx.x, by = blockIdx.y;
    int tx = threadIdx.x, ty = threadIdx.y;
    int row_start = by * BLOCK_SIZE * THREAD_TILE_M;
    int col_start = bx * BLOCK_SIZE * THREAD_TILE_N;
    __shared__ __align__(16) float AsT[BK][BLOCK_SIZE * THREAD_TILE_M];
    __shared__ __align__(16) float Bs[2][BK][BLOCK_SIZE * THREAD_TILE_N];
    __shared__ __align__(8) unsigned long long mb[2];
    float C_local[THREAD_TILE_M][THREAD_TILE_N] = {{0.0f}};
    int tid = ty * BLOCK_SIZE + tx;
    bool tma_b = (col_start + BLOCK_SIZE * THREAD_TILE_N <= N) && (K % BK == 0);
    const unsigned b_bytes = (unsigned)(BK * (BLOCK_SIZE * THREAD_TILE_N) * sizeof(float));
    if (tma_b) {
        if (tid == 0) {
            cuda::ptx::mbarrier_init((unsigned long long*)&mb[0], 1u);
            cuda::ptx::mbarrier_init((unsigned long long*)&mb[1], 1u);
        }
        __syncthreads();
        if (tid == 0) {
            int32_t c0[3] = { col_start, 0, 0 };
            cuda::ptx::mbarrier_arrive_expect_tx(
                cuda::ptx::sem_release, cuda::ptx::scope_cta, cuda::ptx::space_shared,
                (unsigned long long*)&mb[0], b_bytes);
            cuda::ptx::cp_async_bulk_tensor(
                cuda::ptx::space_shared, cuda::ptx::space_global,
                &Bs[0][0][0], tm, c0, (unsigned long long*)&mb[0]);
        }
    }
    for (int t = 0, k_base = 0; k_base < K; ++t, k_base += BK) {
        int k_end = k_base + BK;
        if (k_end > K) k_end = K;
        int k_valid = k_end - k_base;
        int row_in_tile_A = tid / 4;
        int lane_in_row_A = tid % 4;
        int k_base_in_tile_A = lane_in_row_A * 4;
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
                for (int k = 0; k < 4; ++k) { AsT[k_base_in_tile_A + k][row_in_tile_A] = a_src[k]; }
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
        int curr = t & 1;
        int nxt  = (t + 1) & 1;
        if (tma_b) {
            if (tid == 0 && (k_base + BK) < K) {
                int32_t tc[3] = { col_start, k_base + BK, 0 };
                cuda::ptx::mbarrier_arrive_expect_tx(
                    cuda::ptx::sem_release, cuda::ptx::scope_cta, cuda::ptx::space_shared,
                    (unsigned long long*)&mb[nxt], b_bytes);
                cuda::ptx::cp_async_bulk_tensor(
                    cuda::ptx::space_shared, cuda::ptx::space_global,
                    &Bs[nxt][0][0], tm, tc, (unsigned long long*)&mb[nxt]);
            }
            while (!cuda::ptx::mbarrier_try_wait_parity((unsigned long long*)&mb[curr], (unsigned)((t >> 1) & 1))) {}
        } else {
            int k_in_tile_B = tid / 16;
            int lane_in_row_B = tid % 16;
            int col_base_in_tile_B = lane_in_row_B * 4;
            int global_row_B = k_base + k_in_tile_B;
            int global_col_B = col_start + col_base_in_tile_B;
            if (global_row_B < K && global_col_B + 3 < N) {
                const float* b_src = &B[global_row_B * N + global_col_B];
                if (N_aligned) {
                    float4 b_vec = *reinterpret_cast<const float4*>(b_src);
                    Bs[0][k_in_tile_B][col_base_in_tile_B + 0] = b_vec.x;
                    Bs[0][k_in_tile_B][col_base_in_tile_B + 1] = b_vec.y;
                    Bs[0][k_in_tile_B][col_base_in_tile_B + 2] = b_vec.z;
                    Bs[0][k_in_tile_B][col_base_in_tile_B + 3] = b_vec.w;
                } else {
                    for (int c = 0; c < 4; ++c) { Bs[0][k_in_tile_B][col_base_in_tile_B + c] = b_src[c]; }
                }
            } else if (global_row_B < K) {
                for (int c = 0; c < 4; ++c) {
                    int gc = global_col_B + c;
                    Bs[0][k_in_tile_B][col_base_in_tile_B + c] = (gc < N) ? B[global_row_B * N + gc] : 0.0f;
                }
            } else {
                Bs[0][k_in_tile_B][col_base_in_tile_B + 0] = 0.0f;
                Bs[0][k_in_tile_B][col_base_in_tile_B + 1] = 0.0f;
                Bs[0][k_in_tile_B][col_base_in_tile_B + 2] = 0.0f;
                Bs[0][k_in_tile_B][col_base_in_tile_B + 3] = 0.0f;
            }
        }
        __syncthreads();
        int bsel = tma_b ? curr : 0;
        for (int k = 0; k < k_valid; ++k) {
            for (int i = 0; i < THREAD_TILE_M; ++i) {
                float a_val = AsT[k][ty * THREAD_TILE_M + i];
                for (int j = 0; j < THREAD_TILE_N; ++j) {
                    float b_val = Bs[bsel][k][tx * THREAD_TILE_N + j];
                    C_local[i][j] += a_val * b_val;
                }
            }
        }
        __syncthreads();
    }
    for (int i = 0; i < THREAD_TILE_M; ++i) {
        for (int j = 0; j < THREAD_TILE_N; ++j) {
            int global_row = row_start + ty * THREAD_TILE_M + i;
            int global_col = col_start + tx * THREAD_TILE_N + j;
            if (global_row < M && global_col < N) { C[global_row * N + global_col] = C_local[i][j]; }
        }
    }
}

static void launch_new(float* A, float* B, float* C, int M, int N, int K) {
    dim3 block(BLOCK_SIZE, BLOCK_SIZE);
    dim3 grid((N + (BLOCK_SIZE * THREAD_TILE_N) - 1) / (BLOCK_SIZE * THREAD_TILE_N),
              (M + (BLOCK_SIZE * THREAD_TILE_M) - 1) / (BLOCK_SIZE * THREAD_TILE_M));
    bool K_aligned = (K % 4 == 0);
    bool N_aligned = (N % 4 == 0);
    CUtensorMap tm_host = make_b_tensormap(B, N, K);
    CUtensorMap* tm_dev = nullptr;
    cudaMalloc(&tm_dev, sizeof(CUtensorMap));
    cudaMemcpy(tm_dev, &tm_host, sizeof(CUtensorMap), cudaMemcpyHostToDevice);
    if (K_aligned && N_aligned)       gemm_new<true, true><<<grid, block>>>(A, B, C, M, N, K, tm_dev);
    else if (K_aligned && !N_aligned) gemm_new<true, false><<<grid, block>>>(A, B, C, M, N, K, tm_dev);
    else if (!K_aligned && N_aligned) gemm_new<false, true><<<grid, block>>>(A, B, C, M, N, K, tm_dev);
    else                              gemm_new<false, false><<<grid, block>>>(A, B, C, M, N, K, tm_dev);
    cudaDeviceSynchronize();
    cudaFree(tm_dev);
}

struct Shape { int M, N, K; const char* name; };
int main() {
    const Shape shapes[] = {
        {256, 256, 256, "256x256x256"},
        {1024, 1024, 1024, "1024x1024x1024"},
        {1000, 1000, 1002, "1000x1000x1002"},
        {1024, 1020, 1024, "1024x1020x1024"},
    };
    for (const auto& s : shapes) {
        const size_t nA = (size_t)s.M * s.K;
        const size_t nB = (size_t)s.K * s.N;
        const size_t nC = (size_t)s.M * s.N;
        std::vector<float> hA(nA), hB(nB), hCold(nC, 0.0f), hCnew(nC, 0.0f);
        std::srand(1337);
        for (size_t i = 0; i < nA; ++i) hA[i] = (std::rand() / (float)RAND_MAX) * 2.0f - 1.0f;
        for (size_t i = 0; i < nB; ++i) hB[i] = (std::rand() / (float)RAND_MAX) * 2.0f - 1.0f;
        float *dA=nullptr,*dB=nullptr,*dCold=nullptr,*dCnew=nullptr;
        cudaMalloc(&dA, nA*sizeof(float)); cudaMalloc(&dB, nB*sizeof(float));
        cudaMalloc(&dCold, nC*sizeof(float)); cudaMalloc(&dCnew, nC*sizeof(float));
        cudaMemcpy(dA,hA.data(),nA*sizeof(float),cudaMemcpyHostToDevice);
        cudaMemcpy(dB,hB.data(),nB*sizeof(float),cudaMemcpyHostToDevice);
        cudaMemset(dCold,0,nC*sizeof(float)); cudaMemset(dCnew,0,nC*sizeof(float));
        launch_old(dA,dB,dCold,s.M,s.N,s.K);
        launch_new(dA,dB,dCnew,s.M,s.N,s.K);
        cudaMemcpy(hCold.data(),dCold,nC*sizeof(float),cudaMemcpyDeviceToHost);
        cudaMemcpy(hCnew.data(),dCnew,nC*sizeof(float),cudaMemcpyDeviceToHost);
        cudaFree(dA);cudaFree(dB);cudaFree(dCold);cudaFree(dCnew);
        size_t diff=0, eq=0; long first=-1;
        for (size_t i=0;i<nC;++i){
            uint32_t bo = *reinterpret_cast<const uint32_t*>(&hCold[i]);
            uint32_t bn = *reinterpret_cast<const uint32_t*>(&hCnew[i]);
            if (bo==bn) eq++; else { if(diff==0) first=(long)i; diff++; }
        }
        std::printf("[BITWISE] %-16s total=%zu  equal=%zu  different=%zu  first_diff_idx=%ld", s.name, nC, eq, diff, first);
        if (first>=0){
            uint32_t bo = *reinterpret_cast<const uint32_t*>(&hCold[first]);
            uint32_t bn = *reinterpret_cast<const uint32_t*>(&hCnew[first]);
            std::printf("  old_bits=0x%08X  new_bits=0x%08X", bo, bn);
        }
        std::printf("  => %s\n", diff==0 ? "EXACT MATCH" : "DIFFERS");
    }
    return 0;
}
