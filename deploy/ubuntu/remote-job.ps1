param(
    [Parameter(Position=0)]
    [ValidateSet("run","status","logs","artifacts","pull-artifacts","health","deploy")]
    [string]$Action = "run",

    [Parameter(Position=1)]
    [string]$Command = "",

    [string]$RemoteHost = "ubuntu-agent",
    [string]$RemoteUser = "we4free",
    [string]$AgentRoot = "/home/we4free/agent",
    [string]$LocalArtifactsDir = "S:\kernel-lane\artifacts-from-ubuntu"
)

$SshPrefix = "ssh $RemoteUser@$RemoteHost"

function Invoke-Remote {
    param([string]$Cmd)
    Write-Host "[REMOTE] $Cmd" -ForegroundColor Cyan
    Invoke-Expression "$SshPrefix `"$Cmd`""
}

function Get-Status {
    Write-Host "=== Ubuntu Worker Node Status ===" -ForegroundColor Yellow
    Invoke-Remote "echo 'HOSTNAME:' && hostname && echo 'UPTIME:' && uptime && echo 'DISK:' && df -h /home/we4free && echo 'MEM:' && free -m && echo 'NODE:' && export NVM_DIR=`$HOME/.nvm && [ -s `$NVM_DIR/nvm.sh ] && . `$NVM_DIR/nvm.sh && node --version"
}

function Get-Logs {
    param([int]$Lines = 50)
    Write-Host "=== Last $Lines lines of agent.log ===" -ForegroundColor Yellow
    Invoke-Remote "tail -n $Lines $AgentRoot/logs/agent.log"
}

function Get-Artifacts {
    Write-Host "=== Ubuntu Artifacts ===" -ForegroundColor Yellow
    Invoke-Remote "ls -la $AgentRoot/artifacts/"
}

function Pull-Artifacts {
    $timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $destDir = "$LocalArtifactsDir\$timestamp"
    New-Item -ItemType Directory -Path $destDir -Force | Out-Null
    Write-Host "[SCP] Pulling artifacts from Ubuntu to $destDir" -ForegroundColor Green
    scp "${RemoteUser}@${RemoteHost}:${AgentRoot}/artifacts/*" "$destDir\"
    if ($LASTEXITCODE -eq 0) {
        Write-Host "[OK] Artifacts saved to $destDir" -ForegroundColor Green
    } else {
        Write-Host "[WARN] SCP returned non-zero (possibly no new artifacts)" -ForegroundColor Yellow
    }
}

function Get-Health {
    Write-Host "=== Node Health ===" -ForegroundColor Yellow
    Invoke-Remote "cat $AgentRoot/logs/node-health.json 2>/dev/null || echo 'No health report found'"
}

function Run-Remote {
    param([string]$Cmd = $Command)
    if (-not $Cmd) {
        Write-Host "[INFO] No command specified, running default runner.sh" -ForegroundColor Cyan
        Invoke-Remote "export NVM_DIR=`$HOME/.nvm && [ -s `$NVM_DIR/nvm.sh ] && . `$NVM_DIR/nvm.sh && bash $AgentRoot/bin/runner.sh"
    } else {
        Invoke-Remote "export NVM_DIR=`$HOME/.nvm && [ -s `$NVM_DIR/nvm.sh ] && . `$NVM_DIR/nvm.sh && $Cmd"
    }
}

function Deploy-Runner {
    $localRunner = "S:\kernel-lane\deploy\ubuntu\runner.sh"
    if (Test-Path $localRunner) {
        Write-Host "[SCP] Deploying updated runner.sh to Ubuntu" -ForegroundColor Green
        scp $localRunner "${RemoteUser}@${RemoteHost}:${AgentRoot}/bin/runner.sh"
        Invoke-Remote "chmod +x $AgentRoot/bin/runner.sh"
        Write-Host "[OK] runner.sh deployed" -ForegroundColor Green
    } else {
        Write-Host "[ERROR] Local runner.sh not found at $localRunner" -ForegroundColor Red
    }
}

switch ($Action) {
    "run"             { Run-Remote }
    "status"          { Get-Status }
    "logs"            { Get-Logs }
    "artifacts"       { Get-Artifacts }
    "pull-artifacts"  { Pull-Artifacts }
    "health"          { Get-Health }
    "deploy"          { Deploy-Runner }
    default           { Write-Host "Unknown action: $Action. Use: run, status, logs, artifacts, pull-artifacts, health, deploy" -ForegroundColor Red }
}
