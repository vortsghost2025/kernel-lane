#!/usr/bin/env bash
# T9: Install Tailscale health check cron on headless
set -euo pipefail

CRON_SCRIPT="/home/we4free/agent/scripts/tailscale-health-check.sh"
CRON_MARKER="# TAILSCALE_HEALTH_CHECK"

# Write the health check script
cat > "$CRON_SCRIPT" << 'HEALTHCHECK'
#!/usr/bin/env bash
# tailscale-health-check.sh — verify Tailscale connectivity to desktop Ollama
DESKTOP_IP="100.95.92.117"
DESKTOP_PORT="11434"
LOG="/home/we4free/agent/scripts/tailscale-health-check.log"
MAX_LOG_LINES=500

check_ts() {
  ts_status=$(tailscale status --json 2>/dev/null)
  if [ -z "$ts_status" ]; then
    echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) CRIT tailscale status failed" >> "$LOG"
    return 1
  fi
  online=$(echo "$ts_status" | jq -r '.BackendState // "Unknown"')
  if [ "$online" != "Running" ]; then
    echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) CRIT tailscale not running: $online" >> "$LOG"
    return 1
  fi
  if ! curl -sf --max-time 5 "http://${DESKTOP_IP}:${DESKTOP_PORT}/api/tags" >/dev/null 2>&1; then
    echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) WARN tailscale up but desktop Ollama unreachable at ${DESKTOP_IP}:${DESKTOP_PORT}" >> "$LOG"
    return 1
  fi
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) OK tailscale running, desktop Ollama reachable" >> "$LOG"
  return 0
}

check_ts

# Rotate log
if [ -f "$LOG" ] && [ "$(wc -l < "$LOG")" -gt "$MAX_LOG_LINES" ]; then
  tail -n "$MAX_LOG_LINES" "$LOG" > "${LOG}.tmp" && mv "${LOG}.tmp" "$LOG"
fi
HEALTHCHECK

chmod +x "$CRON_SCRIPT"

# Install cron if not already present
CRON_EXISTING=$(crontab -l 2>/dev/null | grep -F "$CRON_MARKER" || true)
if [ -z "$CRON_EXISTING" ]; then
  (crontab -l 2>/dev/null; echo "*/5 * * * * $CRON_SCRIPT $CRON_MARKER") | crontab -
  echo "Cron installed: */5 * * * * $CRON_SCRIPT"
else
  echo "Cron already installed, skipping"
fi

# Verify
echo "=== Current crontab ==="
crontab -l 2>/dev/null | grep -F "$CRON_MARKER" || echo "NOT FOUND"

# Test run
echo "=== Test run ==="
bash "$CRON_SCRIPT"
cat /home/we4free/agent/scripts/tailscale-health-check.log

echo "=== T9 complete ==="
