@echo off
call "C:\Program Files\Microsoft Visual Studio\18\Community\VC\Auxiliary\Build\vcvarsall.bat" x64
if %errorlevel% neq 0 exit /b %errorlevel%
"C:\NVIDIA_CUDA_Installer\bin\nvcc.exe" -arch^=sm_89 -O3 -o "S:\kernel-lane\kernels\src\matrix_tensor_optimized.exe" "S:\kernel-lane\kernels\src\matrix_tensor_optimized.cu"
if %errorlevel% neq 0 exit /b %errorlevel%
echo Build successful: %outFile%
