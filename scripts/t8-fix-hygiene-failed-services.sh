#!/usr/bin/env bash
set -euo pipefail
REPO="/home/we4free/agent/repos/Archivist-Agent"
SCRIPT="$REPO/scripts/hygiene-monitor-v2.sh"

cp "$SCRIPT" "${SCRIPT}.bak-$(date +%Y%m%d%H%M%S)"

# Replace the FAILED_SERVICES line with a version that filters systemctl header/summary lines
# Original: FAILED_SERVICES=$(systemctl --user list-units --type=service --state=failed 2>/dev/null) || true
# New: Capture raw, then filter out header (" UNIT LOAD...") and summary ("N loaded units listed")
sed -i 's/^FAILED_SERVICES=\$(systemctl --user list-units --type=service --state=failed 2>\/dev\/null) || true$/FAILED_SERVICES_RAW=$(systemctl --user list-units --type=service --state=failed 2>\/dev\/null || true)\nFAILED_SERVICES=$(echo "$FAILED_SERVICES_RAW" | grep -Ev "^$|^ UNIT LOAD|^[0-9]+ loaded units listed" || true)/' "$SCRIPT"

echo "=== Patched FAILED_SERVICES section ==="
grep -n -A2 'FAILED_SERVICES' "$SCRIPT"

cd "$REPO"
git add scripts/hygiene-monitor-v2.sh
git commit -m "[CI:Archivist-Agent] Fix hygiene failed_services false-positive: filter systemctl header lines from evidence"
git push origin main 2>&1 | tail -5

echo "=== T8 complete ==="
