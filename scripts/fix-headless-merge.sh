#!/bin/bash
cd /home/we4free/agent/repos/kernel-lane
git rm "lanes/broadcast/hygiene/latest.json" "lanes/broadcast/operator_alert_latest.json" "lanes/broadcast/system_state.json" "lanes/kernel/inbox/heartbeat-kernel.json" "lanes/kernel/state/sovereignty-report-latest.json" "lanes/kernel/state/task-chain-state.json" "logs/contradiction-adjudicator.json" 2>/dev/null || true
git checkout -- .
git stash drop 2>/dev/null || true
echo "Headless repo state:"
git status --short | head -20
