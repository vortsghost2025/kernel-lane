param(
[Parameter(Mandatory=$true)]
[string]$ExecutablePath,
[string]$Args = '',
[string]$Name = 'profile',
[string]$Configuration = 'Release',
[switch]$SkipNsys,
[switch]$Headless
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
$ncuExe = Resolve-ToolCommand -ToolName 'ncu'

if (-not $ncuExe) {
  throw 'ncu executable not found in PATH or fallback locations.'
}

$ncuOut = Join-Path $ncuDir $Name
$ncuCmd = "`"$ncuExe`" --set full --export `"$ncuOut`" `"$ExecutablePath`" $Args"

Write-Host "[NCU] $ncuCmd"
cmd /c $ncuCmd
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

if ($SkipNsys -or $Headless) {
  Write-Host "[NSYS] Skipped ($($SkipNsys ? 'explicit skip' : 'headless mode'))"
} elseif (-not $nsysExe) {
  Write-Host "[NSYS] WARNING: nsys not found, skipping system-level trace"
} else {
  $nsysOut = Join-Path $nsysDir $Name
  $nsysCmd = "`"$nsysExe`" profile -o `"$nsysOut`" `"$ExecutablePath`" $Args"
  Write-Host "[NSYS] $nsysCmd (requires interactive daemon — may timeout if headless)"
  cmd /c $nsysCmd
  if ($LASTEXITCODE -ne 0) {
    Write-Host "[NSYS] WARNING: nsys failed (exit $LASTEXITCODE). Daemon may not be running."
    Write-Host "[NSYS] Run scripts/setup-nsys-daemon.ps1 from a desktop session to fix."
  }
}

# Write JSON metadata files
$metaTimestamp = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')

$nsysMeta = [ordered]@{
  name = $Name
  executable = $ExecutablePath
  args = $Args
  created_at_utc = $metaTimestamp
  tool = 'nsys'
  skipped = ($SkipNsys -or $Headless -or -not $nsysExe)
  skip_reason = if ($SkipNsys) { 'explicit skip' } elseif ($Headless) { 'headless mode - nsys daemon requires interactive desktop to accept agent dialog' } elseif (-not $nsysExe) { 'nsys not found in PATH or fallback locations' } else { $null }
  output_files = if ($SkipNsys -or $Headless -or -not $nsysExe) { @() } else { @($nsysOut) }
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
