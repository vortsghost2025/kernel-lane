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

function getTierConfig(tier) {
  const routerPath = path.join(__dirname, '..', 'config', 'ai-review-router.json');
  const router = JSON.parse(fs.readFileSync(routerPath, 'utf8'));
  const cfg = router.tiers[tier];
  if (!cfg) throw new Error(`Unknown tier: ${tier}. Valid: ${Object.keys(router.tiers).join(', ')}`);
  return { cfg, router };
}

function buildRequestOpts(tier) {
  const { cfg } = getTierConfig(tier);

  const baseUrl = cfg.default_base_url;
  const model = cfg.default_model;
  const apiKey = cfg.api_key_env ? process.env[cfg.api_key_env] : undefined;
  const maxTokens = cfg.max_tokens || 1024;

  if (cfg.api_key_env && !apiKey) {
    throw new Error(`${cfg.api_key_env} not set (check .env)`);
  }

  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  return { baseUrl, model, apiKey, maxTokens, headers, timeout: cfg.timeout_ms || 30000 };
}

async function callTier(tier, messages, opts = {}) {
  const { baseUrl, model, maxTokens, headers, timeout } = buildRequestOpts(tier);

  const url = `${baseUrl}/chat/completions`;
  const body = {
    model: opts.model || model,
    messages,
    max_tokens: opts.max_tokens || maxTokens,
    temperature: opts.temperature ?? 0.2,
    top_p: opts.top_p ?? 0.7,
    stream: false,
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`${tier} ${resp.status}: ${text.slice(0, 500)}`);
    }

    const data = await resp.json();
    return data.choices?.[0]?.message?.content || '';
  } finally {
    clearTimeout(timer);
  }
}

function isUncertain(response) {
  const routerPath = path.join(__dirname, '..', 'config', 'ai-review-router.json');
  const router = JSON.parse(fs.readFileSync(routerPath, 'utf8'));
  const signals = router.escalation.uncertainty_signals;
  const minMatches = router.escalation.min_signal_matches || 1;
  const lower = response.toLowerCase();
  let matches = 0;
  for (const sig of signals) {
    if (lower.includes(sig.toLowerCase())) matches++;
    if (matches >= minMatches) return true;
  }
  return false;
}

async function autoEscalate(prompt, opts = {}) {
  const routerPath = path.join(__dirname, '..', 'config', 'ai-review-router.json');
  const router = JSON.parse(fs.readFileSync(routerPath, 'utf8'));
  const order = router.escalation.order;
  const messages = [{ role: 'user', content: prompt }];
  const results = [];

  for (const tier of order) {
    if (tier === 'final') {
      results.push({ tier, response: null, note: 'Manual review needed — use Claude/GPT directly' });
      break;
    }

    try {
      const response = await callTier(tier, messages, opts);
      const uncertain = isUncertain(response);
      results.push({ tier, response, uncertain });

      if (!uncertain) return { final_tier: tier, response, results };

      if (opts.onEscalate) opts.onEscalate(tier, response);
    } catch (err) {
      results.push({ tier, response: null, error: err.message, uncertain: true });
    }
  }

  return { final_tier: 'final', response: results.find(r => r.response)?.response || '', results };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const tier = args[0];
  const prompt = args.slice(1).join(' ');

  if (!tier || !prompt) {
    console.log('Usage: node ai-review.js <tier|auto> "your prompt"');
    console.log('  Tiers: local, strong, openrouter, final, auto');
    console.log('  auto — escalate from local through tiers if uncertain');
    process.exit(0);
  }

  if (tier === 'auto') {
    autoEscalate(prompt, {
      onEscalate: (t, resp) => process.stderr.write(`[escalate] ${t} was uncertain, trying next tier...\n`),
    }).then(result => {
      if (result.final_tier === 'final') {
        console.log('[final] Previous tiers were uncertain. Review manually with Claude/GPT.');
        for (const r of result.results) {
          if (r.response) console.log(`\n[${r.tier}] (uncertain):\n${r.response.slice(0, 500)}`);
        }
      } else {
        console.log(result.response);
      }
    }).catch(e => { console.error(`FATAL: ${e.message}`); process.exit(1); });
  } else if (tier === 'final') {
    console.log('[final] No API call made. Copy your prompt to Claude/GPT manually.');
    console.log(`Prompt: ${prompt}`);
  } else {
    callTier(tier, [{ role: 'user', content: prompt }])
      .then(r => console.log(r))
      .catch(e => { console.error(`ERROR: ${e.message}`); process.exit(1); });
  }
}

module.exports = { callTier, autoEscalate, isUncertain, loadEnv, buildRequestOpts, getTierConfig };
