#!/bin/bash
echo "=== Full inference test against desktop GPU ==="
RESULT=$(curl -s http://100.95.92.117:11434/api/generate -d '{"model":"qwen2.5-coder:3b-instruct-q4_K_M","prompt":"def hello():","stream":false}')
echo "$RESULT" | python3 -c '
import sys,json
d=json.load(sys.stdin)
print("Model:", d.get("model","?"))
print("Done:", d.get("done",False))
print("Eval_count:", d.get("eval_count","?"))
print("Eval_duration_ns:", d.get("eval_duration","?"))
print("Response_len:", len(d.get("response","")))
print("Response_preview:", d.get("response","")[:200])
'
echo "=== No local ollama processes ==="
ps aux | grep ollama | grep -v grep || echo "NONE"
echo "=== Local endpoints dead ==="
curl -s --connect-timeout 2 http://100.95.40.99:11434/ 2>&1 || echo "100.95.40.99:11434 DEAD (correct)"
curl -s --connect-timeout 2 http://127.0.0.1:11434/ 2>&1 || echo "127.0.0.1:11434 DEAD (correct)"
echo "=== Final memory state ==="
free -h
