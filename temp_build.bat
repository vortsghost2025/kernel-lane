@echo off
call "C:\Program Files\Microsoft Visual Studio\18\Community\VC\Auxiliary\Build\vcvarsall.bat" x64
"C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v12.6\bin\nvcc.exe" -arch=sm_120 -O3 --ptxas-options=-v -lineinfo -Xcompiler "/Zc:preprocessor" -DCCCL_IGNORE_DEPRECATED_CPP_DIALECT -o matrix_tensor_optimized S:\kernel-lane\kernels\src\matrix_tensor_optimized.cu