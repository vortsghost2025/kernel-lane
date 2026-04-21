param(
  [ValidateSet('Debug','Release')]
  [string]$Configuration = 'Release'
)

# --- MSVC Environment Bootstrap ---
# NVCC on Windows requires cl.exe (MSVC host compiler).
# Import the Visual Studio build environment if cl.exe is not already in PATH.
$vcvarsall = 'C:\Program Files\Microsoft Visual Studio\18\Community\VC\Auxiliary\Build\vcvarsall.bat'
if (-not (Get-Command 'cl.exe' -ErrorAction SilentlyContinue)) {
  if (Test-Path $vcvarsall) {
    Write-Host "[ENV] Importing MSVC environment from $vcvarsall"
    $output = cmd /c "`"$vcvarsall`" x64 > nul 2>&1 && set" 2>$null
    if ($LASTEXITCODE -eq 0) {
      foreach ($line in $output) {
        if ($line -match '^([^=]+)=(.*)$') {
          [System.Environment]::SetEnvironmentVariable($matches[1], $matches[2], 'Process')
        }
      }
      Write-Host "[ENV] MSVC environment imported successfully"
    } else {
      Write-Host "[WARN] Failed to import MSVC environment via vcvarsall.bat"
    }
  } else {
    Write-Host "[WARN] vcvarsall.bat not found at expected path. Build may fail if cl.exe is not in PATH."
  }
}

# Verify cl.exe is now available
if (-not (Get-Command 'cl.exe' -ErrorAction SilentlyContinue)) {
  Write-Host "[ERROR] cl.exe not found in PATH after environment bootstrap. Cannot compile host code."
  Write-Host "[HINT] Run this script from a Developer Command Prompt for VS, or ensure Visual Studio is installed."
  exit 1
}

$srcRoot = Join-Path $PSScriptRoot '..\kernels\src'
$buildDir = Join-Path $PSScriptRoot "..\build\$Configuration"
New-Item -ItemType Directory -Force -Path $buildDir | Out-Null

$cuFiles = Get-ChildItem -Path $srcRoot -Filter '*.cu' -ErrorAction SilentlyContinue
if (-not $cuFiles) {
  Write-Host "No .cu files found in $srcRoot"
  exit 0
}

$execCount = 0
$ptxCount = 0
foreach ($f in $cuFiles) {
  $containsMain = Select-String -Pattern 'int main\s*\(' -Path $f.FullName -Quiet
  if ($containsMain) {
    $out = Join-Path $buildDir ("{0}.exe" -f $f.BaseName)
    $cmd = "nvcc -o `"$out`" `"$($f.FullName)`" -O3 --use_fast_math"
    Write-Host "[BUILD] $cmd"
    cmd /c $cmd
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    $execCount++
  }
  else {
    $out = Join-Path $buildDir ("{0}.ptx" -f $f.BaseName)
    $cmd = "nvcc -ptx -o `"$out`" `"$($f.FullName)`" -O3 --use_fast_math"
    Write-Host "[BUILD] $cmd"
    cmd /c $cmd
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    $ptxCount++
  }
}

Write-Host "[PASS] Build complete: $buildDir"
Write-Host "[SUMMARY] ${execCount} executables and ${ptxCount} PTX files produced."
