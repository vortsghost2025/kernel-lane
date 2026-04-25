param(
    [string]$BaselineCsv = "profiles\headless\baseline_metrics.csv",
    [string]$CurrentCsv  = "profiles\headless\kernel_metrics.csv",
    [double]$ThresholdPct = 2.0
)

function Get-Mean([string]$csv, [string]$col) {
    $rows = Import-Csv $csv
    if (-not $rows) {
        Write-Error "CSV is empty or unreadable: $csv"
        exit 1
    }
    $vals = $rows | ForEach-Object { 
        $v = $_.$col
        if ($v -eq $null) {
            Write-Error "Column '$col' not found in $csv. Available columns: $($rows[0].PSObject.Properties.Name -join ', ')"
            exit 1
        }
        [double]$v
    }
    return ($vals | Measure-Object -Average).Average
}

$base = Get-Mean $BaselineCsv "Kernel Duration (ns)"
$cur  = Get-Mean $CurrentCsv  "Kernel Duration (ns)"
$diff = (($cur - $base) / $base) * 100

if ([math]::Abs($diff) -gt $ThresholdPct) {
    Write-Error "❌ Regression: $([math]::Round($diff,2))% exceeds threshold $ThresholdPct%"
    exit 1
}
Write-Host "✅ No regression (Δ = $([math]::Round($diff,2))%)"
