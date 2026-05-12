#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { ensureOutputProvenance } = require('./output-provenance');

function loadEnv() {
  var envPath = path.join(__dirname, '..', '.env');
  if (fs.existsSync(envPath)) {
    var lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!line || line.startsWith('#')) continue;
      var eqIdx = line.indexOf('=');
      if (eqIdx === -1) continue;
      var key = line.slice(0, eqIdx).trim();
      var val = line.slice(eqIdx + 1).trim();
      if (!process.env[key]) {
        process.env[key] = val;
      }
    }
  }
}

loadEnv();

function configPath() {
  return path.join(__dirname, '..', 'config', 'ai-review-router.json');
}

function loadConfig() {
  var cp = configPath();
  if (!fs.existsSync(cp)) return null;
  try {
    return JSON.parse(fs.readFileSync(cp, 'utf8'));
  } catch (e) {
    return null;
  }
}

function resolveTierConfig(tierId, tier) {
  var baseUrl = process.env[tier.base_url_env] || tier.default_base_url;
  var model = process.env[tier.model_env] || tier.default_model;
  var apiKey = tier.api_key_env ? (process.env[tier.api_key_env] || '') : '';
  return { baseUrl: baseUrl.replace(/\/+$/, ''), model: model, apiKey: apiKey, maxTokens: tier.max_tokens || 1024, timeoutMs: tier.timeout_ms || 30000 };
}

function bodyContainsSignal(body, signals) {
  if (!body || !signals) return false;
  var lower = body.toLowerCase();
  for (var i = 0; i < signals.length; i++) {
    if (lower.includes(signals[i].toLowerCase())) return true;
  }
  return false;
}

function queryOllama(prompt, tierConfig) {
  return new Promise(function (resolve, reject) {
    var body = JSON.stringify({
      model: tierConfig.model,
      prompt: prompt,
      stream: false,
      options: { num_predict: tierConfig.maxTokens }
    });

    var urlObj = new URL(tierConfig.baseUrl + '/api/generate');
    var opts = {
      hostname: urlObj.hostname,
      port: urlObj.port,
      path: urlObj.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: tierConfig.timeoutMs
    };

    var req = http.request(opts, function (res) {
      var data = '';
      res.on('data', function (chunk) { data += chunk; });
      res.on('end', function () {
        try {
          var parsed = JSON.parse(data);
          if (parsed.response) {
            resolve({ ok: true, content: parsed.response, model: tierConfig.model, tier: 'local' });
          } else {
            resolve({ ok: false, error: parsed.error || 'Empty response', tier: 'local' });
          }
        } catch (e) {
          resolve({ ok: false, error: 'Parse error: ' + e.message, tier: 'local' });
        }
      });
    });

    req.on('error', function (e) { resolve({ ok: false, error: e.message, tier: 'local' }); });
    req.on('timeout', function () { req.destroy(); resolve({ ok: false, error: 'Timeout after ' + tierConfig.timeoutMs + 'ms', tier: 'local' }); });
    req.write(body);
    req.end();
  });
}

