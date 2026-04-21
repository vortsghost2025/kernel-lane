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

# Detect platform: nsys is required on Linux, optional on Windows headless
$isWindows = ($env:OS -eq 'Windows_NT')

# nsys report is strongly recommended but not mandatory (daemon issues may block)
$nsysMissing = $false
if ($NsysReportPath -and (Test-Path $NsysReportPath)) {
    # nsys evidence present
} elseif ($NsysReportPath) {
    throw "nsys report specified but not found: $NsysReportPath"
} else {
    $nsysMissing = $true
    if ($isWindows) {
        Write-Host "[INFO] No nsys report provided. Windows headless: nsys is optional per platform policy."
    } else {
        Write-Host "[WARN] No nsys report provided. On Linux, nsys is required for 'proven' convergence."
    }
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

# Parse benchmark report — normalize unescaped backslashes before ConvertFrom-Json
# PowerShell's ConvertFrom-Json chokes on bare backslashes like build\Release
$benchRaw = Get-Content -Raw -Path $benchDest
$benchFixed = $benchRaw -replace '(?<!\\)\\(?!["\\/bfnrtu])', '\\'
$metrics = $benchFixed | ConvertFrom-Json

# Validate metrics are present and non-null — fail closed on missing data
if ($null -eq $metrics -or $null -eq $metrics.metrics) {
  throw "METRICS_MISSING: benchmark report contains no metrics object — cannot promote without quantitative evidence"
}
$metricsObj = $metrics.metrics
$metricFields = @('speedup_vs_baseline', 'latency_ms', 'throughput')
$presentMetrics = @()
foreach ($field in $metricFields) {
  $val = $metricsObj.PSObject.Properties.Match($field) | Select-Object -First 1
  if ($null -ne $val -and $null -ne $val.Value) {
    $presentMetrics += $field
  }
}
if ($presentMetrics.Count -eq 0) {
  throw "METRICS_ALL_NULL: speedup_vs_baseline, latency_ms, and throughput are all null — cannot promote without at least one valid metric"
}

$manifest = [ordered]@{
  version = $versionDir
  created_at_utc = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
  artifact = (Split-Path $artifactDest -Leaf)
  artifact_sha256 = (Get-FileHash -Path $artifactDest -Algorithm SHA256).Hash.ToLower()
  benchmark_report = (Split-Path $benchDest -Leaf)
  benchmark_sha256 = (Get-FileHash -Path $benchDest -Algorithm SHA256).Hash.ToLower()
  nsys_report = if ($nsysMissing) { $null } else { (Split-Path $nsysDest -Leaf) }
  nsys_sha256 = if ($nsysMissing) { $null } else { (Get-FileHash -Path $nsysDest -Algorithm SHA256).Hash.ToLower() }
  ncu_report = (Split-Path $ncuDest -Leaf)
  ncu_sha256 = (Get-FileHash -Path $ncuDest -Algorithm SHA256).Hash.ToLower()
  metrics = $metricsObj
  metrics_validated = $presentMetrics
  notes = $Notes
}

$manifestPath = Join-Path $releaseRoot 'manifest.json'
$manifest | ConvertTo-Json -Depth 8 | Set-Content -Path $manifestPath -Encoding UTF8

# --- Kernel Convergence Artifact ---
$convergenceClaim = if ($Claim) { $Claim } else { "Version $Version promoted with benchmark evidence" }

$convergenceEvidence = @()
if ($metricsObj.speedup_vs_baseline -ne $null) {
  $convergenceEvidence += "benchmark: speedup $($metricsObj.speedup_vs_baseline)x vs baseline"
}
if ($metricsObj.latency_ms -ne $null) {
  $convergenceEvidence += "benchmark: latency $($metricsObj.latency_ms) ms"
}
if ($metricsObj.throughput -ne $null) {
  $convergenceEvidence += "benchmark: throughput $($metricsObj.throughput)"
}
$convergenceEvidence += "ncu: $(Split-Path $ncuDest -Leaf)"
if (-not $nsysMissing) {
    $convergenceEvidence += "nsys: $(Split-Path $nsysDest -Leaf)"
} elseif ($isWindows) {
    $convergenceEvidence += "nsys: not collected (optional on Windows headless per platform policy)"
}

# Platform-aware convergence status:
# - nsys present: "proven" on all platforms
# - nsys missing on Windows: "proven" (nsys optional per platform policy)
# - nsys missing on Linux: "partial" (nsys required on Linux)
$convergenceStatus = if ($nsysMissing -and -not $isWindows) { "partial" } else { "proven" }
$convergenceBlocker = if ($nsysMissing -and -not $isWindows) {
    "nsys report missing - required on Linux per RELEASE_CONTRACT.md platform policy"
} elseif ($nsysMissing -and $isWindows) {
    "nsys report missing - optional on Windows headless per platform policy; nsys present => proven"
} else {
    $null
}

$convergenceArtifact = [ordered]@{
    type = "kernel_convergence"
    claim = $convergenceClaim
    evidence = $convergenceEvidence
    status = $convergenceStatus
    next_blocker = $convergenceBlocker
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

# Enforce signed outbox emission (fail closed)
$signScript = Join-Path $PSScriptRoot 'sign-outbox-message.js'
if (!(Test-Path $signScript)) {
  throw "Signing helper missing: $signScript"
}
& node $signScript --message $broadcastPath --lane kernel
if ($LASTEXITCODE -ne 0) {
  throw "Outbox signing failed for $broadcastPath"
}

# --- Update Index ---
$indexPath = Join-Path $PSScriptRoot '..\releases\index.json'
$indexRaw = Get-Content -Raw -Path $indexPath
$indexFixed = $indexRaw -replace '(?<!\\)\\(?!["\\/bfnrtu])', '\\'
$index = $indexFixed | ConvertFrom-Json
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
if ($nsysMissing -and -not $isWindows) {
    Write-Host "[WARN] nsys report is MISSING on Linux - convergence status is 'partial', not 'proven'"
} elseif ($nsysMissing -and $isWindows) {
    Write-Host "[INFO] nsys report not provided (Windows headless) - convergence status is 'proven' per platform policy"
}
