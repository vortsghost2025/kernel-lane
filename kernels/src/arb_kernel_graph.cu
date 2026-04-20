#include <iostream>
#include <fstream>
#include <cuda_runtime.h>
#include <chrono>
#include <iomanip>

#define CUDA_CHECK(call) do { \
    cudaError_t err = (call); \
    if (err != cudaSuccess) { \
        std::cerr << "CUDA error at " << __FILE__ << ":" << __LINE__ \
                  << " - " << cudaGetErrorString(err) << std::endl; \
        return 1; \
    } \
} while(0)

// AMM Triangle Arbitrage Math Kernel
__global__ void find_arbitrage_paths(const float* __restrict__ res_A, const float* __restrict__ res_B,
                                      float* __restrict__ profits, int num_paths) {
    int idx = blockIdx.x * blockDim.x + threadIdx.x;
    if (idx < num_paths) {
        float amount_in = 1000.0f;

        float denom1 = res_A[idx] + amount_in;
        float denom2_start = res_B[idx];
        
        if (denom1 <= 0.0f) { profits[idx] = 0.0f; return; }
        
        float out_1 = (amount_in * res_B[idx]) / denom1;
        float denom2 = denom2_start + out_1;
        
        if (denom2 <= 0.0f) { profits[idx] = 0.0f; return; }
        
        float out_2 = (out_1 * res_A[idx]) / denom2;

        profits[idx] = out_2 - amount_in;
    }
}

int main() {
    int num_paths = 1048576;
    size_t size = num_paths * sizeof(float);

    float *h_resA, *h_resB, *h_profits;
    CUDA_CHECK(cudaMallocHost(&h_resA, size));
    CUDA_CHECK(cudaMallocHost(&h_resB, size));
    CUDA_CHECK(cudaMallocHost(&h_profits, size));

    srand(42);  // Deterministic seed for reproducible results
    for(int i = 0; i < num_paths; i++) {
        h_resA[i] = 10000.0f + (rand() % 5000);
        h_resB[i] = 10000.0f + (rand() % 5000);
    }

    float *d_resA, *d_resB, *d_profits;
    CUDA_CHECK(cudaMalloc(&d_resA, size));
    CUDA_CHECK(cudaMalloc(&d_resB, size));
    CUDA_CHECK(cudaMalloc(&d_profits, size));

    int threads = 1024;
    int blocks = (num_paths + threads - 1) / threads;

    cudaStream_t stream;
    CUDA_CHECK(cudaStreamCreate(&stream));
    cudaGraph_t graph;
    cudaGraphExec_t instance;

    // Warmup
    CUDA_CHECK(cudaMemcpyAsync(d_resA, h_resA, size, cudaMemcpyHostToDevice, stream));
    CUDA_CHECK(cudaMemcpyAsync(d_resB, h_resB, size, cudaMemcpyHostToDevice, stream));
    find_arbitrage_paths<<<blocks, threads, 0, stream>>>(d_resA, d_resB, d_profits, num_paths);
    CUDA_CHECK(cudaGetLastError());
    CUDA_CHECK(cudaMemcpyAsync(h_profits, d_profits, size, cudaMemcpyDeviceToHost, stream));
    CUDA_CHECK(cudaStreamSynchronize(stream));

    // Capture Graph
    CUDA_CHECK(cudaStreamBeginCapture(stream, cudaStreamCaptureModeGlobal));
    CUDA_CHECK(cudaMemcpyAsync(d_resA, h_resA, size, cudaMemcpyHostToDevice, stream));
    CUDA_CHECK(cudaMemcpyAsync(d_resB, h_resB, size, cudaMemcpyHostToDevice, stream));
    find_arbitrage_paths<<<blocks, threads, 0, stream>>>(d_resA, d_resB, d_profits, num_paths);
    CUDA_CHECK(cudaGetLastError());
    CUDA_CHECK(cudaMemcpyAsync(h_profits, d_profits, size, cudaMemcpyDeviceToHost, stream));
    CUDA_CHECK(cudaStreamEndCapture(stream, &graph));

    CUDA_CHECK(cudaGraphInstantiate(&instance, graph, NULL, NULL, 0));

    int iterations = 1000;

    // Benchmark Classic Launch
    auto start_classic = std::chrono::high_resolution_clock::now();
    for(int i=0; i<iterations; i++) {
        CUDA_CHECK(cudaMemcpyAsync(d_resA, h_resA, size, cudaMemcpyHostToDevice, stream));
        CUDA_CHECK(cudaMemcpyAsync(d_resB, h_resB, size, cudaMemcpyHostToDevice, stream));
        find_arbitrage_paths<<<blocks, threads, 0, stream>>>(d_resA, d_resB, d_profits, num_paths);
        CUDA_CHECK(cudaGetLastError());
        CUDA_CHECK(cudaMemcpyAsync(h_profits, d_profits, size, cudaMemcpyDeviceToHost, stream));
    }
    CUDA_CHECK(cudaStreamSynchronize(stream));
    auto end_classic = std::chrono::high_resolution_clock::now();
    double classic_ms = std::chrono::duration<double, std::milli>(end_classic - start_classic).count() / iterations;

    // Benchmark Graph Launch
    auto start_graph = std::chrono::high_resolution_clock::now();
    for(int i=0; i<iterations; i++) {
        CUDA_CHECK(cudaGraphLaunch(instance, stream));
    }
    CUDA_CHECK(cudaStreamSynchronize(stream));
    auto end_graph = std::chrono::high_resolution_clock::now();
    double graph_ms = std::chrono::duration<double, std::milli>(end_graph - start_graph).count() / iterations;

    // Extract best profit from last run
    float max_profit = 0.0f;
    int best_path = -1;
    for(int i=0; i<num_paths; i++) {
        if(h_profits[i] > max_profit) { max_profit = h_profits[i]; best_path = i; }
    }

    double speedup = classic_ms / graph_ms;

    std::cout << "[ GEN 1: CUDA GRAPHS INITIALIZED ]\n";
    std::cout << "Classic Launch (Avg): " << classic_ms << " ms\n";
    std::cout << "Graph Launch (Avg):   " << graph_ms << " ms\n";
    std::cout << "Latency Reduction:    " << speedup << "x\n";
    std::cout << "Best Profit Found:    +$" << max_profit << " (Path: " << best_path << ")\n";

    // Write report
    std::ofstream report("sweeps/arb_graph_report.md");
    if(report.is_open()) {
        report << "# GEN 1: CUDA Graph Performance Report\n\n";
        report << "## Latency Metrics (1 Million Paths)\n";
        report << "- **Classic API Launch:** `" << classic_ms << " ms`\n";
        report << "- **CUDA Graph Launch:** `" << graph_ms << " ms`\n";
        report << "- **CPU Overhead Reduction:** `" << speedup << "x Multiplier`\n\n";
        report << "## MEV Output\n";
        report << "- **Max Profit Detected:** `+$" << max_profit << "`\n";
        report << "- **Optimal Path Index:** `" << best_path << "`\n";
        report.close();
    }

    // Cleanup
    cudaGraphExecDestroy(instance);
    cudaGraphDestroy(graph);
    cudaStreamDestroy(stream);
    cudaFree(d_resA); cudaFree(d_resB); cudaFree(d_profits);
    cudaFreeHost(h_resA); cudaFreeHost(h_resB); cudaFreeHost(h_profits);

    return 0;
}