function queryNim(prompt, tierConfig) {
  return new Promise(function (resolve, reject) {
    if (!tierConfig.apiKey || tierConfig.apiKey.includes('placeholder')) {
      return resolve({ ok: false, error: 'No valid NVIDIA NIM API key configured', tier: 'strong' });
    }

    var payload = JSON.stringify({
      model: tierConfig.model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: tierConfig.maxTokens
    });

    var urlObj = new URL(tierConfig.baseUrl + '/chat/completions');
    var opts = {
      hostname: urlObj.hostname,
      port: urlObj.port || 443,
      path: urlObj.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + tierConfig.apiKey,
        'Content-Length': Buffer.byteLength(payload)
      },
      timeout: tierConfig.timeoutMs
    };

    var mod = urlObj.protocol === 'https:' ? https : http;
    var req = mod.request(opts, function (res) {
      var data = '';
      res.on('data', function (chunk) { data += chunk; });
      res.on('end', function () {
        try {
          var parsed = JSON.parse(data);
          var content = parsed.choices && parsed.choices[0] && parsed.choices[0].message ? parsed.choices[0].message.content : null;
          if (content) {
            resolve({ ok: true, content: content, model: tierConfig.model, tier: 'strong' });
          } else {
            resolve({ ok: false, error: parsed.error ? parsed.error.message || JSON.stringify(parsed.error) : 'Empty response', tier: 'strong' });
          }
        } catch (e) {
          resolve({ ok: false, error: 'Parse error: ' + e.message, tier: 'strong' });
        }
      });
    });
    req.on('error', function (e) { resolve({ ok: false, error: e.message, tier: 'strong' }); });
    req.on('timeout', function () { req.destroy(); resolve({ ok: false, error: 'Timeout after ' + tierConfig.timeoutMs + 'ms', tier: 'strong' }); });
    req.write(payload);
    req.end();
  });
}

function queryOpenRouter(prompt, tierConfig) {
  return new Promise(function (resolve, reject) {
    if (!tierConfig.apiKey || tierConfig.apiKey.includes('placeholder')) {
      return resolve({ ok: false, error: 'No valid OpenRouter API key configured', tier: 'openrouter' });
    }

    var payload = JSON.stringify({
      model: tierConfig.model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: tierConfig.maxTokens
    });

    var urlObj = new URL(tierConfig.baseUrl + '/chat/completions');
    var opts = {
      hostname: urlObj.hostname,
      port: urlObj.port || 443,
      path: urlObj.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + tierConfig.apiKey,
        'Content-Length': Buffer.byteLength(payload)
      },
      timeout: tierConfig.timeoutMs
    };

    var mod = urlObj.protocol === 'https:' ? https : http;
    var req = mod.request(opts, function (res) {
      var data = '';
      res.on('data', function (chunk) { data += chunk; });
      res.on('end', function () {
        try {
          var parsed = JSON.parse(data);
          var content = parsed.choices && parsed.choices[0] && parsed.choices[0].message ? parsed.choices[0].message.content : null;
          if (content) {
            resolve({ ok: true, content: content, model: tierConfig.model, tier: 'openrouter' });
          } else {
            var fbModel = process.env[tierConfig.fallback_model_env] || tierConfig.default_fallback_model;
            if (fbModel && fbModel !== tierConfig.model) {
              var fbConfig = Object.assign({}, tierConfig, { model: fbModel });
              queryOpenRouter(prompt, fbConfig).then(function (fbResult) {
                resolve(fbResult);
              });
            } else {
              resolve({ ok: false, error: parsed.error ? parsed.error.message || JSON.stringify(parsed.error) : 'Empty response', tier: 'openrouter' });
            }
          }
        } catch (e) {
          resolve({ ok: false, error: 'Parse error: ' + e.message, tier: 'openrouter' });
        }
      });
    });
    req.on('error', function (e) { resolve({ ok: false, error: e.message, tier: 'openrouter' }); });
    req.on('timeout', function () { req.destroy(); resolve({ ok: false, error: 'Timeout after ' + tierConfig.timeoutMs + 'ms', tier: 'openrouter' }); });
    req.write(payload);
    req.end();
  });
}

function queryTier(tierId, prompt, tierConfig) {
  switch (tierId) {
    case 'local': return queryOllama(prompt, tierConfig);
    case 'strong': return queryNim(prompt, tierConfig);
    case 'openrouter': return queryOpenRouter(prompt, tierConfig);
    default: return Promise.resolve({ ok: false, error: 'Unknown tier: ' + tierId, tier: tierId });
  }
}

var UNCERTAINTY_CACHE = {};

function resetUncertaintyCache() {
  UNCERTAINTY_CACHE = {};
}

