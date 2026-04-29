# Lattice Autopilot — Inbox Watcher Orchestrator

**Purpose:** Enable autonomous cross-lane coordination by running each lane's inbox-watcher as a background daemon.

**What it does:**
Each lane's `inbox-watcher.ps1` runs a 3-step pipeline every 30 seconds:
1. `lane-worker --apply` — admit + route new messages from `inbox/` to `action-required/`, `processed/`, or `quarantine/`
2. `task-executor --apply` — execute tasks in `action-required/` (produces responses to outbox)
3. `relay-daemon --apply` — deliver outbox messages to target lanes + collect incoming

When all 4 lanes run this watcher, the lattice processes autonomously without human intervention.

---

## Current State Check

Run this to see if any watchers are already running:

```powershell
# Check for node processes running the watcher
Get-Process node -ErrorAction SilentlyContinue | Select-Object Id,ProcessName,StartTime,CPU,@{n='Path';e={$_.Path}}
```

Or check the log files:
```powershell
Get-Content "S:\kernel-lane\scripts\inbox-watcher.log" -Tail 10
Get-Content "S:\Archivist-Agent\scripts\inbox-watcher.log" -Tail 10
Get-Content "S:\self-organizing-library\scripts\inbox-watcher.log" -Tail 10
Get-Content "S:\SwarmMind\scripts\inbox-watcher.log" -Tail 10
```

---

## Starting All Watchers (One-Time)

**Option A — PowerShell (Recommended)**

Open **4 separate PowerShell windows** (one per lane) and run:

```powershell
# Window 1 — Kernel lane
cd S:\kernel-lane
.\scripts\inbox-watcher.ps1 -PollSeconds 30

# Window 2 — Archivist lane  
cd S:\Archivist-Agent
.\scripts\inbox-watcher.ps1 -PollSeconds 30

# Window 3 — Library lane
cd S:\self-organizing-library
.\scripts\inbox-watcher.ps1 -PollSeconds 30

# Window 4 — SwarmMind lane
cd S:\SwarmMind
.\scripts\inbox-watcher.ps1 -PollSeconds 30
```

Each window will show live logs of messages being processed. Leave them running.

**Option B — Background Jobs (Single Terminal)**

Start all 4 as background jobs from one PowerShell session:

```powershell
$lanes = @(
  @{Name="Kernel";    Root="S:\kernel-lane"},
  @{Name="Archivist"; Root="S:\Archivist-Agent"},
  @{Name="Library";   Root="S:\self-organizing-library"},
  @{Name="SwarmMind"; Root="S:\SwarmMind"}
)

foreach ($lane in $lanes) {
  Start-Job -Name "Watcher-$($lane.Name)" -ScriptBlock {
    param($root)
    Set-Location $root
    .\scripts\inbox-watcher.ps1 -PollSeconds 30
  } -ArgumentList $lane.Root | Out-Null
}

Write-Host "Started 4 watcher jobs. Check with: Get-Job | Receive-Job -Keep"
```

---

## Windows Service / Persistent Setup

To auto-start watchers on boot, create scheduled tasks:

```powershell
# Run once as Administrator to create persistent tasks
$actions = @(
  @{Name="Kernel-Watcher";    Root="S:\kernel-lane"},
  @{Name="Archivist-Watcher"; Root="S:\Archivist-Agent"},
  @{Name="Library-Watcher";   Root="S:\self-organizing-library"},
  @{Name="SwarmMind-Watcher"; Root="S:\SwarmMind"}
)

foreach ($a in $actions) {
  $trigger = New-ScheduledTaskTrigger -AtStartup
  $action = New-ScheduledTaskAction -Execute "PowerShell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$($a.Root)\scripts\inbox-watcher.ps1`" -PollSeconds 30"
  Register-ScheduledTask -TaskName $a.Name -Trigger $trigger -Action $action -RunLevel Highest -Description "Lane inbox watcher for $($a.Name)"
  Write-Host "Registered task: $($a.Name)"
}
```

---

## Monitoring

**Live log tail (all lanes):**
```powershell
# Open 4 windows and run:
Get-Content "S:\kernel-lane\scripts\inbox-watcher.log" -Wait -Tail 5
Get-Content "S:\Archivist-Agent\scripts\inbox-watcher.log" -Wait -Tail 5
Get-Content "S:\self-organizing-library\scripts\inbox-watcher.log" -Wait -Tail 5
Get-Content "S:\SwarmMind\scripts\inbox-watcher.log" -Wait -Tail 5
```

**Summary status:**
```powershell
# Check each lane's current queue depth
Get-Content "S:\kernel-lane\lanes\kernel\inbox\heartbeat-kernel.json" | ConvertFrom-Json | Select last_heartbeat_at, status
Get-Content "S:\Archivist-Agent\lanes\archivist\inbox\heartbeat-archivist.json" | ConvertFrom-Json | Select last_heartbeat_at, status
Get-Content "S:\self-organizing-library\lanes\library\inbox\heartbeat-library.json" | ConvertFrom-Json | Select last_heartbeat_at, status
Get-Content "S:\SwarmMind\lanes\swarmmind\inbox\heartbeat-swarmmind.json" | ConvertFrom-Json | Select last_heartbeat_at, status
```

---

## Expected Behavior Once Running

When all 4 watchers are active:
1. You (Archivist) broadcast a message → drops in Archivist outbox
2. `relay-daemon` delivers to all lane inboxes
3. Each lane's `lane-worker` admits messages from `inbox/` → routes to `action-required/`
4. Each lane's `task-executor` processes `action-required/` → produces responses to outbox
5. `relay-daemon` delivers responses back to Archivist
6. Repeat

**No human needed** after step 1.

---

## Troubleshooting

If a watcher stops:
```powershell
# Check its log
Get-Content "S:\<lane-root>\scripts\inbox-watcher.log" -Tail 20

# Restart that lane's watcher
cd <lane-root>
.\scripts\inbox-watcher.ps1 -PollSeconds 30
```

---

## Next Actions After Starting Watchers

1. Start all 4 watchers (keep those terminals open)
2. Send a test broadcast from Archivist (e.g., simple proposal/ratification)
3. Watch the logs — you should see the full 3-step pipeline execute in ~30–60 seconds across all lanes
4. Verify responses appear in Archivist inbox automatically

**Once this is running, the lattice operates autonomously.** You only need to issue high-level directives; the message bus handles the rest.

Need me to generate the 4 PowerShell scripts that auto-start all watchers in separate windows with one click?