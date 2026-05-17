#!/bin/bash
echo "=== Tailscale connectivity ==="
tailscale status | head -10

echo ""
echo "=== Dirty repos across all lanes ==="
for repo in kernel-lane Archivist-Agent self-organizing-library SwarmMind; do
  DIR="/home/we4free/agent/repos/${repo}"
  if [ -d "${DIR}" ]; then
    DIRTY=$(cd "${DIR}" && git status --short 2>/dev/null | wc -l)
    echo "${repo}: ${DIRTY} dirty files"
  fi
done

echo ""
echo "=== failed_services hygiene suppress candidate ==="
systemctl list-units --failed 2>/dev/null | head -5
