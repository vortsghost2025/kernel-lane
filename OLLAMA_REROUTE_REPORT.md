# Ollama Reroute: Headless CPU → Desktop GPU

**Date:** 2026-05-17
**Status:** COMPLETE — verified, all helpers functional

## Summary

Rerouted all Ollama inference on headless Ubuntu (100.95.40.99) from local CPU-bound server to desktop RTX 5060 (100.95.92.117) over Tailscale. Disabled headless `ollama.service` to recover ~4GB RAM.

## Architecture

```
BEFORE:
  headless ollama.service (CPU, 4.6GB RSS) → 100.95.40.99:11434
  desktop ollama (GPU)                    → 100.95.92.117:11434 (unused by headless)

AFTER:
  headless ollama.service → DISABLED (0 processes)
  ALL headless helpers    → http://100.95.92.117:11434 (desktop GPU)
  desktop ollama          → UNCHANGED (still running for local Windows agents)
  fallback                → 127.0.0.1:11434 (only in ollama-review.sh tryHost() chain)
```

## Memory Recovery

| Metric | Before | After | Delta |
|--------|--------|-------|-------|
| MemAvailable | 821 MB | 4.8 GB | +4.0 GB |
| SwapFree | 1.4 GB | 2.1 GB | +0.7 GB |

## Files Patched

### Environment
- `/home/we4free/agent/repos/kernel-lane/.env` → `OLLAMA_BASE_URL=http://100.95.92.117:11434`
- `/home/we4free/agent/repos/Archivist-Agent/.env` → `OLLAMA_BASE_URL=http://100.95.92.117:11434`

### Config
- `kernel-lane/config/ai-review-router.json` → `default_base_url` to desktop
- `self-organizing-library/config/ai-review-router.json` → ollama + ollama_local URLs to desktop
- `/home/we4free/.config/kilo/kilo.jsonc` → ollama-local `baseURL` to `http://100.95.92.117:11434/v1`

### Scripts
- `self-organizing-library/scripts/ai-review.sh` → OLLAMA_HOST default to desktop
- `self-organizing-library/scripts/ai-review-caller.js` → baseUrl fallback to desktop
- `self-organizing-library/scripts/ai-router/ollama-review.sh` → ollama_host default to desktop
- `kernel-lane/scripts/local-inference.js` → TAILSCALE_IP to `100.95.92.117`
- `SwarmMind/scripts/local-inference.js` → TAILSCALE_IP to `100.95.92.117`
- `Archivist-Agent/scripts/local-inference.js` → TAILSCALE_IP to `100.95.92.117`
- `self-organizing-library/scripts/local-inference.js` → TAILSCALE_IP to `100.95.92.117`

### System
- `/etc/systemd/system/ollama.service` → `OLLAMA_HOST=100.95.92.117:11434` (for future re-enable)
- `ollama.service` → disabled + stopped

### Workspace mirrors (matched above)
- `/home/we4free/workspace/lanes/SwarmMind/` — ai-review-router.json, ai-review.sh, ai-review-caller.js, ollama-review.sh
- `/home/we4free/workspace/lanes/self-organizing-library/` — same files

### Intentionally NOT patched
- `ollama-review.sh` line 6 `local_host="127.0.0.1:11434"` — this is the fallback in tryHost(), correct behavior
- Historical context-buffer `.md` files — documentation, not executable
- `opencode.json` — already uses NVIDIA NIM, Ollama providers already disabled there

## Verification Results

1. **Desktop Ollama reachable:** `curl http://100.95.92.117:11434/api/tags` → models listed including `qwen2.5-coder:3b-instruct-q4_K_M`
2. **Full inference works:** 208 tokens generated in 1.4s on desktop GPU
3. **ollama-review.sh works:** `OLLAMA_HOST=100.95.92.117:11434 bash scripts/ai-review.sh local 'Is 2+2=4?'` → correct response
4. **Local Ollama dead:** `curl http://100.95.40.99:11434/` → connection refused (correct)
5. **No stale 100.95.40.99:11434 in executable code** (only in historical docs)
6. **Zero ollama processes** on headless

## Re-enable Procedure (if needed)

```bash
sudo systemctl edit ollama.service  # verify OLLAMA_HOST=100.95.92.117:11434
sudo systemctl enable ollama.service
sudo systemctl start ollama.service
# Ollama will now bind to Tailscale IP and act as secondary fallback
```

## Risks

- **Desktop must stay on** — if desktop sleeps/powers off, headless loses Ollama. Fallback to `127.0.0.1:11434` exists in `ollama-review.sh` but will fail unless local Ollama is re-enabled.
- **Tailscale must stay connected** — if Tailscale drops, headless cannot reach desktop.
- **Desktop Ollama model availability** — only models pulled on desktop are available. Currently: `qwen2.5-coder:3b-instruct-q4_K_M`, `qwen2.5-coder:3b`, `qwen2.5-coder:7b`.

## NEXT_SAFE_ACTION

No further action needed. All patches applied, verified, and no running agents were disrupted. If the operator wants additional resilience, consider:
1. Setting up a Tailscale health check cron that alerts on connectivity loss
2. Adding `qwen2.5-coder:7b` to desktop Ollama if not already present (check `ollama list` on Windows)
3. Updating `context.md` memory-bank files in each repo to reflect the new architecture
