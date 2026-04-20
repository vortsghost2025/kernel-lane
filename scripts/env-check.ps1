param()

function Resolve-ToolCommand {
  param(
    [Parameter(Mandatory = $true)][string]$ToolName
  )

  $cmd = Get-Command $ToolName -ErrorAction SilentlyContinue
  if ($cmd) {
    return $ToolName
  }

  if ($ToolName -eq 'nsys') {
    $candidates = @(
      'C:\Program Files\NVIDIA Corporation\Nsight Systems 2026.2.1\target-windows-x64\nsys.exe',
      'C:\Program Files\NVIDIA Corporation\Nsight Systems 2025.6.3\target-windows-x64\nsys.exe',
      'C:\Program Files\NVIDIA Corporation\Nsight Systems 2026.1.0\host-windows-x64\nsys.exe',
      'C:\Program Files\NVIDIA Corporation\Nsight Systems 2025.6.1\host-windows-x64\nsys.exe',
      'C:\Program Files\NVIDIA Corporation\Nsight Systems 2025.5.1\host-windows-x64\nsys.exe',
      'C:\Program Files\NVIDIA Corporation\Nsight Compute 2026.1.0\host\target-windows-x64\nsys.exe'
    )
    foreach ($path in $candidates) {
      if (Test-Path $path) {
        return $path
      }
    }
  }

  return $null
}

$checks = @('nvcc', 'ncu', 'nsys')

$allOk = $true
foreach ($name in $checks) {
  try {
    $resolved = Resolve-ToolCommand -ToolName $name
    if (-not $resolved) {
      throw "$name executable not found in PATH or default install locations."
    }
    Write-Host "[CHECK] $name"
    & $resolved --version | Out-Host
  }
  catch {
    Write-Host "[MISSING] ${name}: $($_.Exception.Message)"
    $allOk = $false
  }
}

if ($allOk) {
  Write-Host '[PASS] CUDA toolchain appears available.'
  exit 0
}

Write-Host '[FAIL] One or more required tools are missing.'
exit 1
