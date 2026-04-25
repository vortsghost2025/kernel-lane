@echo off
call "C:\Program Files\Microsoft Visual Studio\18\Community\VC\Auxiliary\Build\vcvarsall.bat" x64
"C:\NVIDIA_CUDA_Installer\bin\nvcc.exe" -arch=sm_89 -O3 -o "S:\kernel-lane\kernels\src\matrix_tensor_optimized.exe" "S:\kernel-lane\kernels\src\matrix_tensor_optimized.cu"
if %errorlevel% equ 0 (
    echo Build successful
) else (
    echo Build failed with error %errorlevel%
)
