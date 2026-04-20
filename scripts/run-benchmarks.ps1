param(
  [string]$Name = 'run',
  [string]$BenchmarkCommand = ''
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

$result = [ordered]@{
  name = $Name
  created_at_utc = $ts
  gpu = $gpuName
  command = $BenchmarkCommand
  notes = 'Fill metrics after benchmark execution.'
  metrics = [ordered]@{
    latency_ms = $null
    throughput = $null
    speedup_vs_baseline = $null
  }
}

if ($BenchmarkCommand) {
  Write-Host "[RUN] $BenchmarkCommand"
  cmd /c $BenchmarkCommand
}

$result | ConvertTo-Json -Depth 8 | Set-Content -Path $out -Encoding UTF8
Write-Host "[PASS] Wrote benchmark report: $out"
