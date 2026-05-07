#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const ENV_PATH = path.join(__dirname, '..', '.env');

function loadEnv() {
  try {
    const content = fs.readFileSync(ENV_PATH, 'utf8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq < 1) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim();
      if (!process.env[key]) process.env[key] = val;
    }
  } catch (_) {}
}

loadEnv();

const BASE_URL = process.env.NVIDIA_NIM_BASE_URL || 'https://integrate.api.nvidia.com/v1';
const API_KEY = process.env.NVIDIA_NIM_API_KEY;
const DEFAULT_MODEL = process.env.NVIDIA_NIM_MODEL || 'google/gemma-2-2b-it';

async function nimChat(messages, opts = {}) {
  if (!API_KEY) throw new Error('NVIDIA_NIM_API_KEY not set (check .env)');

  const model = opts.model || DEFAULT_MODEL;
  const temperature = opts.temperature ?? 0.2;
  const top_p = opts.top_p ?? 0.7;
  const max_tokens = opts.max_tokens ?? 1024;

  const url = `${BASE_URL}/chat/completions`;
  const body = { model, messages, temperature, top_p, max_tokens, stream: false };

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${API_KEY}`,
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`NIM ${resp.status}: ${text.slice(0, 500)}`);
  }

  const data = await resp.json();
  return data.choices?.[0]?.message?.content || '';
}

async function nimChatStream(messages, opts = {}) {
  if (!API_KEY) throw new Error('NVIDIA_NIM_API_KEY not set (check .env)');

  const model = opts.model || DEFAULT_MODEL;
  const temperature = opts.temperature ?? 0.2;
  const top_p = opts.top_p ?? 0.7;
  const max_tokens = opts.max_tokens ?? 1024;

  const url = `${BASE_URL}/chat/completions`;
  const body = { model, messages, temperature, top_p, max_tokens, stream: true };

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${API_KEY}`,
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`NIM ${resp.status}: ${text.slice(0, 500)}`);
  }

  let full = '';
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    for (const line of chunk.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('data: ')) continue;
      const data = trimmed.slice(6);
      if (data === '[DONE]') break;
      try {
        const parsed = JSON.parse(data);
        const token = parsed.choices?.[0]?.delta?.content || '';
        full += token;
        if (opts.onToken) opts.onToken(token);
      } catch (_) {}
    }
  }
  return full;
}

async function nimReview(code, opts = {}) {
  const prompt = `Review this code for bugs, security issues, and improvements. Be concise — list specific issues only, no praise:\n\n${code}`;
  return nimChat([{ role: 'user', content: prompt }], { ...opts, max_tokens: opts.max_tokens ?? 512 });
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const mode = args[0];

  if (mode === 'review') {
    const code = args.slice(1).join(' ') || fs.readFileSync('/dev/stdin', 'utf8');
    nimReview(code).then(r => console.log(r)).catch(e => { console.error(`ERROR: ${e.message}`); process.exit(1); });
  } else if (mode === 'chat') {
    const msg = args.slice(1).join(' ');
    nimChat([{ role: 'user', content: msg }]).then(r => console.log(r)).catch(e => { console.error(`ERROR: ${e.message}`); process.exit(1); });
  } else if (mode === 'stream') {
    const msg = args.slice(1).join(' ');
    nimChatStream([{ role: 'user', content: msg }], { onToken: t => process.stdout.write(t) })
      .catch(e => { console.error(`ERROR: ${e.message}`); process.exit(1); });
  } else {
    console.log('Usage: node nim-chat.js <review|chat|stream> [text]');
    console.log('  review  — code review (pass code as arg or stdin)');
    console.log('  chat    — single-turn chat');
    console.log('  stream  — streaming chat');
    process.exit(0);
  }
}

function nimAvailable() {
  return !!API_KEY && !API_KEY.includes('replace-with-your');
}

module.exports = { nimChat, nimChatStream, nimReview, nimAvailable, loadEnv };
