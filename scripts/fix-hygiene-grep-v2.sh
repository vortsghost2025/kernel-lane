#!/bin/bash
set -euo pipefail

# Fix the grep pattern in both copies of hygiene-monitor-v2.sh
# The issue: "^ UNIT LOAD" doesn't match "UNIT LOAD" (no leading space)
# Fix: use "^\s*UNIT LOAD" to match both

for f in \
  /home/we4free/agent/repos/Archivist-Agent/scripts/hygiene-monitor-v2.sh \
  /home/we4free/agent/repos/Archivist-Agent/.kilo/worktrees/accurate-carol/scripts/hygiene-monitor-v2.sh; do

  # Replace the grep-Ev line using perl for reliable regex
  perl -i -pe 's/grep -Ev "\^\$\\|^ UNIT LOAD\|^\\[0-9\\]\\+ loaded units listed"/grep -Ev "\^\$\\|^\\s*UNIT LOAD\|^\\[0-9\\]\\+ loaded units listed"/' "$f"
  echo "Patched: $f"
  grep -n 'FAILED_SERVICES=' "$f" | head -3
done

echo "=== Testing fix ==="
echo "UNIT LOAD ACTIVE SUB DESCRIPTION" | grep -Ev '^\$|^\s*UNIT LOAD|^[0-9]+ loaded units listed'
echo "grep exit: $?"
echo "0 loaded units listed." | grep -Ev '^\$|^\s*UNIT LOAD|^[0-9]+ loaded units listed'
echo "grep exit: $?"
