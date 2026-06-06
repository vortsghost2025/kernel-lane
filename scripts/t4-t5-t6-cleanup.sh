#!/bin/bash
set -e

echo "=== T4: Clean up stale hygiene snapshots ==="
HYGIENE_DIR="/home/we4free/agent/repos/kernel-lane/lanes/broadcast/hygiene"
BEFORE=$(ls "${HYGIENE_DIR}"/*.json 2>/dev/null | wc -l)
echo "Before: ${BEFORE} files"

cd "${HYGIENE_DIR}"
find . -name '*.json' -mtime +0 ! -name 'latest.json' -delete

AFTER=$(ls "${HYGIENE_DIR}"/*.json 2>/dev/null | wc -l)
echo "After: ${AFTER} files"
echo "Removed: $((BEFORE - AFTER)) stale hygiene snapshots"

echo ""
echo "=== T5: Archive quarantine items ==="
QUARANTINE_DIR="/home/we4free/agent/repos/kernel-lane/lanes/kernel/inbox/quarantine"
ARCHIVE_DIR="${QUARANTINE_DIR}/archive"
mkdir -p "${ARCHIVE_DIR}"
COUNT=$(ls "${QUARANTINE_DIR}"/*.json 2>/dev/null | wc -l)
echo "Moving ${COUNT} quarantine items to archive/"
mv "${QUARANTINE_DIR}"/*.json "${ARCHIVE_DIR}/" 2>/dev/null || echo "No json files to move"
echo "Quarantine archived."

echo ""
echo "=== T6: Clean up stale operator alerts ==="
BROADCAST_DIR="/home/we4free/agent/repos/kernel-lane/lanes/broadcast"
ALERT_BEFORE=$(ls "${BROADCAST_DIR}"/operator_alert_*.json 2>/dev/null | wc -l)
echo "Before: ${ALERT_BEFORE} alert files"

cd "${BROADCAST_DIR}"
ls operator_alert_*.json 2>/dev/null | grep -v 'operator_alert_latest.json' | xargs rm -f 2>/dev/null || true

ALERT_AFTER=$(ls "${BROADCAST_DIR}"/operator_alert_*.json 2>/dev/null | wc -l)
echo "After: ${ALERT_AFTER} alert files"
echo "Removed: $((ALERT_BEFORE - ALERT_AFTER)) stale alerts"

echo ""
echo "=== Commit cleanup to kernel-lane ==="
cd /home/we4free/agent/repos/kernel-lane
git add -A
git commit -m "[CI:kernel] Hygiene cleanup: stale snapshots, quarantine archive, stale alerts removed 2026-05-17" || echo "Nothing to commit"
git push origin main || echo "Push failed"
echo "T4+T5+T6 DONE"
