@echo off
nvcc -arch=sm_120 -O3 -o inference_kernel.exe kernels\src\inference_kernel.cu