async function queryRouter(prompt, options) {
  var config = loadConfig();
  if (!config) {
    return { ok: false, error: 'AI Review Router config not found at ' + configPath(), tier_used: null };
  }

  var escalation = config.escalation || { order: ['local', 'strong', 'openrouter', 'final'], uncertainty_signals: [], min_signal_matches: 1 };
  var order = escalation.order || ['local'];
  var signals = escalation.uncertainty_signals || [];
  var minSignals = escalation.min_signal_matches || 1;
  var maxRetries = (options && options.maxRetries) || 2;
  var cacheKey = options && options.cacheKey ? options.cacheKey : null;

  if (cacheKey && UNCERTAINTY_CACHE[cacheKey]) {
    return UNCERTAINTY_CACHE[cacheKey];
  }

  var lastResult = null;
  for (var t = 0; t < order.length; t++) {
    var tierId = order[t];
    if (tierId === 'final') {
      return {
        ok: false,
        error: 'All automated tiers exhausted. Manual review required.',
        tier_used: 'final',
        last_tier_result: lastResult
      };
    }

    var tier = config.tiers[tierId];
    if (!tier) continue;

    var tierConfig = resolveTierConfig(tierId, tier);
    var attempts = 0;
    while (attempts <= maxRetries) {
      attempts++;
      var result = await queryTier(tierId, prompt, tierConfig);
      lastResult = result;

      if (result.ok && result.content) {
        if (bodyContainsSignal(result.content, signals)) {
          lastResult = { ok: true, content: result.content, model: result.model, tier: result.tier, uncertain: true };
          break;
        }
        if (cacheKey) UNCERTAINTY_CACHE[cacheKey] = result;
        return result;
      }

      if (attempts > maxRetries) {
        break;
      }
    }
  }

  var final = lastResult || { ok: false, error: 'All tiers exhausted', tier_used: order[order.length - 1] || 'unknown' };
  return final;
}

module.exports = {
  queryRouter: queryRouter,
  queryOllama: queryOllama,
  queryNim: queryNim,
  queryOpenRouter: queryOpenRouter,
  loadConfig: loadConfig,
  resetUncertaintyCache: resetUncertaintyCache,
  loadEnv: loadEnv
};

if (require.main === module) {
  (async function () {
    var args = process.argv.slice(2);
    var prompt = args.join(' ').trim();
    if (!prompt) {
      console.log('Usage: node ai-review-router.js <prompt>');
      console.log('  Queries Ollama (tier 1), escalates through tiers on failure/uncertainty.');
      console.log('  --cache-key=<key>  Cache results by key to avoid redundant queries.');
      console.log('  --max-retries=<n>  Override max retries per tier (default: 2).');
      process.exit(0);
    }

    var options = {};
    var cacheMatch = prompt.match(/--cache-key=(\S+)/);
    if (cacheMatch) { options.cacheKey = cacheMatch[1]; prompt = prompt.replace(cacheMatch[0], '').trim(); }
    var retryMatch = prompt.match(/--max-retries=(\d+)/);
    if (retryMatch) { options.maxRetries = parseInt(retryMatch[1], 10); prompt = prompt.replace(retryMatch[0], '').trim(); }

    console.log('[ai-review-router] Prompt: ' + prompt.slice(0, 120) + (prompt.length > 120 ? '...' : ''));
    var result = await queryRouter(prompt, options);
    var provenanceInjected = false;
    if (result.ok && result.content) {
      result.content = ensureOutputProvenance(result.content, {
        agent: 'ai-review-router',
        lane: 'kernel',
        target: prompt.slice(0, 80),
        generated_at: new Date().toISOString()
      });
      provenanceInjected = true;
    }
    console.log(JSON.stringify({ ok: result.ok, tier_used: result.tier_used || result.tier, model: result.model || null, uncertain: result.uncertain || false, content_length: result.content ? result.content.length : 0, error: result.error || null, provenance_injected: provenanceInjected, content: result.content || null }, null, 2));
  })().catch(function (err) {
    console.error('[ai-review-router] FATAL:', err.message);
    process.exit(1);
  });
}
