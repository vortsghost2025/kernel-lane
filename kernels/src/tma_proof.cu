#include <cuda_runtime.h>
#include <cuda.h>
#include <cuda/ptx>
#include <cuda/__driver/driver_api.h>
#include <cstdio>
#include <cstdlib>
#include <vector>

// Small proof: TMA global->shared copy of a single 16 x 64 FP32 tile from B.
// Validates: rank-3 tensor map encode, cp.async.bulk.tensor, mbarrier sync.

#define PROOF_ROWS 16   // box rows (== BK)
#define PROOF_COLS 64   // box cols (fastest dim)
#define NTHREADS 256
#define BN0 64          // tensor cols (fastest dim) extended for stride test
#define BK0 64          // tensor rows
#define BR 8            // rows to read from B (>= PROOF_ROWS)

static CUtensorMap make_map(const float* dB, int N, int K) {
    namespace drv = cuda::__driver;
    uint64_t gdim[3]    = { (uint64_t)N, (uint64_t)K, 1u };
    uint64_t gstride[2] = { (uint64_t)N * sizeof(float), (uint64_t)N * (uint64_t)K * sizeof(float) };
    uint32_t box[3]     = { PROOF_COLS, PROOF_ROWS, 1u };
    uint32_t estr[3]    = { 1u, 1u, 1u };
    return drv::__tensorMapEncodeTiled(
        CU_TENSOR_MAP_DATA_TYPE_FLOAT32, 3, const_cast<float*>(dB), gdim, gstride, box, estr,
        CU_TENSOR_MAP_INTERLEAVE_NONE, CU_TENSOR_MAP_SWIZZLE_NONE,
        CU_TENSOR_MAP_L2_PROMOTION_NONE, CU_TENSOR_MAP_FLOAT_OOB_FILL_NONE);
}

__global__ void tma_proof_kernel(const float* __restrict__ B, float* __restrict__ C, int N, const CUtensorMap* __restrict__ tm) {
    __shared__ __align__(16) float Bs[PROOF_ROWS][PROOF_COLS];
    __shared__ __align__(8) unsigned long long mbar;
    int tid = threadIdx.x;
    if (tid == 0) cuda::ptx::mbarrier_init((unsigned long long*)&mbar, NTHREADS);
    __syncthreads();

    if (tid == 0) {
        int32_t tcoords[3] = { 0, 0, 0 };  // copy tile at (col=0, row=0, 0)
        cuda::ptx::mbarrier_arrive_expect_tx(
            cuda::ptx::sem_release, cuda::ptx::scope_cta, cuda::ptx::space_shared,
            (unsigned long long*)&mbar, PROOF_ROWS * PROOF_COLS * sizeof(float));
        cuda::ptx::cp_async_bulk_tensor(
            cuda::ptx::space_shared, cuda::ptx::space_global,
            &Bs[0][0], tm, tcoords, (unsigned long long*)&mbar);
    } else {
        cuda::ptx::mbarrier_arrive((unsigned long long*)&mbar, 1u);
    }
    while (!cuda::ptx::mbarrier_try_wait_parity((unsigned long long*)&mbar, 0u)) {}
    __syncthreads();

    // Copy Bs tile out to C so host can compare.
    int total = PROOF_ROWS * PROOF_COLS;
    for (int i = tid; i < total; i += NTHREADS) {
        int r = i / PROOF_COLS, c = i % PROOF_COLS;
        C[r * PROOF_COLS + c] = Bs[r][c];
    }
}

int main() {
    int N = BN0, K = BK0;
    std::vector<float> hB(K * N), hC(PROOF_ROWS * PROOF_COLS, -9.0f);
    for (int i = 0; i < K * N; ++i) hB[i] = (float)(i % 1000) * 0.001f;  // unique-ish

    float *dB, *dC;
    cudaMalloc(&dB, K * N * sizeof(float));
    cudaMalloc(&dC, PROOF_ROWS * PROOF_COLS * sizeof(float));
    cudaMemcpy(dB, hB.data(), K * N * sizeof(float), cudaMemcpyHostToDevice);
    cudaMemset(dC, 0, PROOF_ROWS * PROOF_COLS * sizeof(float));

    CUtensorMap tm_host = make_map(dB, N, K);
    CUtensorMap* tm_dev = nullptr;
    cudaMalloc(&tm_dev, sizeof(CUtensorMap));
    cudaMemcpy(tm_dev, &tm_host, sizeof(CUtensorMap), cudaMemcpyHostToDevice);
    tma_proof_kernel<<<1, NTHREADS>>>(dB, dC, N, tm_dev);
    cudaError_t err = cudaDeviceSynchronize();
    if (err != cudaSuccess) {
        std::printf("PROOF KERNEL FAILED: %s\n", cudaGetErrorString(err));
        cudaFree(dB); cudaFree(dC); cudaFree(tm_dev);
        return 1;
    }
    cudaMemcpy(hC.data(), dC, PROOF_ROWS * PROOF_COLS * sizeof(float), cudaMemcpyDeviceToHost);
    cudaFree(tm_dev);

    int bad = 0; float maxerr = 0;
    for (int r = 0; r < PROOF_ROWS; ++r) {
        for (int c = 0; c < PROOF_COLS; ++c) {
            float expect = hB[r * N + c];
            float got = hC[r * PROOF_COLS + c];
            float e = (got - expect) > 0 ? (got - expect) : (expect - got);
            if (e > maxerr) maxerr = e;
            if (e != 0.0f) bad++;
        }
    }
    std::printf("PROOF TMA: rows=%d cols=%d -> B tile at (0,0). mismatches=%d maxerr=%f\n", PROOF_ROWS, PROOF_COLS, bad, maxerr);
    cudaFree(dB); cudaFree(dC);
    return bad == 0 ? 0 : 1;
}
