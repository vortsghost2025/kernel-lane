param(
  [string]$Name = 'run',
  [string]$ExecutablePath,
  [string]$Configuration = 'Release',
  [string]$Args = '',
  [string]$Notes = 'Automated benchmark run',
  [string]$BaselineReport = 'benchmarks/reports/baseline.json'
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
    command = ("$ExecutablePath $Args" -replace '\\', '\\')
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

# Regression Checking Logic
$configPath = Join-Path $PSScriptRoot '..\config\targets.json'
$threshold = 2.0
$requireExplanation = $false
if (Test-Path $configPath) {
    $cfg = Get-Content $configPath | ConvertFrom-Json
    if ($cfg.baseline_policy.regression_threshold_pct) {
        $threshold = [float]$cfg.baseline_policy.regression_threshold_pct
    }
    if ($cfg.baseline_policy.require_explanation_on_regression) {
        $requireExplanation = [bool]$cfg.baseline_policy.require_explanation_on_regression
    }
}

$baselineExists = Test-Path $BaselineReport
if ($baselineExists) {
    $baselineData = Get-Content $BaselineReport | ConvertFrom-Json
    $previousLatency = $baselineData.metrics.latency_ms
    $previousThroughput = $baselineData.metrics.throughput
  $latencyRegressed = $false
  $throughputRegressed = $false

  # Check for latency regression
  if ($result.metrics.latency_ms -gt ($previousLatency * (1 + $threshold / 100))) {
    $latencyRegressed = $true
  }

  # Check for throughput regression
  if ($result.metrics.throughput -lt ($previousThroughput * (1 - $threshold / 100))) {
    $throughputRegressed = $true
  }

  # Prepare output for regression check
  $regressionCheck = [ordered]@{
    baseline_report = $BaselineReport
    threshold_pct = $threshold
    latency_change_pct = if ($latencyRegressed) { ((($result.metrics.latency_ms - $previousLatency) / $previousLatency) * 100) } else { 0 }
    throughput_change_pct = if ($throughputRegressed) { ((($previousThroughput - $result.metrics.throughput) / $previousThroughput) * 100) } else { 0 }
    passed = -not ($latencyRegressed -or $throughputRegressed)
  }

  # Update result with regression check
  $result | Add-Member -MemberType NoteProperty -Name regression_check -Value $regressionCheck

  if ($latencyRegressed -or $throughputRegressed) {
    Write-Host "[REGRESSION] Metrics regressed beyond threshold."
    exit 1
  }
}
else {
  Write-Host "[WARNING] No baseline report exists, skipping regression checks."
  $result | Add-Member -MemberType NoteProperty -Name regression_check -Value @{
    baseline_report = $BaselineReport
    threshold_pct = 0
    latency_change_pct = 0
    throughput_change_pct = 0
    passed = $true
  }
}

# Write report to JSON
$result | ConvertTo-Json -Depth 8 | Set-Content -Path $out -Encoding UTF8
Write-Host "[PASS] Wrote benchmark report: $out"