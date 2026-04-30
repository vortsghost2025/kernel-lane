<#
.SYNOPSIS
 Adaptive watcher: inbox -> lane-worker -> task-executor -> relay-daemon

.DESCRIPTION
 Single-pass watcher that processes inbox files for specified lanes.
 Defaults to own-lane-only (swarmmind) to avoid cross-lane interference.
 Use -Lanes to specify which lanes to process.

 Respects agent presence: when an agent is active on a lane, the watcher
 skips that lane and logs inbox state instead.

 Designed for scheduled task invocation (single pass per trigger),
 NOT infinite loop. The scheduled task controls repetition.

 Agent presence is detected via:
 - agent-active.lock file in lane state dir
 - watcher-mode.json set to agent-assist, manual, or disabled

.PARAMETER PollSeconds
 Unused (kept for compat). Script runs one pass and exits.

.PARAMETER Lanes
 Which lanes to process. Default: swarmmind (own-lane-only).
 Use "all" for legacy multi-lane mode.

.PARAMETER LogFile
 Path to log file. Default: scripts/inbox-watcher.log

.PARAMETER SkipExecutor
 Skip task-executor step.

.PARAMETER AgentPresenceScript
 Path to agent-presence.js.

.EXAMPLE
 .\scripts\inbox-watcher.ps1
 .\scripts\inbox-watcher.ps1 -Lanes swarmmind
 .\scripts\inbox-watcher.ps1 -Lanes all
#>

param(
  [int]$PollSeconds = 0,
  [string[]]$Lanes = @("swarmmind"),
  [string]$LogFile = "$PSScriptRoot\inbox-watcher.log",
  [string]$NodeExe = "C:\Program Files\nodejs\node.exe",
  [string]$AgentPresenceScript = "$PSScriptRoot\agent-presence.js",
  [switch]$SkipExecutor = $false
)

function Write-Log {
  param([string]$msg)
  $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  "$ts $msg" | Out-File -FilePath $LogFile -Append -Encoding utf8
  Write-Host "$ts $msg"
}

$AllLaneRoots = @{
  archivist = "S:\Archivist-Agent"
  kernel = "S:\kernel-lane"
  library = "S:\self-organizing-library"
  swarmmind = "S:\SwarmMind"
}

if ($Lanes -contains "all") {
  $ActiveLanes = $AllLaneRoots.Keys
} else {
  $ActiveLanes = $Lanes
}

$ArchivistRoot = "S:\Archivist-Agent"

function Count-Files([string]$dir, [string]$filter = "*.json") {
  if (-not (Test-Path $dir)) { return 0 }
  return (Get-ChildItem -Path $dir -Filter $filter -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -notlike "heartbeat*" }).Count
}

function Run-Step([string]$name, [string]$script, [string]$argLine, [string]$cwd) {
  $prevDir = Get-Location
  try {
    if ($cwd) { Set-Location $cwd }
    $stepArgs = @($script) + @($argLine.Split(' ') | Where-Object { $_ })
    $result = & $NodeExe @stepArgs 2>&1
    $resultStr = ($result | Out-String).Trim()
    Write-Log "  [$name] $resultStr"
    return ($LASTEXITCODE -eq 0)
  } catch {
    Write-Log "  [$name] ERROR: $_"
    return $false
  } finally {
    Set-Location $prevDir
  }
}

function Test-ShouldProcess([string]$lane) {
  try {
    & $NodeExe $AgentPresenceScript "check" $lane 2>$null
    return ($LASTEXITCODE -eq 0)
  } catch {
    return $true
  }
}

Write-Log "[watcher] Single-pass - lanes: $($ActiveLanes -join ',') - skipExecutor=$SkipExecutor"
Write-Log "[watcher] Pipeline: lane-worker -> task-executor -> relay-daemon"

$anyActivity = $false

foreach ($lane in $ActiveLanes) {
  if (-not $AllLaneRoots.ContainsKey($lane)) {
    Write-Log "[watcher] Unknown lane: $lane - skipping"
    continue
  }

  $root = $AllLaneRoots[$lane]
  $inboxDir = Join-Path $root "lanes\$lane\inbox"
  $arDir = Join-Path $root "lanes\$lane\inbox\action-required"
  $outboxDir = Join-Path $root "lanes\$lane\outbox"

  $inboxCount = Count-Files $inboxDir
  $arCount = Count-Files $arDir
  $outboxCount = Count-Files $outboxDir

  if ($inboxCount -eq 0 -and $arCount -eq 0 -and $outboxCount -eq 0) { continue }

  $shouldProcess = Test-ShouldProcess $lane

  if (-not $shouldProcess) {
    Write-Log "[watcher] ${lane} SKIPPED (agent active or mode=manual/disabled) inbox=$inboxCount ar=$arCount outbox=$outboxCount"
    continue
  }

  Write-Log "[watcher] ${lane} inbox=$inboxCount ar=$arCount outbox=$outboxCount"

  if ($inboxCount -gt 0) {
    Write-Log "[watcher] Step 1: Running lane-worker for ${lane}"
    Run-Step "lane-worker" "$root\scripts\lane-worker.js" "--lane $lane --apply" $root
    if ($lane -eq "swarmmind") {
      Run-Step "codex-wake" "$root\scripts\codex-wake-packet.js" "--apply" $root
    }
    $anyActivity = $true
  }

  if (-not $SkipExecutor -and $arCount -gt 0) {
    Write-Log "[watcher] Step 2: Running task-executor for ${lane}"
    $executorScript = "$ArchivistRoot\scripts\generic-task-executor.js"
    Run-Step "task-executor" $executorScript "$lane --apply" $root
    if ($lane -eq "swarmmind") {
      Run-Step "codex-wake" "$root\scripts\codex-wake-packet.js" "--apply" $root
    }
    $anyActivity = $true
  }

  if ($outboxCount -gt 0) {
    Write-Log "[watcher] Step 3: Running relay-daemon for ${lane}"
    Run-Step "relay-daemon" "$root\scripts\relay-daemon.js" "--apply" $root
    $anyActivity = $true
  }
}

if (-not $anyActivity) {
  Write-Log "[watcher] idle - nothing to process"
}

Write-Log "[watcher] Pass complete"
