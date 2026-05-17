#!/bin/bash
echo "=== All lane heartbeats ==="
for lane in kernel archivist library swarmmind; do
  case $lane in
    kernel)   FILE="/home/we4free/agent/repos/kernel-lane/lanes/kernel/inbox/heartbeat-kernel.json" ;;
    archivist) FILE="/home/we4free/agent/repos/Archivist-Agent/lanes/archivist/inbox/heartbeat-archivist.json" ;;
    library)  FILE="/home/we4free/agent/repos/self-organizing-library/lanes/library/inbox/heartbeat-library.json" ;;
    swarmmind) FILE="/home/we4free/agent/repos/SwarmMind/lanes/swarmmind/inbox/heartbeat-swarmmind.json" ;;
  esac
  if [ -f "$FILE" ]; then
    TS=$(python3 -c "import json; d=json.load(open('$FILE')); print(d.get('heartbeat',{}).get('last_heartbeat_at','NONE'))" 2>/dev/null)
    STAT=$(python3 -c "import json; d=json.load(open('$FILE')); print(d.get('heartbeat',{}).get('status','UNKNOWN'))" 2>/dev/null)
    echo "$lane: last_hb=$TS status=$STAT"
  else
    echo "$lane: NO HEARTBEAT FILE"
  fi
done

echo ""
echo "=== Archivist inbox item count (non-heartbeat) ==="
ls /home/we4free/agent/repos/Archivist-Agent/lanes/archivist/inbox/*.json 2>/dev/null | grep -v heartbeat | wc -l

echo ""
echo "=== Archivist processed count ==="
ls /home/we4free/agent/repos/Archivist-Agent/lanes/archivist/inbox/processed/*.json 2>/dev/null | wc -l

echo ""
echo "=== Stale hygiene files (older than 24h) ==="
find /home/we4free/agent/repos/kernel-lane/lanes/broadcast/hygiene/ -name '*.json' -mtime +0 2>/dev/null | wc -l

echo ""
echo "=== Quarantine items by type ==="
ls /home/we4free/agent/repos/kernel-lane/lanes/kernel/inbox/quarantine/*.json 2>/dev/null | sed 's/.*\///' | sed 's/-[0-9]*\.json//' | sort | uniq -c | sort -rn | head -10

echo ""
echo "=== Operator alerts count ==="
ls /home/we4free/agent/repos/kernel-lane/lanes/broadcast/operator_alert_*.json 2>/dev/null | wc -l

echo ""
echo "=== Disk usage of hygiene + quarantine ==="
du -sh /home/we4free/agent/repos/kernel-lane/lanes/broadcast/hygiene/
du -sh /home/we4free/agent/repos/kernel-lane/lanes/kernel/inbox/quarantine/
