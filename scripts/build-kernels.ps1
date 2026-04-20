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

foreach ($f in $cuFiles) {
  $out = Join-Path $buildDir ("{0}.ptx" -f $f.BaseName)
  $cmd = "nvcc -ptx `"$($f.FullName)`" -o `"$out`" -O3 --use_fast_math"
  Write-Host "[BUILD] $cmd"
  cmd /c $cmd
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

Write-Host "[PASS] Build complete: $buildDir"
