# Daily Productivity Report Runner
# Auto-detects lane from script path

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$LaneRoot = Split-Path -Parent $ScriptDir  # e.g., S:\SwarmMind\scripts -> S:\SwarmMind
$Lane = Split-Path -Leaf $LaneRoot  # e.g., SwarmMind -> swarmmind (lowercase)

$NodeScript = Join-Path $ScriptDir "daily-productivity-report.js"

Write-Host "[$Lane] Running daily productivity report at $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')..."

try {
    # Pass lane as environment variable to Node script
    $env:LANE = $Lane.ToLower()
    & node $NodeScript
    if ($LASTEXITCODE -eq 0) {
        Write-Host "[$Lane] Report generated successfully"
        exit 0
    } else {
        Write-Error "[$Lane] Report script failed with exit code $LASTEXITCODE"
        exit 1
    }
}
catch {
    Write-Error "[$Lane] Exception: $_"
    exit 1
}
