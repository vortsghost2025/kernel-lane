param(
  [string]$Name = 'run',
  [string]$ExecutablePath,
  [string]$Configuration = 'Release',
  [string]$Args = '',
  [string]$Notes = 'Automated benchmark run'
)

$reportDir = Join-Path $PSScriptRoot '..\benchmarks\reports'
New-Item -ItemType Directory -Force -Path $reportDir | Out-Null
$ts = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
$out = Join-Path $reportDir ("$Name.json")

$gpuName = ''
try {
  $gpuName = (nvidia-smi --query-gpu=name --format=csv,noheader | Select-Object -First 1).Trim()
}
catch {
  $gpuName = 'unknown'
}

# Resolve the executable path
if (-not (Test-Path $ExecutablePath)) {
  $buildPath = Join-Path $PSScriptRoot "..\build\$Configuration"
  $ExecutablePath = Join-Path $buildPath $ExecutablePath
}

# Validate executable exists
if (-not (Test-Path $ExecutablePath)) {
  throw "Executable not found: $ExecutablePath"
}

$result = [ordered]@{
  name = $Name
  created_at_utc = $ts
  gpu = $gpuName
  command = "$ExecutablePath $Args"
  notes = $Notes
  metrics = [ordered]@{
    latency_ms = $null
    throughput = $null
    speedup_vs_baseline = $null
  }
}

Write-Host "[RUN] $ExecutablePath $Args"

# Capture output from the executable
$output = & $ExecutablePath $Args 2>&1 | Out-String

# Attempt to parse latency and throughput from stdout
if ($output -match '(\d+\.\d+)\s+ms') {
  $result.metrics.latency_ms = [float]$matches[1]
}
if ($output -match '(\d+\.\d+)\s+ops/sec') {
  $result.metrics.throughput = [float]$matches[1]
}

# Write report to JSON
$result | ConvertTo-Json -Depth 8 | Set-Content -Path $out -Encoding UTF8
Write-Host "[PASS] Wrote benchmark report: $out"
