@echo off
REM === Nsight Systems One-Time Fix ===
REM
REM Run this from a REGULAR Command Prompt (not from an AI agent).
REM This launches nsys from your desktop session so the daemon can start.
REM
REM If a dialog/popup appears, click ACCEPT.
REM After this succeeds, headless nsys will work until reboot.

echo Launching Nsight Systems daemon test...
echo If a dialog appears, click ACCEPT.
echo.

"C:\Program Files\NVIDIA Corporation\Nsight Systems 2026.2.1\target-windows-x64\nsys.exe" profile --trace=cuda --sample=none --cpuctxsw=none --duration=5 --force-overwrite=true --output S:\kernel-lane\profiles\nsys\first-run S:\kernel-lane\build\Release\matrix_benchmark.exe

if %ERRORLEVEL% EQU 0 (
    echo.
    echo SUCCESS: nsys profiling completed!
    echo The daemon is now running. Headless sessions will work until reboot.
    dir S:\kernel-lane\profiles\nsys\first-run*
) else (
    echo.
    echo FAILED with exit code %ERRORLEVEL%
    echo Try running nsys-ui.exe first to accept any EULA:
    echo   "C:\Program Files\NVIDIA Corporation\Nsight Systems 2026.2.1\host-windows-x64\nsys-ui.exe"
    echo Then run this script again.
)

pause
