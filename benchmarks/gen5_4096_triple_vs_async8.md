# 4096^3 GEMM Benchmark: async-8warp vs triple-buffer

Date: 2026-04-26
GPU: NVIDIA GeForce RTX 5060 (sm_120, 8 GB, 30 SMs, 15 TPCs)
CUDA: 13.2 V13.2.51 | Nsight Compute: 2026.1.0
Problem: M=N=K=4096, FP16 A/B, FP32 accumulate

## Timing (3 runs, cudaEventElapsedTime)

| Kernel                | Run 1 (ms) | Run 2 (ms) | Run 3 (ms) | Avg (ms) |
|-----------------------|-----------|-----------|-----------|---------|
| fastpath-async-8warp  | 32.71     | 29.98     | 31.04     | 31.25   |
| exp-async-8warp-triple| 39.46     | 38.62     | 39.41     | 39.16   |

**Winner: async-8warp by 1.25x (20.2% faster)**

## NCU Duration

| Kernel        | NCU Duration (ms) |
|---------------|-------------------|
| async-8warp   | 35.61             |
| triple-buffer | 45.34             |

## Key Metrics

| Metric                                    | async-8warp | triple-buffer | Delta      |
|-------------------------------------------|-------------|---------------|------------|
| Achieved Occupancy                        | 82.98%      | 66.52%        | -16.46pp   |
| SM Throughput                             | 33.60%      | 25.60%        | -8.00pp    |
| DRAM Throughput                           | 9.56%       | 7.53%         | -2.03pp    |
| L1/TEX Throughput                         | 39.97%      | 31.94%        | -8.03pp    |
| L2 Throughput                             | 14.53%      | 10.08%        | -4.45pp    |
| Registers/thread                          | 30          | 29            | -1         |
| Shared mem/block                          | 17.41 KB    | 25.60 KB      | +8.19 KB   |
| Theoretical Occupancy                     | 83.33%      | 66.67%        | -16.66pp   |
| Block Limit (Shared Mem)                  | 5           | 4             | -1         |
| L1/TEX Hit Rate                           | 75.74%      | 79.90%        | +4.16pp    |
| L2 Hit Rate                               | 67.89%      | 70.90%        | +3.01pp    |
| Memory BW                                 | 39.14 GB/s  | 30.38 GB/s    | -8.76 GB/s |
| CPI L1TEX Scoreboard Stall                | 20.6 (70.8%)| 23.1 (75.1%) | +2.5 cyc   |
| Warp Cycles/Issued Instruction            | 29.07       | 30.77         | +1.70      |
| Eligible Warps/Scheduler                  | 0.63        | 0.41          | -0.22      |
| No Eligible %                             | 65.69%      | 73.99%        | +8.30pp    |
| Executed IPC (active)                     | 1.37        | 1.04          | -0.33      |
| Shared Bank Conflict (avg way)            | 8.1-way     | 8.2-way       | +0.1       |
| Spilling (local/shared)                   | 0 / 0       | 0 / 0         | 0          |
| Elapsed Cycles                            | 82,494,459  | 103,496,396   | +25.5%     |

## Scaling: 2048 vs 4096

| Metric                    | 2048 async8 | 2048 triple | 4096 async8 | 4096 triple |
|---------------------------|-------------|-------------|-------------|-------------|
| Avg wall-clock (ms)       | 2.660       | 4.455       | 31.25       | 39.16       |
| triple/async8 ratio       | 1.67x       |             | 1.25x       |             |
| Achieved Occupancy        | 87.36%      | 66.47%      | 82.98%      | 66.52%      |
| L1TEX Scoreboard CPI      | 14.2 (64.5%)| 20.1 (72.2%)| 20.6 (70.8%)| 23.1 (75.1%)|
| DRAM Throughput           | 3.64%       | 3.97%       | 9.56%       | 7.53%       |
| L2 Hit Rate               | 96.14%      | 90.59%      | 67.89%      | 70.90%      |
| Memory BW                 | 14.55 GB/s  | 15.05 GB/s  | 39.14 GB/s  | 30.38 GB/s  |

## Key Finding

Gap narrows from 1.67x (2048) to 1.25x (4096), but triple never wins.
The workload becomes more memory-bound at 4096 (L2 hit drops to 67-71%),
so DRAM latency dominates over SM occupancy effects. But the 16.66pp
occupancy loss from shared-memory pressure remains a fixed penalty.

## Verdict

async-8warp remains the fast-path at 4096. Triple-buffer does not recover
the occupancy cost at any tested problem size.
