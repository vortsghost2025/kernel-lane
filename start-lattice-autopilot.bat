@echo off
REM Lattice Autopilot — One-Click Starter for Windows
REM Double-click this file OR run: start-lattice-autopilot.bat
REM Launches 4 PowerShell windows, each running its lane's inbox-watcher.ps1

echo Starting Lattice Autopilot...
echo.

set KERNEL_ROOT=S:\kernel-lane
set ARCHIVIST_ROOT=S:\Archivist-Agent
set LIBRARY_ROOT=S:\self-organizing-library
set SWARMMIND_ROOT=S:\SwarmMind

echo [1/4] Starting Kernel watcher...
start "Kernel-Watcher" powershell -NoExit -Command "Set-Location '%KERNEL_ROOT%'; .\scripts\inbox-watcher.ps1 -PollSeconds 30"
timeout /t 1 /nobreak >nul

echo [2/4] Starting Archivist watcher...
start "Archivist-Watcher" powershell -NoExit -Command "Set-Location '%ARCHIVIST_ROOT%'; .\scripts\inbox-watcher.ps1 -PollSeconds 30"
timeout /t 1 /nobreak >nul

echo [3/4] Starting Library watcher...
start "Library-Watcher" powershell -NoExit -Command "Set-Location '%LIBRARY_ROOT%'; .\scripts\inbox-watcher.ps1 -PollSeconds 30"
timeout /t 1 /nobreak >nul

echo [4/4] Starting SwarmMind watcher...
start "SwarmMind-Watcher" powershell -NoExit -Command "Set-Location '%SWARMMIND_ROOT%'; .\scripts\inbox-watcher.ps1 -PollSeconds 30"
timeout /t 1 /nobreak >nul

echo.
echo ================================
echo Lattice Autopilot started successfully.
echo Monitor the 4 PowerShell windows for activity.
echo.
echo To stop: close each window individually, or run:
echo   taskkill /f /im powershell.exe /fi "WINDOWTITLE eq *-Watcher"
echo ================================
pause