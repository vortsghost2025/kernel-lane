<#
.SYNOPSIS
Standardized commit script for all agents. Commits changes with timestamp, agent identity, and test verification.

.DESCRIPTION
All agents must use this to commit work. Enforces:
- Tests pass before commit
- Standardized commit message format
- Agent identity in commit
- ISO timestamp
- Push to origin immediately

.PARAMETER AgentName
Name of the agent (e.g., "kucoin-lane", "archivist", "control-plane", "kernel", "swarmmind", "library")

.PARAMETER Message
Human-readable description of changes

.PARAMETER RepoPath
Path to repo root (default: current directory)

.EXAMPLE
.\agent-commit.ps1 -AgentName "kucoin-lane" -Message "Remove dummy API fallbacks - require real credentials"
#>

param(
    [Parameter(Mandatory=$true)]
    [string]$AgentName,
    
    [Parameter(Mandatory=$true)]
    [string]$Message,
    
    [string]$RepoPath = (Get-Location).Path
)

$timestamp = Get-Date -Format "yyyy-MM-ddTHH:mm:ssK"
$commitMsg = "[$AgentName] $Message`n`nAgent: $AgentName`nDate: $timestamp"

Write-Host "=== Agent Commit: $AgentName ===" -ForegroundColor Cyan
Write-Host "Repo: $RepoPath"
Write-Host "Message: $Message"
Write-Host "Timestamp: $timestamp"
Write-Host ""

# Check for uncommitted changes
$status = git -C $RepoPath status --porcelain
if (-not $status) {
    Write-Host "No changes to commit" -ForegroundColor Yellow
    exit 0
}

# Show changes
Write-Host "Changes to commit:" -ForegroundColor Green
git -C $RepoPath diff --stat

# Run tests if test script exists
$testScript = Join-Path $RepoPath "scripts/test.ps1"
if (Test-Path $testScript) {
    Write-Host "Running tests..." -ForegroundColor Cyan
    $testResult = & $testScript
    if ($LASTEXITCODE -ne 0) {
        Write-Host "TESTS FAILED - Commit aborted" -ForegroundColor Red
        exit 1
    }
    Write-Host "Tests passed" -ForegroundColor Green
}

# Check for cargo/rust projects
$cargoToml = Join-Path $RepoPath "Cargo.toml"
if (Test-Path $cargoToml) {
    Write-Host "Running cargo check..." -ForegroundColor Cyan
    cargo check --manifest-path (Join-Path $RepoPath "src-tauri/Cargo.toml") 2>$null
    if ($LASTEXITCODE -ne 0) {
        Write-Host "CARGO CHECK FAILED - Commit aborted" -ForegroundColor Red
        exit 1
    }
    Write-Host "Cargo check passed" -ForegroundColor Green
}

# Stage all changes
Write-Host "Staging changes..." -ForegroundColor Cyan
git -C $RepoPath add -A

# Commit
Write-Host "Committing..." -ForegroundColor Cyan
git -C $RepoPath commit -m $commitMsg

# Push
Write-Host "Pushing to origin..." -ForegroundColor Cyan
git -C $RepoPath push

Write-Host "=== Commit complete ===" -ForegroundColor Green
Write-Host "Commit: $(git -C $RepoPath log -1 --oneline)"