@echo off
call "C:\Program Files\Microsoft Visual Studio\18\Community\VC\Auxiliary\Build\vcvarsall.bat" x64
set PATH=C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v13.2\bin;%PATH%
nvcc -arch=sm_120 -O3 --ptxas-options=-v -lineinfo -std=c++17 -Xcompiler "/Zc:preprocessor" -DCCCL_IGNORE_MSVC_TRADITIONAL_PREPROCESSOR_WARNING -DCCCL_IGNORE_DEPRECATED_CPP_DIALECT -o matrix_tensor_optimized S:\kernel-lane\kernels\src\matrix_tensor_optimized.cu