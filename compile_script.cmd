cd /d "S:\kernel-lane\kernels\src"
call "C:\Program Files\Microsoft Visual Studio\18\Community\VC\Auxiliary\Build\vcvarsall.bat" x64
nvcc -arch=sm_89 -O3 -std=c++17 -o matrix_tensor_optimized.exe matrix_tensor_optimized.cu -Xcompiler "/Zc:preprocessor"
