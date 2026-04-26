#!/usr/bin/env pwsh
# Pre-commit verification script
# 1) Run lint if defined in package.json (npm script "lint"). This step is optional and will be skipped if no package.json is present.
# 2) Scan staged files for secret patterns (.pem, .key, .jws)
# 3) Exit with non‑zero code on any failure to block the commit

# Lint step (optional)
if (Test-Path "package.json") {
    try {
        $pkg = Get-Content "package.json" -Raw | ConvertFrom-Json -ErrorAction Stop
        if ($pkg.scripts -and $pkg.scripts.lint) {
            Write-Host "Running npm lint..."
            npm run lint
            if ($LASTEXITCODE -ne 0) {
                Write-Error "npm lint failed"
                exit 1
            }
        }
    } catch {
        Write-Warning "Unable to parse package.json – skipping lint step"
    }
}

# Secret scan on staged files
$staged = git diff --cached --name-only
foreach ($file in $staged) {
    if ($file -match "\\.(pem|key|jws)$") {
        Write-Error "Secret file staged for commit: $file"
        exit 1
    }
}

exit 0
