#!/bin/bash
set -e

echo "=== T7: Add Ollama architecture note to each repo ==="

ARCH_NOTE='
## Ollama Architecture (as of 2026-05-13)

- Desktop (100.95.92.117): Ollama server ON, GPU RTX 5060
- Headless (100.95.40.99): Ollama server OFF (disabled), client-only
- All inference via Tailscale to desktop:11434
- ollama.service disabled; OLLAMA_HOST=100.95.92.117:11434 in systemd unit for future re-enable
- Models on desktop: qwen2.5-coder:3b, qwen2.5-coder:3b-instruct-q4_K_M, qwen2.5-coder:7b
- RAM recovered: 821MB -> 4.8GB available by disabling local Ollama
'

REPOS="kernel-lane Archivist-Agent self-organizing-library SwarmMind"
BASE="/home/we4free/agent/repos"

for repo in $REPOS; do
  DIR="${BASE}/${repo}"
  if [ ! -d "${DIR}" ]; then
    echo "SKIP: ${repo}"
    continue
  fi
  cd "${DIR}"
  
  CONTEXT_FILE="context.md"
  if [ ! -f "${CONTEXT_FILE}" ]; then
    echo "# ${repo} Context" > "${CONTEXT_FILE}"
  fi
  
  if grep -q "Ollama Architecture" "${CONTEXT_FILE}" 2>/dev/null; then
    echo "EXISTS: ${repo} already has Ollama architecture note"
    continue
  fi
  
  echo "" >> "${CONTEXT_FILE}"
  echo "${ARCH_NOTE}" >> "${CONTEXT_FILE}"
  echo "ADDED: ${repo} context.md"
  
  git add "${CONTEXT_FILE}"
  git commit -m "[CI:${repo}] Add Ollama architecture note to context.md" || echo "Nothing to commit in ${repo}"
  git push origin main || echo "Push failed for ${repo}"
done

echo "T7 DONE"
