#!/bin/bash
set -e

echo "=== T3: Committing dirty files across all 4 lanes ==="

REPOS="kernel-lane Archivist-Agent self-organizing-library SwarmMind"
BASE="/home/we4free/agent/repos"

for repo in $REPOS; do
  DIR="${BASE}/${repo}"
  if [ ! -d "${DIR}" ]; then
    echo "SKIP: ${repo} (dir not found)"
    continue
  fi
  cd "${DIR}"
  DIRTY=$(git status --short 2>/dev/null | wc -l)
  if [ "$DIRTY" -eq 0 ]; then
    echo "CLEAN: ${repo} (0 dirty files)"
    continue
  fi
  echo "COMMITTING: ${repo} (${DIRTY} dirty files)"
  git add -A
  git commit -m "[CI:${repo}] Session checkpoint: commit dirty files 2026-05-17" || echo "NOTHING TO COMMIT in ${repo}"
  git push origin main || echo "PUSH FAILED for ${repo}"
  echo "DONE: ${repo}"
done

echo ""
echo "=== Verify all clean ==="
for repo in $REPOS; do
  DIR="${BASE}/${repo}"
  if [ -d "${DIR}" ]; then
    cd "${DIR}"
    DIRTY=$(git status --short 2>/dev/null | wc -l)
    echo "${repo}: ${DIRTY} dirty files remaining"
  fi
done
