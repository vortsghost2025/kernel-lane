#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let LaneDiscovery;
try { LaneDiscovery = require('./util/lane-discovery.js').LaneDiscovery; } catch (_) { LaneDiscovery = null; }

function getRoots() {
  if (LaneDiscovery) {
    const ld = new LaneDiscovery();
		const map = {};
		for (const name of ld.listLanes()) { map[name] = ld.getLocalPath(name); }
    return map;
  }
  const base = path.resolve(__dirname, '..');
  return {
    archivist: base,
    kernel: path.join(base, '..', 'kernel-lane'),
    swarmmind: path.join(base, '..', 'SwarmMind'),
    library: path.join(base, '..', 'self-organizing-library')
  };
}

function sha256(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function checkRegression(scriptName, content) {
  var violations = [];
  if (/^[A-Za-z]:[\\\/]/m.test(content)) {
    violations.push('no_hardcoded_S_paths: found hardcoded Windows path');
  }
  var requireMatches = content.match(/require\(['"]\.\/[^'"]+['"]\)/g) || [];
  var seen = {};
  for (var i = 0; i < requireMatches.length; i++) {
    if (seen[requireMatches[i]]) {
      violations.push('no_duplicate_requires: ' + requireMatches[i] + ' appears more than once');
      break;
    }
    seen[requireMatches[i]] = true;
  }
  if (scriptName === 'lane-worker.js' && content.indexOf('verifyOutputProvenance') === -1) {
    violations.push('provenance_enforcement_present: lane-worker.js missing verifyOutputProvenance in decideRoute');
  }
  if (scriptName === 'output-provenance.js') {
    if (content.indexOf('ensureOutputProvenance') === -1) violations.push('output_provenance_functions_exist: missing ensureOutputProvenance');
    if (content.indexOf('verifyOutputProvenance') === -1) violations.push('output_provenance_functions_exist: missing verifyOutputProvenance');
  }
  var gatewayFuncs = ['signAndDeliver', 'decideRoute', 'createResponse'];
  for (var g = 0; g < gatewayFuncs.length; g++) {
    var fn = gatewayFuncs[g];
    var fnIdx = content.indexOf('function ' + fn);
    if (fnIdx === -1) fnIdx = content.indexOf(fn + '(');
    if (fnIdx !== -1) {
      var fnBlock = content.substring(fnIdx, Math.min(fnIdx + 2000, content.length));
      var consoleLogMatch = fnBlock.match(/console\.log\(/g);
      if (consoleLogMatch) {
        var hasGated = fnBlock.indexOf('process.env.') !== -1;
        if (!hasGated) {
          violations.push('no_unconditional_console_log: ' + fn + ' has console.log without env gate');
        }
      }
    }
  }
  return violations;
}

function syncAndGuard(dryRun) {
  var roots = getRoots();
  var canonical = roots.archivist;
  var registryPath = path.join(canonical, 'scripts', 'CANONICAL_SCRIPT_REGISTRY.json');

  if (!fs.existsSync(registryPath)) {
    console.error('[FATAL] CANONICAL_SCRIPT_REGISTRY.json not found at ' + registryPath);
    process.exit(1);
  }

  var registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  var sharedScripts = registry.shared_scripts || [];
  var sharedSchemas = registry.shared_schemas || [];
  var sharedUtilModules = registry.shared_util_modules || [];
  var targets = ['kernel', 'swarmmind', 'library'];

  var results = { synced: [], already_aligned: [], regression_failures: [], missing_canonical: [] };

  var allFiles = sharedScripts.map(function(s) { return { name: s, dir: 'scripts' }; })
    .concat(sharedSchemas.map(function(s) { return { name: s, dir: '' }; }))
    .concat(sharedUtilModules.map(function(s) { return { name: path.basename(s), dir: path.dirname(s) }; }));

  for (var f = 0; f < allFiles.length; f++) {
    var file = allFiles[f];
    var canonPath = file.dir ? path.join(canonical, file.dir, file.name) : path.join(canonical, file.name);

    if (!fs.existsSync(canonPath)) {
      results.missing_canonical.push(file.name);
      continue;
    }

    var canonContent = fs.readFileSync(canonPath, 'utf8');
    var canonHash = crypto.createHash('sha256').update(canonContent).digest('hex');

    for (var t = 0; t < targets.length; t++) {
      var lane = targets[t];
      var targetPath = file.dir ? path.join(roots[lane], file.dir, file.name) : path.join(roots[lane], file.name);
      var targetHash = sha256(targetPath);

      if (targetHash === canonHash) {
        results.already_aligned.push(file.name + ' -> ' + lane);
        continue;
      }

      var violations = checkRegression(file.name, canonContent);
      if (violations.length > 0) {
        results.regression_failures.push({ file: file.name, lane: lane, violations: violations });
        console.error('[REGRESSION] ' + file.name + ' -> ' + lane + ' BLOCKED:');
        for (var v = 0; v < violations.length; v++) {
          console.error('  - ' + violations[v]);
        }
        continue;
      }

      if (dryRun) {
        console.log('[DRY-RUN] Would sync: ' + file.name + ' -> ' + lane);
        results.synced.push(file.name + ' -> ' + lane + ' (dry-run)');
      } else {
        var targetDir = path.dirname(targetPath);
        if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
        fs.writeFileSync(targetPath, canonContent, 'utf8');
        console.log('[SYNCED] ' + file.name + ' -> ' + lane);
        results.synced.push(file.name + ' -> ' + lane);
      }
    }
  }

  console.log('\n=== SYNC-AND-GUARD RESULTS ===');
  console.log('Synced: ' + results.synced.length);
  console.log('Already aligned: ' + results.already_aligned.length);
  console.log('Regression failures: ' + results.regression_failures.length);
  console.log('Missing canonical: ' + results.missing_canonical.length);

  if (results.regression_failures.length > 0) {
    console.error('\n[FATAL] Regression guard blocked sync. Fix canonical source first.');
    process.exit(1);
  }

  return results;
}

if (require.main === module) {
  var args = process.argv.slice(2);
  var dryRun = args.indexOf('--dry-run') !== -1;
  if (dryRun) console.log('Running in DRY-RUN mode\n');
  syncAndGuard(dryRun);
}

module.exports = { syncAndGuard, checkRegression, sha256 };
