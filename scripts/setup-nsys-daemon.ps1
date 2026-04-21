# Nsight Systems Daemon Setup (One-Time)
# Run this in a NORMAL desktop PowerShell (not from an agent session)
# The nsys daemon EULA popup requires interactive desktop acceptance

$nsysExe = "C:\Program Files\NVIDIA Corporation\Nsight Systems 2026.2.1\target-windows-x64\nsys.exe"
$testExe = "S:\kernel-lane\build\Release\matrix_benchmark.exe"

Write-Host "Launching nsys profile to trigger EULA acceptance..."
Write-Host "If a popup appears, click ACCEPT."
Write-Host ""

& $nsysExe profile --duration=3 --output "S:\kernel-lane\profiles\nsys\eula-acceptance-test" $testExe

if ($LASTEXITCODE -eq 0) {
    Write-Host ""
    Write-Host "SUCCESS: EULA accepted, daemon running."
    Write-Host "Subsequent headless runs will work until reboot."
    Write-Host ""
    Write-Host "Setting up logon task to auto-start daemon on reboot..."

    $trigger = New-ScheduledTaskTrigger -AtLogOn -UserId "$env:USERNAME"
    $action = New-ScheduledTaskAction -Execute $nsysExe -Argument "profile --duration=1 --session-new daemon-warmup `"$testExe`""
    $principal = New-ScheduledTaskPrincipal -UserId "$env:USERNAME" -RunLevel Highest -LogonType Interactive
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable

    Register-ScheduledTask `
        -TaskName "Nsight-Daemon-Warmup" `
        -Trigger $trigger `
        -Action $action `
        -Principal $principal `
        -Settings $settings `
        -Description "Starts nsys daemon on login so scheduled/headless tasks can use it" `
        -Force

    Write-Host "Logon task registered. Daemon will auto-start on every login."
} else {
    Write-Host "Exit code: $LASTEXITCODE — may need to retry or accept EULA manually"
}
