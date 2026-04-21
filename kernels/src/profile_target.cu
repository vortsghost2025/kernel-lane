/*
 * Minimal profiling target for Kernel Lane.
 * Single kernel, fixed input size, ~1-3 second runtime.
 * Designed for nsys + ncu profiling — NOT a comprehensive benchmark.
 *
 * Compile: nvcc -o profile_target.exe profile_target.cu -O3 --use_fast_math
 */
#include <stdio.h>
#include <cuda_runtime.h>

#define N 4096
#define WARMUP_ITERS 5
#define PROFILE_ITERS 100

// Simple vector multiply-add kernel — representative of real compute work
__global__ void kernel_fma(float *data, int n, int iters) {
    int idx = blockIdx.x * blockDim.x + threadIdx.x;
    if (idx < n) {
        float val = data[idx];
        for (int i = 0; i < iters; i++) {
            val = fmaf(val, 1.001f, 0.001f);
        }
        data[idx] = val;
    }
}

int main() {
    float *d_data;
    cudaMalloc(&d_data, N * sizeof(float));

    float *h_data = (float*)malloc(N * sizeof(float));
    for (int i = 0; i < N; i++) h_data[i] = (float)i;
    cudaMemcpy(d_data, h_data, N * sizeof(float), cudaMemcpyHostToDevice);

    dim3 blocks((N + 255) / 256);
    dim3 threads(256);

    // Warmup
    for (int i = 0; i < WARMUP_ITERS; i++) {
        kernel_fma<<<blocks, threads>>>(d_data, N, 1000);
    }
    cudaDeviceSynchronize();

    // Profiled section
    cudaEvent_t start, stop;
    cudaEventCreate(&start);
    cudaEventCreate(&stop);

    cudaEventRecord(start);
    for (int i = 0; i < PROFILE_ITERS; i++) {
        kernel_fma<<<blocks, threads>>>(d_data, N, 1000);
    }
    cudaEventRecord(stop);
    cudaEventSynchronize(stop);

    float ms;
    cudaEventElapsedTime(&ms, start, stop);

    printf("profile_target | N=%d | iters=%d | threads=256 | %.2f ms total | %.3f us/kernel\n",
           N, PROFILE_ITERS, ms, ms * 1000.0f / PROFILE_ITERS);

    cudaEventDestroy(start);
    cudaEventDestroy(stop);
    cudaFree(d_data);
    free(h_data);

    return 0;
}
