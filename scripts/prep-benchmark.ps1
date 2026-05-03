<#
.SYNOPSIS
Prepares RTX 5060 for clean CUDA benchmarks by freeing VRAM and CPU/RAM resources.

.DESCRIPTION
Kills known GPU/RAM hogs, validates GPU is clean, then optionally runs a benchmark.
Use -WhatIf to preview what would be killed without actually killing anything.
Use -Strict to require <500MiB VRAM used before proceeding.

.EXAMPLE
.\prep-benchmark.ps1                    # Kill hogs, validate, proceed
.\prep-benchmark.ps1 -WhatIf            # Preview only
.\prep-benchmark.ps1 -Strict            # Require near-empty GPU
.\prep-benchmark.ps1 -Then "S:\kernel-lane\scripts\run-fp8-benchmark.ps1"
#>

param(
    [switch]$WhatIf,
    [switch]$Strict,
    [int]$MaxVramMiB = 500,
    [string]$Then,
    [switch]$SkipOllama
)

$ErrorActionPreference = "Continue"

# ── Known GPU/VRAM hogs to kill ──────────────────────────────────
$Hogs = @(
    @{ Name = "Ollama";         Match = "ollama*";         Kind = "VRAM-heavy" },
    @{ Name = "Ollama runner";  Match = "ollama_runner*";  Kind = "VRAM-heavy" },
    @{ Name = "NVIDIA Overlay"; Match = "NVIDIA Overlay*"; Kind = "GPU-compute" },
    @{ Name = "NVIDIA App CEF"; Match = "NVIDIA*CEF*";     Kind = "GPU-compute" },
    @{ Name = "Chrome";         Match = "chrome*";         Kind = "VRAM-light" },
    @{ Name = "Edge WebView";   Match = "msedgewebview*";  Kind = "VRAM-light" },
    @{ Name = "Copilot";        Match = "Copilot*";        Kind = "GPU-touch" },
    @{ Name = "Your Phone";     Match = "PhoneExperience*";Kind = "GPU-touch" },
    @{ Name = "Codex";          Match = "Codex*";          Kind = "GPU-touch" },
    @{ Name = "Discord";        Match = "Discord*";        Kind = "GPU-touch" },
    @{ Name = "Spotify";        Match = "Spotify*";        Kind = "RAM-heavy" },
    @{ Name = "MS Teams";       Match = "ms-teams*";       Kind = "RAM-heavy" },
    @{ Name = "Slack";          Match = "slack*";          Kind = "RAM-heavy" }
)

# ── Protected processes (never kill) ─────────────────────────────
$Protected = @("explorer", "SearchHost", "TextInputHost", "StartMenuExperience",
               "ShellExperience", "ApplicationFrameHost", "ShellHost",
               "SystemSettings", "nvcontainer", "dwm", "csrss", "lsass",
               "svchost", "System", "smss", "winlogon", "wininit",
               "services", "lsass", "spoolsv", "conhost", "WindowsTerminal",
               "WindowsTerminal.exe", "opencode", "node")

function IsProtected($name) {
    foreach ($p in $Protected) {
        if ($name -like "*$p*") { return $true }
    }
    return $false
}

# ── Step 1: Kill hogs ────────────────────────────────────────────
Write-Host ""
Write-Host "═══════════════════════════════════════════════════" -ForegroundColor Cyan
Write-Host "  GPU BENCHMARK PREP" -ForegroundColor Cyan
Write-Host "═══════════════════════════════════════════════════" -ForegroundColor Cyan
Write-Host ""

$killed = 0
$skipped = 0

foreach ($hog in $Hogs) {
    $procs = Get-Process -Name $hog.Match -ErrorAction SilentlyContinue
    if (-not $procs) { continue }

    foreach ($proc in $procs) {
        if (IsProtected $proc.ProcessName) {
            Write-Host "  SKIP (protected): $($proc.ProcessName) [$($proc.Id)]" -ForegroundColor Yellow
            $skipped++
            continue
        }

        $memMiB = [math]::Round($proc.WorkingSet64 / 1MB, 0)
        if ($WhatIf) {
            Write-Host "  WOULD KILL: $($hog.Name) [$($proc.Id)] (${memMiB} MiB RAM, $($hog.Kind))" -ForegroundColor DarkGray
        } else {
            Write-Host "  KILLING: $($hog.Name) [$($proc.Id)] (${memMiB} MiB RAM, $($hog.Kind))" -ForegroundColor Red
            try {
                Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
                $killed++
            } catch {
                Write-Host "    FAILED (access denied)" -ForegroundColor DarkRed
            }
        }
    }
}

if ($WhatIf) {
    Write-Host ""
    Write-Host "  WhatIf mode — no processes were killed" -ForegroundColor Yellow
}

# ── Step 2: Wait for VRAM to drain ───────────────────────────────
if (-not $WhatIf -and $killed -gt 0) {
    Write-Host ""
    Write-Host "  Waiting 5s for VRAM to drain..." -ForegroundColor DarkGray
    Start-Sleep -Seconds 5
}

# ── Step 3: Validate GPU state ───────────────────────────────────
Write-Host ""
Write-Host "  GPU State:" -ForegroundColor White

$gpuInfo = nvidia-smi --query-gpu=memory.used,memory.free,utilization.gpu --format=csv,noheader,nounits 2>$null
if ($LASTEXITCODE -ne 0 -or -not $gpuInfo) {
    Write-Host "    ERROR: nvidia-smi failed" -ForegroundColor Red
    exit 1
}

$parts = $gpuInfo.Trim() -split ","
$vramUsed = [int]$parts[0].Trim()
$vramFree = [int]$parts[1].Trim()
$gpuUtil = $parts[2].Trim()

Write-Host "    VRAM used:  $vramUsed MiB" -ForegroundColor $(if ($vramUsed -gt $MaxVramMiB) { "Red" } else { "Green" })
Write-Host "    VRAM free:  $vramFree MiB" -ForegroundColor Green
Write-Host "    GPU util:   $gpuUtil %" -ForegroundColor White

# ── Step 4: Check for lingering CUDA processes ───────────────────
Write-Host ""
Write-Host "  Active GPU processes:" -ForegroundColor White
$gpuProcs = nvidia-smi --query-compute-apps=pid,name,used_memory --format=csv,noheader 2>$null
if ($gpuProcs -and $gpuProcs.Trim() -ne "") {
    Write-Host "    $gpuProcs" -ForegroundColor Yellow
    Write-Host "    WARNING: GPU processes still running" -ForegroundColor Yellow
} else {
    Write-Host "    (none)" -ForegroundColor Green
}

# ── Step 5: Pass/fail ────────────────────────────────────────────
Write-Host ""
if ($vramUsed -gt $MaxVramMiB) {
    Write-Host "  FAIL: VRAM used ($vramUsed MiB) exceeds threshold ($MaxVramMiB MiB)" -ForegroundColor Red
    if ($Strict) {
        Write-Host "  Strict mode — aborting" -ForegroundColor Red
        exit 1
    } else {
        Write-Host "  Non-strict mode — proceeding anyway" -ForegroundColor Yellow
    }
} else {
    Write-Host "  PASS: GPU ready for benchmarking" -ForegroundColor Green
}

Write-Host ""
Write-Host "═══════════════════════════════════════════════════" -ForegroundColor Cyan

# ── Step 6: Run optional command ─────────────────────────────────
if ($Then) {
    Write-Host "  Running: $Then" -ForegroundColor White
    Write-Host ""
    Invoke-Expression $Then
}
