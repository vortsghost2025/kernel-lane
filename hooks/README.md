# Tracked Pre-Commit Hooks

This directory contains tracked, reviewable pre-commit hook infrastructure that replaces the old untracked `.git/hooks/pre-commit` pattern.

## Quick Start

```bash
node hooks/install.js
```

Dry run (show what would change without modifying files):

```bash
node hooks/install.js --dry-run
```

## Files

| File | Purpose |
|------|---------|
| `pre-commit.js` | The actual pre-commit hook (tracked, reviewable) |
| `lane-config.json` | Per-lane feature flags for optional checks |
| `install.js` | Installer — copies hook to `.git/hooks/` and sets permissions |
| `README.md` | This file |

## How It Works

1. `install.js` copies `pre-commit.js` into `.git/hooks/pre-commit`
2. The hook auto-detects which lane it's running in (from directory name)
3. It reads `lane-config.json` to determine which optional checks to enable
4. All mandatory checks (sovereignty, lint, secret scan, trust store) always run

## Checks by Lane

| Check | Archivist | Kernel | SwarmMind | Library |
|-------|-----------|--------|-----------|---------|
| Sovereignty | always | always | always | always |
| Gate 2 (schema) | yes | yes | no | yes |
| Canonical script guard | yes | no | no | no |
| NTFS filename check | no | yes | no | no |
| Lint | always | always | always | always |
| Secret scan | always | always | always | always |
| Trust store validation | always | always | always | always |
| Journal preflight | no | yes | no | no |

## Mandatory vs Optional

**Mandatory** (all lanes): sovereignty, lint, secret scan, trust store validation
**Optional** (per lane-config): Gate 2, canonical script guard, NTFS check, journal preflight

## Fresh Clone Setup

After cloning any lane repo that uses this hook system:

```bash
node hooks/install.js
```

## Deprecated Files

- `scripts/pre-commit.ps1` — Legacy PowerShell hook (lint + basic secret scan only). Replaced by `hooks/pre-commit.js`.
- `scripts/setup-hooks.js` — Old installer that installs a shell-based hook. Replaced by `hooks/install.js`.

Do NOT use the deprecated files. They install the wrong hook.

## Adding a New Check

1. Add the check function to `hooks/pre-commit.js`
2. Add a feature flag to `hooks/lane-config.json` (if optional)
3. Update this README's check table
4. Run `node hooks/install.js` to update the installed hook
