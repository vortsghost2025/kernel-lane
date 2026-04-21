param(
  [Parameter(Mandatory=$true)]
  [string]$Version,
  [Parameter(Mandatory=$true)]
  [string]$Claim,
  [Parameter(Mandatory=$true)]
  [string[]]$Evidence,
  [string]$NextBlocker = '',
  [string]$Notes = ''
)

# Kernel Rejection Script
# Produces a machine-enforceable rejection artifact when a kernel optimization
# fails to meet promotion criteria. This ensures negative knowledge is preserved
# in the system — failed optimizations do not silently disappear.

$rejectionRoot = Join-Path $PSScriptRoot "..\releases\$Version"
if (!(Test-Path $rejectionRoot)) {
  New-Item -ItemType Directory -Force -Path $rejectionRoot | Out-Null
}

$rejectionArtifact = [ordered]@{
  type = "kernel_rejection"
  claim = $Claim
  evidence = $Evidence
  status = "rejected"
  next_blocker = if ($NextBlocker) { $NextBlocker } else { $null }
  version = $Version
  created_at_utc = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
  notes = $Notes
}

$rejectionPath = Join-Path $rejectionRoot 'rejection.json'
$rejectionArtifact | ConvertTo-Json -Depth 8 | Set-Content -Path $rejectionPath -Encoding UTF8

# --- Broadcast Rejection to Outbox ---
# Other lanes need to know about rejections too — Library may use rejection
# evidence to block similar optimization attempts in other lanes.
$outboxDir = Join-Path $PSScriptRoot '..\lanes\kernel\outbox'
New-Item -ItemType Directory -Force -Path $outboxDir | Out-Null

$broadcast = [ordered]@{
  type = "kernel_rejection_broadcast"
  version = $Version
  claim = $Claim
  evidence = $Evidence
  status = "rejected"
  next_blocker = if ($NextBlocker) { $NextBlocker } else { $null }
  rejection_path = "releases/$Version/rejection.json"
  created_at_utc = $rejectionArtifact.created_at_utc
}

$broadcastPath = Join-Path $outboxDir "kernel_rejection_$Version.json"
$broadcast | ConvertTo-Json -Depth 8 | Set-Content -Path $broadcastPath -Encoding UTF8

Write-Host "[REJECTED] Version: $Version"
Write-Host "[CLAIM] $Claim"
Write-Host "[EVIDENCE] $($Evidence -join ', ')"
Write-Host "[REJECTION] $rejectionPath"
Write-Host "[BROADCAST] $broadcastPath"
