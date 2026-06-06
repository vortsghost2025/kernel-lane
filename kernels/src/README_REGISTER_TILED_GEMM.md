# Register Tiled GEMM Implementation

This file contains a register-tiled GEMM kernel designed to improve arithmetic intensity and reduce global memory pressure on NVIDIA GPUs.

## Overview

The kernel uses:
- 2D thread blocks of size (BLOCK_SIZE, BLOCK_SIZE) = (16, 16)
- Each thread computes a tile of size (THREAD_TILE_M, THREAD_TILE_N) = (4, 4)
- Shared memory tiles of size BK = 16 in the K dimension
- The block computes a tile of size (BLOCK_SIZE * THREAD_TILE_M, BLOCK_SIZE * THREAD_TILE_N) = (64, 64)

## Usage

To use this kernel in your application:

1. Include the kernel code in your CUDA file.
2. Call the host function `launch_register_tiled_gemm` with your matrices:
   ```cpp
   launch_register_tiled_gemm(d_A, d_B, d_C, M, N, K);
   ```
   where `d_A`, `d_B`, `d_C` are device pointers to matrices A (MxK), B (KxN), and C (MxN).

## Compilation

This kernel requires a CUDA-capable GPU and the NVIDIA CUDA Toolkit. It also requires a host compiler (such as Visual Studio on Windows).

### On Windows with Visual Studio:
1. Install Visual Studio with the C++ build tools.
2. Open the "x64 Native Tools Command Prompt for VS" from the Start menu.
3. Navigate to the directory containing this file.
4. Compile with:
   ```
   nvcc -arch=sm_120 -O3 -o register_tiled_gemm_test.exe register_tiled_gemm.cu
   ```
5. Run the executable:
   ```
   register_tiled_gemm_test.exe
   ```

### On Linux:
Install the CUDA toolkit and a host compiler (like gcc), then compile with:
```
nvcc -arch=sm_120 -O3 -o register_tiled_gemm_test register_tiled_gemm.cu
./register_tiled_gemm_test
```

## Performance Expectations

On an RTX 5060 (Ada Lovelace, compute capability 12.x), we expect:
- Improved arithmetic intensity compared to naive or tiled implementations
- Better utilization of memory bandwidth
- Potential speedup of 1.5-2.5x over the current tiled implementation (32x32 tiles) for large matrices

## Notes

- The kernel assumes matrices are in row-major order.
- The kernel does not perform any input validation beyond bounds checking.
- For production use, consider adding error handling and tuning the tile sizes (BLOCK_SIZE, THREAD_TILE_M, THREAD_TILE_N, BK) for your specific GPU and problem sizes.

## References

- CUDA C++ Programming Guide: Chapter on Matrix Multiplication
- NVIDIA Blog: "How to Optimize Matrix Multiplication in CUDA"