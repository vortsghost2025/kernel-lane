@echo off
nvcc -arch=sm_120 -O3 -o matrix_benchmark.exe kernels\src\matrix_benchmark.cu