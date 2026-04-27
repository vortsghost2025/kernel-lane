# 2048^3 GEMM Benchmark Report: async-8warp vs triple-buffer

Date: 2026-04-26
GPU: NVIDIA GeForce RTX 5060 (sm_120, 8 GB, 30 SMs, 15 TPCs)
CUDA: 13.2 V13.2.51
Nsight Compute: 2026.1.0
Problem size: M=N=K=2048 (FP16 A/B, FP32 accumulate)

## Timing Results (3 runs, wall-clock cudaEventElapsedTime)

| Kernel                | Run 1 (ms) | Run 2 (ms) | Run 3 (ms) | Avg (ms) |
|-----------------------|-----------|-----------|-----------|---------|
| fastpath-async-8warp  | 2.656     | 2.666     | 2.659     | 2.660   |
| exp-async-8warp-triple| 4.301     | 4.886     | 4.178     | 4.455   |

**Winner: async-8warp by 1.67x (40.3% faster)**

## NCU Duration (kernel-only, NCU-instrumented)

| Kernel                | NCU Duration (ms) |
|-----------------------|-------------------|
| async-8warp           | 3.57              |
| triple-buffer         | 5.81              |

**Winner: async-8warp by 1.63x**

## Key Metrics Comparison

| Metric                                                | async-8warp | triple-buffer | Delta     |
|-------------------------------------------------------|-------------|---------------|-----------|
| sm__warps_active.avg.pct_of_peak_sustained_active     | 87.36%      | 66.47%        | -20.89pp  |
| sm__throughput.avg.pct_of_peak_sustained_elapsed      | 42.90%      | 26.53%        | -16.37pp  |
| gpu__compute_memory_throughput.avg.pct                | 50.37%      | 32.77%        | -17.60pp  |
| gpu__dram_throughput.avg.pct                          | 3.64%       | 3.97%         | +0.33pp   |
| l1tex__throughput.avg.pct_of_peak_sustained_active    | 52.91%      | 35.57%        | -17.34pp  |
| lts__throughput.avg.pct                               | 19.32%      | 13.35%        | -5.97pp   |
| launch__registers_per_thread                          | 30          | 29            | -1        |
| launch__shared_mem_per_block                          | 17.41 KB    | 25.60 KB      | +8.19 KB  |
| launch__occupancy_limit_shared_mem                    | 5 blocks    | 4 blocks      | -1 block  |
| Theoretical Occupancy                                 | 83.33%      | 66.67%        | -16.66pp  |
| Achieved Occupancy                                    | 87.36%      | 66.47%        | -20.89pp  |
| Achieved Active Warps/SM                              | 41.93       | 31.91         | -10.02    |
| Local Memory Spilling Requests                        | 0           | 0             | 0         |
| Shared Memory Spilling Requests                       | 0           | 0             | 0         |
| L1/TEX Hit Rate                                       | 75.89%      | 74.36%        | -1.53pp   |
| L2 Hit Rate                                           | 96.14%      | 90.59%        | -5.55pp   |
| Shared Bank Conflict (avg way)                        | 8.1-way     | 8.2-way       | +0.1      |
| CPI Stall: L1TEX Scoreboard                           | 14.2 cycles | 20.1 cycles   | +5.9 cyc  |
| CPI Stall: L1TEX % of total                           | 64.5%       | 72.2%         | +7.7pp    |
| Scheduler: One or More Eligible                       | 44.81%      | 28.53%        | -16.28pp  |
| Scheduler: No Eligible                                | 55.19%      | 71.47%        | +16.28pp  |
| Scheduler: Active Warps Per Scheduler                 | 9.90        | 7.95          | -1.95     |
| Scheduler: Eligible Warps Per Scheduler               | 0.83        | 0.44          | -0.39     |
| Executed IPC (active)                                 | 1.80        | 1.15          | -0.65     |
| Elapsed Cycles                                        | 8,080,041   | 12,460,578   | +54.2%    |

## Root-Cause Analysis

### Why triple-buffer is SLOWER

1. **Shared memory occupancy collapse (primary cause)**
   - Triple-buffer uses 3x staging per warp instead of 2x, raising shared mem per block from 17.41 KB to 25.60 KB (+47%)
   - This drops the occupancy limit from 5 blocks/SM to 4 blocks/SM
   - Theoretical occupancy drops from 83.33% to 66.67% (8 warps/SM scheduler down from 10)
   - Achieved occupancy drops 20.89 percentage points (87.36% -> 66.47%)

2. **Worse L1TEX scoreboard stalls (not better)**
   - Triple-buffer CPI L1TEX stall: 20.1 cycles (72.2% of total CPI)
   - Double-buffer CPI L1TEX stall: 14.2 cycles (64.5% of total CPI)
   - The extra buffer does NOT reduce scoreboard pressure; it INCREASES it by 41.5%
   - More shared memory to fill per tile = more global-to-shared load instructions in flight = more scoreboard stalls

3. **Scheduler starvation**
   - Eligible warps/scheduler: 0.83 (async8) vs 0.44 (triple) - a 47% reduction
   - Fewer active warps means fewer warps available to hide stalls
   - No Eligible cycles jump from 55.19% to 71.47%

4. **No register spilling in either variant** (both have 0 bytes spill stores/loads per ptxas)

### What the triple-buffer hypothesis got wrong

The hypothesis was that having a third buffer would let compute proceed on buffer N while filling buffer N+2, reducing handoff stalls. In practice:
- The additional shared memory cost destroys occupancy before any latency-hiding benefit can manifest
- The extra load instructions per tile iteration increase scoreboard pressure rather than reducing it
- On Blackwell (sm_120) with its 32-wide shared memory banks, the 8.1-8.2 way bank conflicts are identical in both variants

## Verdict

**Keep async-8warp (double-buffer) as the default fast-path.** The triple-buffer experiment is conclusively worse for 2048^3 GEMM on RTX 5060. The 1.67x runtime regression is driven by shared-memory-induced occupancy collapse and increased scoreboard stalls, not improved by the extra prefetch depth.

### Convergence Gate

```json
{
  "claim": "Triple-buffer variant is 1.67x slower than async-8warp for 2048^3 GEMM on RTX 5060 due to shared-memory occupancy collapse (83.3% -> 66.7% theoretical, 87.4% -> 66.5% achieved) and 41.5% higher L1TEX scoreboard stalls (14.2 -> 20.1 cycles CPI).",
  "evidence": "ncu_async8_2048.ncu-rep, ncu_triple_2048.ncu-rep, ncu_async8_2048_details.csv, ncu_triple_2048_details.csv",
  "verified_by": "kernel",
  "contradictions": [],
  "status": "proven"
}
```
