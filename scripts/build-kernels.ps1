param(
  [ValidateSet('Debug','Release')]
  [string]$Configuration = 'Release'
)

# Ensure MSVC host compiler is available (cl.exe)
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
      Write-Host "[ENV] MSVC environment imported"
    } else {
      Write-Host "[ERROR] Failed to import MSVC environment"
      exit 1
    }
  } else {
    Write-Host "[ERROR] cl.exe not found and vcvarsall.bat missing. Install Visual Studio C++ Build Tools."
    exit 1
  }
}

$srcRoot = Join-Path $PSScriptRoot '..\kernels\src'
$outDir = Join-Path $PSScriptRoot "..\kernels\bin"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

$cuFiles = Get-ChildItem -Path $srcRoot -Filter '*.cu' -File
if (-not $cuFiles) { Write-Host "No .cu files found"; exit 0 }

foreach ($f in $cuFiles) {
  $hasMain = Select-String -Pattern 'int\s+main\s*\(' -Path $f.FullName -Quiet
  if ($hasMain) {
    $outExe = Join-Path $outDir ("{0}.exe" -f $f.BaseName)
    $cmd = "nvcc -arch=sm_120 -lineinfo -std=c++17 -DCCCL_IGNORE_DEPRECATED_CPP_DIALECT -Xcompiler `"/Zc:preprocessor`" -o `"$outExe`" `"$($f.FullName)`" -O3 --use_fast_math"
    Write-Host "[BUILD] $cmd"
    cmd /c $cmd
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  }
}
Write-Host "[BUILD] Completed. Executables placed in $outDir"
