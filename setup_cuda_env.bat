@echo off
REM Script to set up the Visual Studio environment for nvcc on Windows

set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
if not exist "%VSWHERE%" (
    echo ERROR: vswhere.exe not found. Please install Visual Studio Installer.
    exit /b 1
)

REM Find the latest Visual Studio installation that includes the VC++ build tools
for /f "usebackq delims=" %%a in (`"%VSWHERE%" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -find **\VC\Auxiliary\Build\vcvarsall.bat`) do set "VCVARSALL=%%a"

if not defined VCVARSALL (
    echo ERROR: Could not find vcvarsall.bat. Please install Visual Studio with C++ build tools.
    echo You can install the Build Tools for Visual Studio from:
    echo https://visualstudio.microsoft.com/downloads/
    exit /b 1
)

echo Found vcvarsall.bat at: %VCVARSALL%
call "%VCVARSALL%" x64

REM Check if the environment is set up
if "%VSINSTALLDIR%"=="" (
    echo ERROR: Failed to set up Visual Studio environment.
    exit /b 1
)

echo Visual Studio environment set up successfully.