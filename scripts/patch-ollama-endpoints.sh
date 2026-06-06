#!/bin/bash
set -e

DESKTOP="100.95.92.117:11434"
OLD_LOCAL="100.95.40.99:11434"
OLD_LOOPBACK="127.0.0.1:11434"

echo "=== Patching kernel-lane ai-review-router.json ==="
sed -i "s|http://localhost:11434|http://${DESKTOP}|g" /home/we4free/agent/repos/kernel-lane/config/ai-review-router.json
grep "default_base_url" /home/we4free/agent/repos/kernel-lane/config/ai-review-router.json

echo "=== Patching library ai-review-router.json ==="
sed -i "s|http://${OLD_LOCAL}|http://${DESKTOP}|g" /home/we4free/agent/repos/self-organizing-library/config/ai-review-router.json
sed -i "s|http://${OLD_LOOPBACK}|http://${DESKTOP}|g" /home/we4free/agent/repos/self-organizing-library/config/ai-review-router.json
grep -E "ollama" /home/we4free/agent/repos/self-organizing-library/config/ai-review-router.json

echo "=== Patching library ai-review.sh ==="
sed -i "s|100.95.40.99:11434|${DESKTOP}|g" /home/we4free/agent/repos/self-organizing-library/scripts/ai-review.sh
grep -n "OLLAMA_HOST\|100.95" /home/we4free/agent/repos/self-organizing-library/scripts/ai-review.sh

echo "=== Patching library ai-review-caller.js ==="
sed -i "s|http://127.0.0.1:11434|http://${DESKTOP}|g" /home/we4free/agent/repos/self-organizing-library/scripts/ai-review-caller.js
grep baseUrl /home/we4free/agent/repos/self-organizing-library/scripts/ai-review-caller.js

echo "=== Patching library ollama-review.sh ==="
sed -i "s|100.95.40.99:11434|${DESKTOP}|g" /home/we4free/agent/repos/self-organizing-library/scripts/ai-router/ollama-review.sh
grep -n "ollama_host\|100.95\|default" /home/we4free/agent/repos/self-organizing-library/scripts/ai-router/ollama-review.sh

echo "=== Patching kilo.jsonc ==="
sed -i "s|http://127.0.0.1:11434/v1|http://${DESKTOP}/v1|g" /home/we4free/.config/kilo/kilo.jsonc
grep baseURL /home/we4free/.config/kilo/kilo.jsonc

echo "=== Patching systemd unit (for future re-enable) ==="
echo "1980" | sudo -S sed -i "s|OLLAMA_HOST=${OLD_LOCAL}|OLLAMA_HOST=${DESKTOP}|g" /etc/systemd/system/ollama.service 2>/dev/null
grep OLLAMA_HOST /etc/systemd/system/ollama.service

echo "=== Patching local-inference.js TAILSCALE_IP in all repos ==="
for repo in kernel-lane SwarmMind Archivist-Agent self-organizing-library; do
  FILE="/home/we4free/agent/repos/${repo}/scripts/local-inference.js"
  if [ -f "$FILE" ]; then
    sed -i "s|const TAILSCALE_IP = .*|const TAILSCALE_IP = process.env.TAILSCALE_IP || '100.95.92.117';  // desktop RTX 5060 over Tailscale|g" "$FILE" 2>/dev/null || true
    grep "TAILSCALE_IP" "$FILE" | head -1
  fi
done

echo "=== Patching workspace mirrors ==="
for lane in SwarmMind self-organizing-library; do
  for f in \
    "/home/we4free/workspace/lanes/${lane}/config/ai-review-router.json" \
    "/home/we4free/workspace/lanes/${lane}/scripts/ai-review.sh" \
    "/home/we4free/workspace/lanes/${lane}/scripts/ai-review-caller.js" \
    "/home/we4free/workspace/lanes/${lane}/scripts/ai-router/ollama-review.sh"; do
    if [ -f "$f" ]; then
      sed -i "s|100.95.40.99:11434|${DESKTOP}|g" "$f"
      sed -i "s|http://127.0.0.1:11434|http://${DESKTOP}|g" "$f"
      echo "Patched: $f"
    fi
  done
done

echo "=== Patching SwarmMind repo copies ==="
for f in \
  "/home/we4free/agent/repos/SwarmMind/config/ai-review-router.json" \
  "/home/we4free/agent/repos/SwarmMind/scripts/ai-review.sh" \
  "/home/we4free/agent/repos/SwarmMind/scripts/ai-review-caller.js" \
  "/home/we4free/agent/repos/SwarmMind/scripts/ai-router/ollama-review.sh"; do
  if [ -f "$f" ]; then
    sed -i "s|100.95.40.99:11434|${DESKTOP}|g" "$f"
    sed -i "s|http://127.0.0.1:11434|http://${DESKTOP}|g" "$f"
    echo "Patched: $f"
  fi
done

echo "=== ALL PATCHES COMPLETE ==="
