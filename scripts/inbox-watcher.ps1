<#
.SYNOPSIS
Kernel Lane inbox watcher - runs lane-worker.js in a loop.

.DESCRIPTION
Polls the kernel inbox every N seconds, processes new messages with
lane-worker.js (--apply mode), and logs results to inbox-watcher.log.

.PARAMETER PollSeconds
Poll interval in seconds (default: 60)
#>
param(
    [int]$PollSeconds = 60
)

$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path $MyInvocation.MyCommand.Path -Parent
$laneWorker = Join-Path $scriptDir 'lane-worker.js'
$logPath = Join-Path $scriptDir 'inbox-watcher.log'

function Log {
    param([string]$msg)
    $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $line = "$ts $msg"
    Add-Content -Path $logPath -Value $line
    Write-Host $msg
}

Log "Inbox watcher started - poll interval ${PollSeconds}s - logging to $logPath"

while ($true) {
    try {
        Log "Scanning inbox..."
        $args = @('--lane','kernel','--apply')
        $output = & node $laneWorker @args 2>&1
        $exit = $LASTEXITCODE
        if ($exit -eq 0) {
            Log "lane-worker completed (exit 0)"
        } else {
            Log "lane-worker exited with code $exit"
        }
        # Trim and log each output line
        foreach ($line in $output) {
            $trim = $line.Trim()
            if ($trim) { Log "  $trim" }
        }
    } catch {
        Log "Exception: $($_.Exception.Message)"
    }

    # Sleep until next poll
    Start-Sleep -Seconds $PollSeconds
}
