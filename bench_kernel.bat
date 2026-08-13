@echo off
for /L %%i in (1,1,15) do (
    S:\kernel-lane\kernels\register_tiled_gemm.exe 2>&1 | findstr "TFLOPS"
)