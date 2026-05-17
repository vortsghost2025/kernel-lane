# kernel-lane Context


## Ollama Architecture (as of 2026-05-13)

- Desktop (100.95.92.117): Ollama server ON, GPU RTX 5060
- Headless (100.95.40.99): Ollama server OFF (disabled), client-only
- All inference via Tailscale to desktop:11434
- ollama.service disabled; OLLAMA_HOST=100.95.92.117:11434 in systemd unit for future re-enable
- Models on desktop: qwen2.5-coder:3b, qwen2.5-coder:3b-instruct-q4_K_M, qwen2.5-coder:7b
- RAM recovered: 821MB -> 4.8GB available by disabling local Ollama

