# Add Nsight Systems to system PATH (requires elevation)
# Run from admin PowerShell or this script will self-elevate

if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Start-Process PowerShell -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`"" -Verb RunAs
    exit
}

$nsysDir = "C:\Program Files\NVIDIA Corporation\Nsight Systems 2026.2.1\target-windows-x64"
$ncuDir = "C:\Program Files\NVIDIA Corporation\Nsight Compute 2026.1.0"
$currentPath = [Environment]::GetEnvironmentVariable("PATH", "Machine")

$added = @()
foreach ($dir in @($nsysDir, $ncuDir)) {
    if ($currentPath -notlike "*$dir*") {
        $currentPath = "$currentPath;$dir"
        $added += $dir
        Write-Host "Added: $dir"
    } else {
        Write-Host "Already in PATH: $dir"
    }
}

if ($added.Count -gt 0) {
    [Environment]::SetEnvironmentVariable("PATH", $currentPath, "Machine")
    Write-Host ""
    Write-Host "System PATH updated. Open a new terminal to use nsys/ncu from anywhere."
} else {
    Write-Host "No changes needed."
}
