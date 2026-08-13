@echo off
call "C:\Program Files\Microsoft Visual Studio\18\Community\VC\Auxiliary\Build\vcvarsall.bat" x64
"C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v13.3\bin\nvcc.exe" -arch=sm_120 -lineinfo -std=c++17 -DCCCL_IGNORE_DEPRECATED_CPP_DIALECT -Xcompiler "/Zc:preprocessor" -O3 --use_fast_math -o S:\kernel-lane\kernels\register_tiled_gemm.exe S:\kernel-lane\kernels\src\register_tiled_gemm.cu