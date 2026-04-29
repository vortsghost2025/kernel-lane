param(
    [int]$IntervalSeconds = 60,
    [string]$Mode = "daemon"
)

$lanes = @(
    @{ Name = "kernel";     Repo = "S:\kernel-lane" },
    @{ Name = "archivist";  Repo = "S:\Archivist-Agent" },
    @{ Name = "library";    Repo = "S:\self-organizing-library" },
    @{ Name = "swarmmind";  Repo = "S:\SwarmMind" }
)

function Write-Heartbeat($lane) {
    $now = Get-Date -Format "yyyy-MM-ddTHH:mm:ssZ"
    $inboxPath = Join-Path $lane.Repo "lanes\$($lane.Name)\inbox"
    $heartbeatFile = Join-Path $inboxPath "heartbeat-$($lane.Name).json"
    $broadcastDir = Join-Path $lane.Repo "lanes\broadcast"
    $contradictionsFile = Join-Path $broadcastDir "contradictions.json"
    $systemStateFile = Join-Path $broadcastDir "system_state.json"

    $systemState = "consistent"
    $activeContradictions = @()
    if (Test-Path $contradictionsFile) {
        try {
            $cd = Get-Content $contradictionsFile -Raw | ConvertFrom-Json
            $activeContradictions = @($cd | Where-Object { $_.status -eq "active" -or $_.status -eq "resolving" } | ForEach-Object { $_.id })
            if ($activeContradictions.Count -gt 0) { $systemState = "degraded" }
        } catch {}
    }

    $idempotencyKey = [System.BitConverter]::ToString(
        [System.Security.Cryptography.SHA256]::Create().ComputeHash(
            [System.Text.Encoding]::UTF8.GetBytes("heartbeat-$($lane.Name)-fixed")
        )
    ).Replace("-","").ToLower()

    $message = @{
        schema_version = "1.1"
        task_id = "heartbeat-$($lane.Name)"
        idempotency_key = $idempotencyKey
        from = $lane.Name
        to = $lane.Name
        type = "heartbeat"
        task_kind = "proposal"
        priority = "P3"
        subject = "Heartbeat from $($lane.Name) lane"
        body = "{`"lane`":`"$($lane.Name)`",`"session_active`":true,`"uptime_seconds`":$([int]((Get-Date) - $script:startTime).TotalSeconds),`"messages_processed`":0,`"last_inbox_scan`":`"$now`",`"version`":`"1.1`",`"daemon`":`"heartbeat-all-lanes.ps1`"}"
        timestamp = $now
        requires_action = $false
        payload = @{ mode = "inline" }
        execution = @{ mode = "daemon"; engine = "powershell"; actor = "heartbeat-daemon" }
        lease = @{ owner = $null; acquired_at = $null; expires_at = $null; renew_count = 0; max_renewals = 3 }
        retry = @{ attempt = 1; max_attempts = 3; last_error = $null; last_attempt_at = $null }
        evidence = @{ required = $true; evidence_path = $null; verified = $false; verified_by = $null; verified_at = $null }
        heartbeat = @{ interval_seconds = $IntervalSeconds; last_heartbeat_at = $now; timeout_seconds = 900; status = "in_progress" }
        watcher = @{ enabled = $false; poll_seconds = 60; p0_fast_path = $true; max_concurrent = 1; heartbeat_required = $true; stale_after_seconds = 300; backoff = @{ initial_seconds = 60; max_seconds = 300; multiplier = 2 } }
        delivery_verification = @{ verified = $false; verified_at = $null; retries = 0 }
        system_state = $systemState
        active_contradictions = $activeContradictions
        processed_ok = $true
    }

    if (-not (Test-Path $inboxPath)) {
        New-Item -ItemType Directory -Path $inboxPath -Force | Out-Null
    }

    $jsonContent = $message | ConvertTo-Json -Depth 5
    [System.IO.File]::WriteAllText($heartbeatFile, $jsonContent, [System.Text.UTF8Encoding]::new($false))

    $statePayload = @{
        system_status = $systemState
        timestamp = $now
        active_contradictions = $activeContradictions
        total_contradictions = $activeContradictions.Count
        compaction_enabled = ($activeContradictions.Count -eq 0)
        compaction_suspend_reason = if ($activeContradictions.Count -gt 0) { "Active contradictions present" } else { $null }
        processed_ok = $true
        derived_from = "contradictions.json"
        written_by = "heartbeat-all-lanes.ps1"
    }
    if (-not (Test-Path $broadcastDir)) {
        New-Item -ItemType Directory -Path $broadcastDir -Force | Out-Null
    }
    $stateJson = $statePayload | ConvertTo-Json -Depth 5
    [System.IO.File]::WriteAllText($systemStateFile, $stateJson, [System.Text.UTF8Encoding]::new($false))
}

function Check-Health {
    $now = Get-Date
    $report = @{ timestamp = $now.ToString("yyyy-MM-ddTHH:mm:ssZ"); lanes = @{} }

    foreach ($lane in $lanes) {
        $heartbeatFile = Join-Path $lane.Repo "lanes\$($lane.Name)\inbox\heartbeat-$($lane.Name).json"
        if (Test-Path $heartbeatFile) {
            try {
                $data = Get-Content $heartbeatFile -Raw | ConvertFrom-Json
                $lastHB = [DateTime]::Parse($data.timestamp)
                $elapsed = [int]($now - $lastHB).TotalSeconds
                $report.lanes[$lane.Name] = @{
                    status = if ($elapsed -gt 900) { "stale" } else { "alive" }
                    last_heartbeat = $data.timestamp
                    stale_for_seconds = $elapsed
                }
            } catch {
                $report.lanes[$lane.Name] = @{ status = "unknown"; last_heartbeat = $null; stale_for_seconds = 0 }
            }
        } else {
            $report.lanes[$lane.Name] = @{ status = "unknown"; last_heartbeat = $null; stale_for_seconds = 0 }
        }
    }
    return $report
}

$script:startTime = Get-Date

if ($Mode -eq "check") {
    $report = Check-Health
    $report | ConvertTo-Json -Depth 3
    exit 0
}

if ($Mode -eq "once") {
    foreach ($lane in $lanes) {
        Write-Heartbeat $lane
        Write-Host "[$(Get-Date -Format 'HH:mm:ss')] Heartbeat written: $($lane.Name)"
    }
    exit 0
}

Write-Host "=== Heartbeat Daemon Started (all lanes, interval: ${IntervalSeconds}s) ==="
Write-Host "Press Ctrl+C to stop."

while ($true) {
    foreach ($lane in $lanes) {
        try {
            Write-Heartbeat $lane
        } catch {
            Write-Host "[$(Get-Date -Format 'HH:mm:ss')] ERROR writing $($lane.Name): $_"
        }
    }
    Write-Host "[$(Get-Date -Format 'HH:mm:ss')] All heartbeats written ($($lanes.Count) lanes)"
    Start-Sleep -Seconds $IntervalSeconds
}
