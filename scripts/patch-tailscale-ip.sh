#!/bin/bash
set -e

for repo in kernel-lane SwarmMind Archivist-Agent self-organizing-library; do
  FILE="/home/we4free/agent/repos/${repo}/scripts/local-inference.js"
  if [ -f "$FILE" ]; then
    sed -i "s|const TAILSCALE_IP = '100.95.40.99'|const TAILSCALE_IP = '100.95.92.117'|g" "$FILE"
    echo "Patched $repo/local-inference.js"
    grep TAILSCALE_IP "$FILE" | head -1
  fi
done

echo "=== Verifying no stale 100.95.40.99:11434 remains ==="
grep -rn "100.95.40.99:11434" /home/we4free/agent/repos/ /home/we4free/.config/kilo/ /home/we4free/workspace/lanes/ 2>/dev/null | grep -v node_modules | grep -v '.git/' || echo "NONE_FOUND"

echo "=== Verifying no stale 127.0.0.1:11434 in Ollama contexts ==="
grep -rn "127.0.0.1:11434" /home/we4free/agent/repos/ /home/we4free/.config/kilo/ /home/we4free/workspace/lanes/ 2>/dev/null | grep -v node_modules | grep -v '.git/' | grep -i ollama || echo "NONE_FOUND"

echo "=== DONE ==="
