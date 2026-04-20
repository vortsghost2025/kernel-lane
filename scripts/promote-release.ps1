param(
  [Parameter(Mandatory=$true)]
  [string]$Version,
  [Parameter(Mandatory=$true)]
  [string]$ArtifactPath,
  [Parameter(Mandatory=$true)]
  [string]$BenchmarkReportPath,
  [Parameter(Mandatory=$true)]
  [string]$NsysReportPath,
  [Parameter(Mandatory=$true)]
  [string]$NcuReportPath,
  [string]$Notes = ''
)

$required = @($ArtifactPath, $BenchmarkReportPath, $NsysReportPath, $NcuReportPath)
foreach ($p in $required) {
  if (!(Test-Path $p)) { throw "Required file missing: $p" }
}

$releaseRoot = Join-Path $PSScriptRoot "..\releases\$Version"
New-Item -ItemType Directory -Force -Path $releaseRoot | Out-Null

$artifactDest = Join-Path $releaseRoot (Split-Path $ArtifactPath -Leaf)
$benchDest = Join-Path $releaseRoot (Split-Path $BenchmarkReportPath -Leaf)
$nsysDest = Join-Path $releaseRoot (Split-Path $NsysReportPath -Leaf)
$ncuDest = Join-Path $releaseRoot (Split-Path $NcuReportPath -Leaf)

Copy-Item -Path $ArtifactPath -Destination $artifactDest -Force
Copy-Item -Path $BenchmarkReportPath -Destination $benchDest -Force
Copy-Item -Path $NsysReportPath -Destination $nsysDest -Force
Copy-Item -Path $NcuReportPath -Destination $ncuDest -Force

$metrics = Get-Content -Raw -Path $benchDest | ConvertFrom-Json

$manifest = [ordered]@{
  version = $Version
  created_at_utc = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
  artifact = (Split-Path $artifactDest -Leaf)
  benchmark_report = (Split-Path $benchDest -Leaf)
  nsys_report = (Split-Path $nsysDest -Leaf)
  ncu_report = (Split-Path $ncuDest -Leaf)
  metrics = $metrics.metrics
  notes = $Notes
}

$manifestPath = Join-Path $releaseRoot 'manifest.json'
$manifest | ConvertTo-Json -Depth 8 | Set-Content -Path $manifestPath -Encoding UTF8

$indexPath = Join-Path $PSScriptRoot '..\releases\index.json'
$index = Get-Content -Raw -Path $indexPath | ConvertFrom-Json
if (-not $index.versions) { $index | Add-Member -NotePropertyName versions -NotePropertyValue @() }
$index.versions = @($index.versions | Where-Object { $_.version -ne $Version }) + @([ordered]@{
  version = $Version
  manifest = "releases/$Version/manifest.json"
  created_at_utc = $manifest.created_at_utc
})
$index | ConvertTo-Json -Depth 8 | Set-Content -Path $indexPath -Encoding UTF8

Write-Host "[PASS] Promoted release: $Version"
Write-Host "[MANIFEST] $manifestPath"
