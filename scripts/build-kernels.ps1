param(
  [ValidateSet('Debug','Release')]
  [string]$Configuration = 'Release'
)

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
