#!/usr/bin/env python3
import re

files = [
    "/home/we4free/agent/repos/Archivist-Agent/scripts/hygiene-monitor-v2.sh",
    "/home/we4free/agent/repos/Archivist-Agent/.kilo/worktrees/accurate-carol/scripts/hygiene-monitor-v2.sh",
]

old_frag = '^ UNIT LOAD'
new_frag = r'^\s*UNIT LOAD'

for f in files:
    try:
        with open(f, 'r') as fh:
            content = fh.read()
        if old_frag in content:
            content = content.replace(old_frag, new_frag)
            with open(f, 'w') as fh:
                fh.write(content)
            print(f"Patched: {f}")
        else:
            print(f"Already patched or not found: {f}")
        # Verify
        with open(f, 'r') as fh:
            for i, line in enumerate(fh, 1):
                if 'FAILED_SERVICES=' in line:
                    print(f"  Line {i}: {line.rstrip()}")
    except FileNotFoundError:
        print(f"NOT FOUND: {f}")

# Test
import subprocess
r = subprocess.run(['bash', '-c', 'echo "UNIT LOAD ACTIVE SUB DESCRIPTION" | grep -Ev \'^\\$|^\\s*UNIT LOAD|^[0-9]+ loaded units listed\'; echo "exit:$?"'], capture_output=True, text=True)
print(f"Test output: {r.stdout.strip()}")
