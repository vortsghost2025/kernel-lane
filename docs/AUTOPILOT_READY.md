# Lattice Autopilot — One-Click Starter

**Usage:** Double-click this file OR run in PowerShell: `.\start-lattice-autopilot.ps1`

**What it does:**
- Opens 4 PowerShell windows (Kernel, Archivist, Library, SwarmMind)
- Each runs its `inbox-watcher.ps1` with 30-second polling
- Windows are titled for easy identification
- Logs stream live in each window

**Requirements:**
- Node.js in PATH
- PowerShell 5+
- All 4 lane directories accessible at expected paths

```powershell
# Start-LatticeAutopilot.ps1
$lanes = @(
  @{Name="Kernel";    Root="S:\kernel-lane";    Color="Green"},
  @{Name="Archivist"; Root="S:\Archivist-Agent"; Color="Cyan"},
  @{Name="Library";   Root="S:\self-organizing-library"; Color="Yellow"},
  @{Name="SwarmMind"; Root="S:\SwarmMind"; Color="Magenta"}
)

foreach ($lane in $lanes) {
  $psCommand = @"
Set-Location '$($lane.Root)'
Write-Host '[$(Get-Date -Format "HH:mm:ss")] Starting $($lane.Name) watcher...' -ForegroundColor $($lane.Color)
.\scripts\inbox-watcher.ps1 -PollSeconds 30
"@

  $newWindow = Start-Process powershell -ArgumentList '-NoExit', '-Command', $psCommand -PassThru
  Write-Host "Started $($lane.Name) watcher (PID: $($newWindow.Id))" -ForegroundColor $($lane.Color)
  Start-Sleep -Milliseconds 500
}

Write-Host "`nAll 4 watchers launched. Monitor the windows for activity." -ForegroundColor Green
Write-Host "To stop: close each PowerShell window, or run: Get-Job | Stop-Job`n" -ForegroundColor Yellow
```

Save as `start-lattice-autopilot.ps1` in `S:\kernel-lane\` (or any convenient location). Run as needed.

---

## Verification Checklist

After starting watchers, confirm they're alive:

```powershell
# Should show 4 powershell processes with "inbox-watcher" in title
Get-Process powershell | Select-Object Id,MainWindowTitle | Format-Table -AutoSize

# Check latest log entries (should show "Started" and polling cycles)
Get-Content "S:\kernel-lane\scripts\inbox-watcher.log" -Tail 5
Get-Content "S:\Archivist-Agent\scripts\inbox-watcher.log" -Tail 5
Get-Content "S:\self-organizing-library\scripts\inbox-watcher.log" -Tail 5
Get-Content "S:\SwarmMind\scripts\inbox-watcher.log" -Tail 5
```

---

## What "Autonomous" Means Here

With watchers running:
- **You** only need to: (a) issue high-level proposals via Archivist, (b) review convergences
- **Lanes** automatically: admit messages, execute tasks, deliver responses, retry failed deliveries
- **No manual message cycling** — the pipeline runs continuously

This is the **execution surface autonomy** layer. Governance still requires your final ratification on P0/P1 items, but routine coordination happens without your intervention.

---

## If a Watcher Crashes

Logs will show errors. Typical fixes:
- `ENOENT` → path issue, verify lane root exists
- `EACCESS` → permission issue, run PowerShell as admin
- Schema errors → fix message source (usually Archivist emitting non-v1.3)

Restart just that lane's watcher — others continue.

---

## Status: READY TO DEPLOY

The infrastructure is already in each lane's `scripts/`. You just need to launch the 4 watcher processes. Once running, the lattice self-coordinates.

Want me to also create a single Windows `.bat` file that launches all 4 in separate windows with one double-click?