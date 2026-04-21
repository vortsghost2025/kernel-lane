param(
  [Parameter(Mandatory=$true)]
  [string]$ExecutablePath,
  [string]$Args = '',
  [string]$Name = 'profile',
  [string]$Configuration = 'Release'
)

function Resolve-ToolCommand {
  param(
    [Parameter(Mandatory = $true)][string]$ToolName
  )

  $cmd = Get-Command $ToolName -ErrorAction SilentlyContinue
  if ($cmd) {
    return $ToolName
  }

  $candidates = @()
  if ($ToolName -eq 'nsys') {
    $candidates += @(
      'C:\Program Files\NVIDIA Corporation\Nsight Systems 2026.2.1\target-windows-x64\nsys.exe',
      'C:\Program Files\NVIDIA Corporation\Nsight Systems 2025.6.3\target-windows-x64\nsys.exe',
      'C:\Program Files\NVIDIA Corporation\Nsight Systems 2026.1.0\host-windows-x64\nsys.exe',
      'C:\Program Files\NVIDIA Corporation\Nsight Systems 2025.6.1\host-windows-x64\nsys.exe',
      'C:\Program Files\NVIDIA Corporation\Nsight Systems 2025.5.1\host-windows-x64\nsys.exe',
      'C:\Program Files\NVIDIA Corporation\Nsight Compute 2026.1.0\host\target-windows-x64\nsys.exe'
    )
  } elseif ($ToolName -eq 'ncu') {
    $candidates += @(
      'C:\Program Files\NVIDIA Corporation\Nsight Compute 2026.1.0\ncu.exe',
      'C:\Program Files\NVIDIA Corporation\Nsight Compute 2025.6.1\ncu.exe',
      'C:\Program Files\NVIDIA Corporation\Nsight Compute 2025.5.1\ncu.exe'
    )
  }

  foreach ($path in $candidates) {
    if (Test-Path $path) {
      return $path
    }
  }

  return $null
}

# Resolve the Executable Path
if (!(Test-Path $ExecutablePath)) {
  $buildPath = Join-Path $PSScriptRoot "..\build\$Configuration"
  $resolvedPath = Join-Path -Path $buildPath -ChildPath $ExecutablePath
  if (!(Test-Path $resolvedPath)) {
    throw "Executable not found: $ExecutablePath"
  }
  $ExecutablePath = $resolvedPath
}

$nsysDir = Join-Path $PSScriptRoot '..\profiles\nsys'
$ncuDir = Join-Path $PSScriptRoot '..\profiles\ncu'
New-Item -ItemType Directory -Force -Path $nsysDir, $ncuDir | Out-Null

$nsysExe = Resolve-ToolCommand -ToolName 'nsys'
if (-not $nsysExe) {
  throw 'nsys executable not found in PATH or default install locations.'
}

$ncuExe = Resolve-ToolCommand -ToolName 'ncu'
if (-not $ncuExe) {
  throw 'ncu executable not found in PATH or fallback locations.'
}

$nsysOut = Join-Path $nsysDir $Name
$ncuOut = Join-Path $ncuDir $Name

$nsysCmd = "`"$nsysExe`" profile -o `"$nsysOut`" `"$ExecutablePath`" $Args"
$ncuCmd = "`"$ncuExe`" --set full --export `"$ncuOut`" `"$ExecutablePath`" $Args"

Write-Host "[NSYS] $nsysCmd"
cmd /c $nsysCmd
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "[NCU] $ncuCmd"
cmd /c $ncuCmd
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

# Write JSON metadata files
$metaTimestamp = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')

$nsysMeta = [ordered]@{
  name           = $Name
  executable     = $ExecutablePath
  args           = $Args
  created_at_utc = $metaTimestamp
  tool           = 'nsys'
  output_files   = @($nsysOut)
}
$nsysMeta | ConvertTo-Json -Depth 4 | Set-Content -Path (Join-Path $nsysDir "${Name}_meta.json") -Encoding UTF8

$ncuMeta = [ordered]@{
  name           = $Name
  executable     = $ExecutablePath
  args           = $Args
  created_at_utc = $metaTimestamp
  tool           = 'ncu'
  output_files   = @($ncuOut)
}
$ncuMeta | ConvertTo-Json -Depth 4 | Set-Content -Path (Join-Path $ncuDir "${Name}_meta.json") -Encoding UTF8

Write-Host "[PASS] Profiling outputs at $nsysDir and $ncuDir"
