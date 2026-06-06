@echo off
REM Profile the inference_wmma_matmul kernel with Nsight Compute
ncu --set full -o inference_wmma_profile --kernel-name inference_wmma_matmul kernels\src\inference_kernel.cu