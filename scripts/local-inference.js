#!/usr/bin/env node
'use strict';

const http = require('http');
const https = require('https');
const path = require('path');
const fs = require('fs');

const DEFAULT_TIMEOUT_MS = 90000;
const DEFAULT_MAX_TOKENS = 256;
const DEFAULT_TEMPERATURE = 0.3;

function loadEnvFromDotenv() {
  const envPaths = [
    path.join(__dirname, '..', '.env'),
    path.join(process.cwd(), '.env'),
  ];
  for (const p of envPaths) {
    if (fs.existsSync(p)) {
      const raw = fs.readFileSync(p, 'utf8');
      for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx < 0) continue;
        const key = trimmed.slice(0, eqIdx).trim();
        const val = trimmed.slice(eqIdx + 1).trim();
        if (!process.env[key]) {
          process.env[key] = val;
        }
      }
      return;
    }
  }
}

loadEnvFromDotenv();

const TAILSCALE_IP = '100.95.92.117';

function getBaseUrl() {
  const raw = process.env.OLLAMA_BASE_URL || `http://${TAILSCALE_IP}:11434`;
  return raw.replace(/\/+$/, '');
}

function getModel() {
  return process.env.OLLAMA_MODEL || 'qwen2.5-coder:7b';
}

async function callLocalModel(prompt, opts = {}) {
  const baseUrl = getBaseUrl();
  const model = opts.model || getModel();
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  const maxTokens = opts.maxTokens || DEFAULT_MAX_TOKENS;
  const temperature = opts.temperature !== undefined ? opts.temperature : DEFAULT_TEMPERATURE;
  const system = opts.system || 'You are a concise assistant. Reply briefly.';

  const parsed = new URL(baseUrl);
  const isHttps = parsed.protocol === 'https:';
  const httpModule = isHttps ? https : http;

  const body = JSON.stringify({
    model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: prompt },
    ],
    stream: false,
    options: {
      num_predict: maxTokens,
      temperature,
    },
  });

  const reqOptions = {
    hostname: parsed.hostname,
    port: parsed.port || (isHttps ? 443 : 80),
    path: '/api/chat',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
    },
  };

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      req.destroy();
      reject(new Error(`Ollama request timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const req = httpModule.request(reqOptions, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        clearTimeout(timer);
        if (res.statusCode !== 200) {
          return reject(new Error(`Ollama ${res.statusCode}: ${data.slice(0, 500)}`));
        }
        try {
          const parsed = JSON.parse(data);
          const content = (parsed.message && parsed.message.content) || '';
          resolve({
            content: content.trim(),
            model: parsed.model || model,
            done: parsed.done || false,
            total_duration_ns: parsed.total_duration || null,
            eval_count: parsed.eval_count || null,
          });
        } catch (e) {
          reject(new Error(`Ollama parse error: ${e.message}\nRaw: ${data.slice(0, 500)}`));
        }
      });
    });

    req.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error(`Ollama connection error: ${e.message}`));
    });

    req.write(body);
    req.end();
  });
}

async function isAvailable() {
  const baseUrl = getBaseUrl();
  const parsed = new URL(baseUrl);
  const isHttps = parsed.protocol === 'https:';
  const httpModule = isHttps ? https : http;

  return new Promise((resolve) => {
    const req = httpModule.get({
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: '/api/tags',
      timeout: 5000,
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) return resolve(false);
        try {
          const json = JSON.parse(data);
          const model = getModel();
          const has = (json.models || []).some((m) => m.name === model);
          resolve(has);
        } catch {
          resolve(false);
        }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => { resolve(false); });
  });
}

module.exports = { callLocalModel, isAvailable, getBaseUrl, getModel };

if (require.main === module) {
  const arg = process.argv[2] || '';
  if (arg === '--check') {
    isAvailable().then((ok) => {
      console.log(ok ? 'AVAILABLE' : 'UNAVAILABLE');
      process.exit(ok ? 0 : 1);
    });
  } else if (arg === '--prompt' && process.argv[3]) {
    callLocalModel(process.argv[3], { maxTokens: 64 })
      .then((r) => { console.log(r.content); process.exit(0); })
      .catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
  } else {
    console.log('USAGE: local-inference.js --check | --prompt "text"');
    console.log('ENV:   OLLAMA_BASE_URL (default http://localhost:11434)');
    console.log('       OLLAMA_MODEL    (default qwen2.5-coder:7b)');
    process.exit(1);
  }
}
