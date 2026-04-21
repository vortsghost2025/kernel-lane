@echo off
set NSYS_EULA_ACCEPT=1
"C:\Program Files\NVIDIA Corporation\Nsight Systems 2026.2.1\target-windows-x64\nsys.exe" profile --trace=cuda --sample=none --cpuctxsw=none --duration=5 --force-overwrite=true --output S:\kernel-lane\profiles\nsys\bat-test S:\kernel-lane\build\Release\matrix_benchmark.exe
echo EXIT_CODE=%ERRORLEVEL%
