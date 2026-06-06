@echo off
REM Try to find vcvarsall.bat in common Visual Studio installations
set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
if not exist "%VSWHERE%" (
    echo ERROR: vswhere.exe not found. Please install Visual Studio Build Tools.
    exit /b 1
)

REM Find the latest Visual Studio installation
for /f "usebackq delims=" %%a in (`"%VSWHERE%" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -find **\VC\Auxiliary\Build\vcvarsall.bat`) do set "VCVARSALL=%%a"

if not defined VCVARSALL (
    echo ERROR: Could not find vcvarsall.bat. Please install Visual Studio with C++ build tools.
    exit /b 1
)

echo Found vcvarsall.bat at: %VCVARSALL%
call "%VCVARSALL%" x64

REM Now compile the CUDA file
nvcc -arch=sm_120 -O3 -o inference_kernel.exe kernels\src\inference_kernel.cu