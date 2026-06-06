#!/bin/bash
cd /home/we4free/agent/repos/kernel-lane
git stash
git pull --rebase origin main
git stash pop 2>/dev/null || true
echo "Done. Journal should now be present:"
ls -la JOURNAL-2026-05-17.md 2>/dev/null || echo "Journal not found"
