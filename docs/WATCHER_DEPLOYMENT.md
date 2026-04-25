# Inbox Watcher Deployment

## Current Status

- **Method**: User startup shortcut (C:\Users\seand\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup\KernelLaneWatcher.lnk)
- **Script**: `scripts/inbox-watcher.ps1`
- **Poll interval**: 60 seconds
- **Log**: `scripts/inbox-watcher.log`
- **Auto-start**: On user logon

The watcher is deployed and will start automatically when the user `seand` logs in.

---

## For System-Wide Service (Admin Required)

If you have administrator rights and want a true Windows service (runs independently of user sessions), use **nssm**:

### Install nssm
```powershell
choco install -y nssm
```

### Create the service
```powershell
$psExe  = (Get-Command powershell).Source
$script = (Resolve-Path .\scripts\inbox-watcher.ps1).Path
$nssm   = (Get-Command nssm).Source
$svc    = "KernelLaneWatcher"
$args   = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$script`" -PollSeconds 60"

& $nssm install $svc $psExe $args
& $nssm set $svc Start SERVICE_AUTO_START
& $nssm start $svc
```

### Verify
```powershell
Get-Service KernelLaneWatcher
```

### Remove
```powershell
& $nssm stop $svc
& $nssm remove $svc confirm
```

---

## What the watcher does

1. Every 60 seconds, scans `lanes/kernel/inbox/` for new JSON messages (excluding heartbeats and processed files)
2. Invokes `node scripts/lane-worker.js --apply` to route messages according to governance rules
3. Logs all activity to `scripts/inbox-watcher.log`
4. Never exits unless stopped (service or login session)

## Monitoring

```powershell
# Follow the log in real time
Get-Content .\scripts\inbox-watcher.log -Wait

# Check service status (if using nssm)
nssm status KernelLaneWatcher
```
