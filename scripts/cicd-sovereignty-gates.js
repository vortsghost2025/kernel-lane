#!/usr/bin/env node
/**
 * CI/CD SOVEREIGNTY GATES — Phase 1
 * Gate 1: Push-time sovereignty scan (full repo, not just staged)
 * Gate 2: Schema compliance check for lane message files
 *
 * Spec: cicd-sovereignty-gates-v1
 * Phase: 1 (Gates 1+2)
 * Origin: Adapted from cicd-sovereignty-gates-v1 spec approved 2026-05-02
 * Last Updated: 2026-05-02
 */

const fs = require('fs');
const path = require('path');

const LANE_ROOT = path.join(__dirname, '..');
const LANE_NAME = 'Kernel';
const SCHEMA_DIR = path.join(LANE_ROOT, 'schemas');
const INBOX_MESSAGE_SCHEMA = 'inbox-message-v1.json';
const BROADCAST_MESSAGE_SCHEMA = 'broadcast-message-v1.json';
const BROADCAST_ACK_SCHEMA = 'broadcast-acknowledgment-schema-v1.json';

const args = process.argv.slice(2);
const strict = args.includes('--strict');
const gateFilter = args.find(function(a) { return a.startsWith('--gate='); });
const gateValue = gateFilter ? gateFilter.split('=')[1] : null;
const jsonOutput = args.includes('--json');

let exitCode = 0;
const results = { gate1: null, gate2: null, passed: true, violations: [] };

function runGate1() {
  const gateResult = { name: 'push-time-sovereignty-scan', passed: true, violations: [], scanned: 0 };
  const enforcerPath = path.join(LANE_ROOT, 'scripts', 'sovereignty-enforcer.js');

  if (!fs.existsSync(enforcerPath)) {
    gateResult.passed = true;
    gateResult.scanned = 0;
    return gateResult;
  }

  const childProcess = require('child_process');
  try {
    const output = childProcess.execSync('node "' + enforcerPath + '" --strict --lane ' + LANE_NAME, {
      cwd: LANE_ROOT,
      encoding: 'utf8',
      timeout: 60000
    });
    const match = output.match(/scanned[:\s]+(\d+)/i);
    gateResult.scanned = match ? parseInt(match[1], 10) : 0;
  } catch (err) {
    gateResult.passed = false;
    gateResult.violations.push({
      error: 'Sovereignty enforcer returned non-zero exit code',
      stdout: (err.stdout || '').substring(0, 500),
      stderr: (err.stderr || '').substring(0, 500)
    });
  }

  return gateResult;
}

