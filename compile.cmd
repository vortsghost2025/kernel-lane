C:\"
"Microsoft Visual Studio\"\VC\Auxiliary\Build\vcvarsall.bat" x64 >nul 2>&1
"C:\
"Program Files\"\NVIDIA GPU Computing Toolkit\CUDA\v12.6\bin\nvcc.exe" -arch=sm_89 -O3 -o "S:\kernel-lane\kernels\src\matrix_tensor_optimized.exe" "S:\kernel-lane\kernels\src\matrix_tensor_optimized.cu"
