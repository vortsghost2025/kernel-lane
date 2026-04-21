param(
  [Parameter(Mandatory=$true)]
  [string]$Version,
  [Parameter(Mandatory=$true)]
  [string]$ArtifactPath,
  [Parameter(Mandatory=$true)]
  [string]$BenchmarkReportPath,
  [string]$NsysReportPath = '',
  [Parameter(Mandatory=$true)]
  [string]$NcuReportPath,
  [string]$Claim = '',
  [string]$Notes = ''
)

# Required evidence: artifact, benchmark report, ncu report
$required = @($ArtifactPath, $BenchmarkReportPath, $NcuReportPath)
foreach ($p in $required) {
  if (!(Test-Path $p)) { throw "Required file missing: $p" }
}

# nsys report is strongly recommended but not mandatory (daemon issues may block)
$nsysMissing = $false
if ($NsysReportPath -and (Test-Path $NsysReportPath)) {
  # nsys evidence present
} elseif ($NsysReportPath) {
  throw "nsys report specified but not found: $NsysReportPath"
} else {
  $nsysMissing = $true
  Write-Host "[WARN] No nsys report provided. Release will note this as a blocker."
}

# Normalize version to always use 'v' prefix for directory names
$versionDir = if ($Version -match '^v') { $Version } else { "v$Version" }
$releaseRoot = Join-Path $PSScriptRoot "..\releases\$versionDir"
New-Item -ItemType Directory -Force -Path $releaseRoot | Out-Null

$artifactDest = Join-Path $releaseRoot (Split-Path $ArtifactPath -Leaf)
$benchDest = Join-Path $releaseRoot (Split-Path $BenchmarkReportPath -Leaf)
$ncuDest = Join-Path $releaseRoot (Split-Path $NcuReportPath -Leaf)

Copy-Item -Path $ArtifactPath -Destination $artifactDest -Force
Copy-Item -Path $BenchmarkReportPath -Destination $benchDest -Force
Copy-Item -Path $NcuReportPath -Destination $ncuDest -Force

if (-not $nsysMissing) {
  $nsysDest = Join-Path $releaseRoot (Split-Path $NsysReportPath -Leaf)
  Copy-Item -Path $NsysReportPath -Destination $nsysDest -Force
}

$metrics = Get-Content -Raw -Path $benchDest | ConvertFrom-Json

$manifest = [ordered]@{
    version = $versionDir
  created_at_utc = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
  artifact = (Split-Path $artifactDest -Leaf)
  benchmark_report = (Split-Path $benchDest -Leaf)
  nsys_report = if ($nsysMissing) { $null } else { (Split-Path $nsysDest -Leaf) }
  ncu_report = (Split-Path $ncuDest -Leaf)
  metrics = $metrics.metrics
  notes = $Notes
}

$manifestPath = Join-Path $releaseRoot 'manifest.json'
$manifest | ConvertTo-Json -Depth 8 | Set-Content -Path $manifestPath -Encoding UTF8

# --- Kernel Convergence Artifact ---
$convergenceClaim = if ($Claim) { $Claim } else { "Version $Version promoted with benchmark evidence" }

$convergenceEvidence = @()
if ($metrics.metrics) {
  if ($metrics.metrics.speedup_vs_baseline -ne $null) {
    $convergenceEvidence += "benchmark: speedup $($metrics.metrics.speedup_vs_baseline)x vs baseline"
  }
  if ($metrics.metrics.latency_ms -ne $null) {
    $convergenceEvidence += "benchmark: latency $($metrics.metrics.latency_ms) ms"
  }
  if ($metrics.metrics.throughput -ne $null) {
    $convergenceEvidence += "benchmark: throughput $($metrics.metrics.throughput)"
  }
}
$convergenceEvidence += "ncu: $(Split-Path $ncuDest -Leaf)"
if (-not $nsysMissing) {
  $convergenceEvidence += "nsys: $(Split-Path $nsysDest -Leaf)"
}

$convergenceArtifact = [ordered]@{
  type = "kernel_convergence"
  claim = $convergenceClaim
  evidence = $convergenceEvidence
    status = if ($nsysMissing) { "partial" } else { "proven" }
    next_blocker = if ($nsysMissing) { "nsys report missing - optional on Windows headless per RELEASE_CONTRACT.md platform policy; required on Linux" } else { $null }
    version = $versionDir
    created_at_utc = $manifest.created_at_utc
}

$convergencePath = Join-Path $releaseRoot 'convergence.json'
$convergenceArtifact | ConvertTo-Json -Depth 8 | Set-Content -Path $convergencePath -Encoding UTF8

# --- Promotion Broadcast ---
$outboxDir = Join-Path $PSScriptRoot '..\lanes\kernel\outbox'
New-Item -ItemType Directory -Force -Path $outboxDir | Out-Null

$broadcast = [ordered]@{
  type = "kernel_release_broadcast"
  version = $Version
  claim = $convergenceClaim
  evidence = $convergenceEvidence
  status = $convergenceArtifact.status
    manifest_path = "releases/$versionDir/manifest.json"
    convergence_path = "releases/$versionDir/convergence.json"
  created_at_utc = $manifest.created_at_utc
}

$broadcastPath = Join-Path $outboxDir "kernel_release_$versionDir.json"
$broadcast | ConvertTo-Json -Depth 8 | Set-Content -Path $broadcastPath -Encoding UTF8

# --- Update Index ---
$indexPath = Join-Path $PSScriptRoot '..\releases\index.json'
$index = Get-Content -Raw -Path $indexPath | ConvertFrom-Json
if (-not $index.versions) { $index | Add-Member -NotePropertyName versions -NotePropertyValue @() -Force }
$index.versions = @($index.versions | Where-Object { $_.version -ne $versionDir }) + @([ordered]@{
    version = $versionDir
    manifest = "releases/$versionDir/manifest.json"
    convergence = "releases/$versionDir/convergence.json"
  created_at_utc = $manifest.created_at_utc
})
$index | ConvertTo-Json -Depth 8 | Set-Content -Path $indexPath -Encoding UTF8

Write-Host "[PASS] Promoted release: $Version"
Write-Host "[MANIFEST] $manifestPath"
Write-Host "[CONVERGENCE] $convergencePath"
Write-Host "[BROADCAST] $broadcastPath"
if ($nsysMissing) {
  Write-Host "[WARN] nsys report is MISSING - convergence status is 'partial', not 'proven'"
}
