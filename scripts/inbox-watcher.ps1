<#
.SYNOPSIS
Full-pipeline watcher: inbox -> lane-worker -> task-executor -> relay-daemon

.DESCRIPTION
Polls every $PollSeconds for new .json files in each lane's inbox.
When detected, runs the full pipeline:
  1. lane-worker --apply   (admit + route messages)
  2. generic-task-executor --apply  (execute action-required tasks)
  3. relay-daemon --apply  (deliver outbox + collect incoming)

.PARAMETER PollSeconds
Seconds between polls. Default: 30.

.PARAMETER LogFile
Path to log file. Default: scripts/inbox-watcher.log

.PARAMETER SkipExecutor
Skip task-executor step (for lanes that need human/agent execution).

.EXAMPLE
.\scripts\inbox-watcher.ps1 -PollSeconds 30
.\scripts\inbox-watcher.ps1 -PollSeconds 60 -SkipExecutor
#>

param(
  [int]$PollSeconds = 30,
  [string]$LogFile = "$PSScriptRoot\inbox-watcher.log",
  [switch]$SkipExecutor = $false
)

function Write-Log {
  param([string]$msg)
  $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  "$ts $msg" | Out-File -FilePath $LogFile -Append -Encoding utf8
  Write-Host "$ts $msg"
}

$LaneRoots = @{
  archivist = "S:\Archivist-Agent"
  kernel    = "S:\kernel-lane"
  library   = "S:\self-organizing-library"
  swarmmind = "S:\SwarmMind"
}

$ArchivistRoot = "S:\Archivist-Agent"

function Count-Files([string]$dir, [string]$filter = "*.json") {
  if (-not (Test-Path $dir)) { return 0 }
  return (Get-ChildItem -Path $dir -Filter $filter -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -notlike "heartbeat*" }).Count
}

function Run-Step([string]$name, [string]$script, [string[]]$args, [string]$cwd) {
  try {
    $result = & node $script @args 2>&1
    $resultStr = ($result | Out-String).Trim()
    Write-Log "  [$name] $resultStr"
    return $true
  } catch {
    Write-Log "  [$name] ERROR: $_"
    return $false
  }
}

Write-Log "[watcher] Started - poll ${PollSeconds}s - skipExecutor=$SkipExecutor - lanes: $($LaneRoots.Keys -join ',')"
Write-Log "[watcher] Pipeline: lane-worker -> task-executor -> relay-daemon"

$cycle = 0
while ($true) {
  $cycle++
  $anyActivity = $false

  foreach ($lane in $LaneRoots.Keys) {
    $root = $LaneRoots[$lane]
    $inboxDir = Join-Path $root "lanes\$lane\inbox"
    $arDir = Join-Path $root "lanes\$lane\inbox\action-required"
    $outboxDir = Join-Path $root "lanes\$lane\outbox"

    $inboxCount = Count-Files $inboxDir
    $arCount = Count-Files $arDir
    $outboxCount = Count-Files $outboxDir

    if ($inboxCount -eq 0 -and $arCount -eq 0 -and $outboxCount -eq 0) { continue }

    Write-Log "[watcher] Cycle $cycle : ${lane} inbox=$inboxCount ar=$arCount outbox=$outboxCount"

    # Step 1: Admit + route new inbox messages
    if ($inboxCount -gt 0) {
      Write-Log "[watcher] Step 1: Running lane-worker for ${lane}"
      Run-Step "lane-worker" "$root\scripts\lane-worker.js" @("--lane", $lane, "--apply") $root
      $anyActivity = $true
    }

    # Step 2: Execute action-required tasks
    if (-not $SkipExecutor -and $arCount -gt 0) {
      Write-Log "[watcher] Step 2: Running task-executor for ${lane}"
      $executorScript = "$ArchivistRoot\scripts\generic-task-executor.js"
      Run-Step "task-executor" $executorScript @($lane, "--apply") $root
      $anyActivity = $true
    }

    # Step 3: Deliver outbox + collect incoming
    if ($outboxCount -gt 0) {
      Write-Log "[watcher] Step 3: Running relay-daemon for ${lane}"
      Run-Step "relay-daemon" "$root\scripts\relay-daemon.js" @("--apply") $root
      $anyActivity = $true
    }
  }

  if (-not $anyActivity -and $cycle % 10 -eq 0) {
    Write-Log "[watcher] Cycle $cycle : idle"
  }

  Start-Sleep -Seconds $PollSeconds
}