function loadSchema(schemaFile) {
  const schemaPath = path.join(SCHEMA_DIR, schemaFile);
  if (!fs.existsSync(schemaPath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
}

function validateMessageAgainstSchema(message, schema) {
  const errors = [];

  if (!schema || !schema.properties) return [{ error: 'Invalid or missing schema' }];

  if (schema.required) {
    for (let i = 0; i < schema.required.length; i++) {
      const field = schema.required[i];
      if (!(field in message)) {
        errors.push({ field: field, error: 'required field missing' });
      }
    }
  }

  const propKeys = Object.keys(schema.properties);
  for (let i = 0; i < propKeys.length; i++) {
    const field = propKeys[i];
    const rules = schema.properties[field];
    if (!(field in message)) continue;

    if (rules.enum && !rules.enum.includes(message[field])) {
      errors.push({ field: field, value: message[field], error: 'value not in enum: ' + rules.enum.join(',') });
    }
    if (rules.type === 'string' && rules.format === 'date-time' && isNaN(Date.parse(message[field]))) {
      errors.push({ field: field, value: message[field], error: 'invalid ISO-8601 date-time' });
    }
    if (rules.minLength && typeof message[field] === 'string' && message[field].length < rules.minLength) {
      errors.push({ field: field, error: 'minLength ' + rules.minLength + ' not met' });
    }
    if (rules.pattern && typeof message[field] === 'string' && !new RegExp(rules.pattern).test(message[field])) {
      errors.push({ field: field, value: message[field], error: 'pattern ' + rules.pattern + ' not matched' });
    }
  }

  if (schema.allOf) {
    for (let i = 0; i < schema.allOf.length; i++) {
      const condition = schema.allOf[i];
      if (condition.if && condition.then) {
        const ifField = Object.keys(condition.if.properties)[0];
        const ifValues = condition.if.properties[ifField] ? condition.if.properties[ifField].enum : null;
        if (ifField in message && ifValues && ifValues.includes(message[ifField])) {
          if (condition.then.required) {
            for (let j = 0; j < condition.then.required.length; j++) {
              const reqField = condition.then.required[j];
              if (!(reqField in message)) {
                errors.push({ field: reqField, error: 'conditionally required when ' + ifField + '=' + message[ifField] });
              }
            }
          }
        }
      }
    }
  }

  return errors;
}

function scanMessageDir(dirPath, schema, label) {
  const violations = [];
  if (!fs.existsSync(dirPath)) return violations;

  const SKIP_DIRS = new Set(['archive', 'processed', 'quarantine']);
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
    if (entry.isDirectory()) continue;
    if (!entry.name.endsWith('.json')) continue;
    if (entry.name.startsWith('heartbeat-')) continue;
    if (entry.name.startsWith('README')) continue;

    const filePath = path.join(dirPath, entry.name);
    try {
      const msg = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      const errs = validateMessageAgainstSchema(msg, schema);
      for (let j = 0; j < errs.length; j++) {
        violations.push(Object.assign({ file: filePath }, errs[j]));
      }
    } catch (e) {
      violations.push({ file: filePath, error: 'parse error: ' + e.message.substring(0, 100) });
    }
  }
  return violations;
}

function runGate2() {
  const gateResult = { name: 'schema-compliance-check', passed: true, violations: [], scanned: 0 };

  const inboxSchema = loadSchema(INBOX_MESSAGE_SCHEMA);
  if (!inboxSchema) {
    gateResult.passed = false;
    gateResult.violations.push({ error: 'Schema ' + INBOX_MESSAGE_SCHEMA + ' not found in ' + SCHEMA_DIR });
    return gateResult;
  }

  const dirs = [
    { path: path.join(LANE_ROOT, 'lanes', 'kernel', 'inbox'), schema: inboxSchema, label: 'inbox' },
    { path: path.join(LANE_ROOT, 'lanes', 'kernel', 'outbox'), schema: inboxSchema, label: 'outbox' }
  ];

  let totalScanned = 0;
  for (let i = 0; i < dirs.length; i++) {
    const dir = dirs[i];
    const violations = scanMessageDir(dir.path, dir.schema, dir.label);
    totalScanned += (violations.length === 0 ? 1 : 0);
    if (violations.length > 0) {
      gateResult.passed = false;
      for (let j = 0; j < violations.length; j++) {
        gateResult.violations.push(violations[j]);
      }
    }
  }

  gateResult.scanned = totalScanned;
  return gateResult;
}

if (gateValue === '1' || gateValue === null) {
  results.gate1 = runGate1();
  if (!results.gate1.passed) {
    results.passed = false;
    for (let i = 0; i < results.gate1.violations.length; i++) {
      results.violations.push(results.gate1.violations[i]);
    }
  }
}

if (gateValue === '2' || gateValue === null) {
  results.gate2 = runGate2();
  if (!results.gate2.passed) {
    results.passed = false;
    for (let i = 0; i < results.gate2.violations.length; i++) {
      results.violations.push(results.gate2.violations[i]);
    }
  }
}

if (jsonOutput) {
  console.log(JSON.stringify(results, null, 2));
} else {
  console.log('=== CI/CD Sovereignty Gates - Phase 1 ===');
  console.log('Lane: ' + LANE_NAME);
  console.log('');

  if (results.gate1) {
    console.log('Gate 1 (' + results.gate1.name + '): ' + (results.gate1.passed ? 'PASS' : 'FAIL'));
    if (!results.gate1.passed) {
      for (let i = 0; i < results.gate1.violations.length; i++) {
        const v = results.gate1.violations[i];
        console.log('  - ' + (v.file || v.error) + ': ' + (v.error || v.stderr || 'violation'));
      }
    }
  }

  if (results.gate2) {
    console.log('Gate 2 (' + results.gate2.name + '): ' + (results.gate2.passed ? 'PASS' : 'FAIL'));
    if (!results.gate2.passed) {
      for (let i = 0; i < results.gate2.violations.length; i++) {
        const v = results.gate2.violations[i];
        console.log('  - ' + v.file + ': ' + v.error + (v.field ? ' (field: ' + v.field + ')' : '') + (v.value ? ' value=' + v.value : ''));
      }
    }
  }

  console.log('');
  console.log('Overall: ' + (results.passed ? 'PASS' : 'FAIL'));
}

if (strict && !results.passed) {
  exitCode = 1;
}

process.exit(exitCode);