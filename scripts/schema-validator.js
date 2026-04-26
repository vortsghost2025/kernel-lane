#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const SCHEMAS_DIR = path.join(__dirname, '..', 'schemas');
const GOVERNANCE_DIR = path.join(__dirname, '..');

function loadSchema(name) {
  const p = path.join(SCHEMAS_DIR, name);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function validateField(value, schema) {
  if (!schema) return { valid: true };
  
  if (schema.type === 'string' && schema.enum) {
    if (!schema.enum.includes(value)) {
      return { valid: false, error: `Value "${value}" not in enum: ${schema.enum.join(', ')}` };
    }
  }
  
  if (schema.type === 'boolean' && schema.const !== undefined) {
    if (value !== schema.const) {
      return { valid: false, error: `Value must be ${schema.const}, got ${value}` };
    }
  }
  
  if (schema.type === 'integer') {
    if (!Number.isInteger(value)) return { valid: false, error: 'Not an integer' };
    if (schema.minimum !== undefined && value < schema.minimum) return { valid: false, error: `Below minimum ${schema.minimum}` };
    if (schema.maximum !== undefined && value > schema.maximum) return { valid: false, error: `Above maximum ${schema.maximum}` };
  }
  
  return { valid: true };
}

function validateUserInputGate(input) {
  const schema = loadSchema('user-input-gate-v1.json');
  if (!schema) return { valid: false, error: 'user-input-gate-v1.json schema not found' };
  
  const errors = [];
  const required = schema.required || [];
  
  for (const field of required) {
    if (!(field in input)) {
      errors.push(`Missing required field: ${field}`);
    }
  }
  
  if (errors.length > 0) return { valid: false, errors };
  
  const props = schema.properties || {};
  
  if (input.input_type) {
    const r = validateField(input.input_type, props.input_type);
    if (!r.valid) errors.push(`input_type: ${r.error}`);
  }
  
  if (input.gate_decision) {
    const r = validateField(input.gate_decision, props.gate_decision);
    if (!r.valid) errors.push(`gate_decision: ${r.error}`);
  }
  
  if (input.verification_status && input.verification_status.status) {
    const statusProp = props.verification_status.properties.status;
    const r = validateField(input.verification_status.status, statusProp);
    if (!r.valid) errors.push(`verification_status.status: ${r.error}`);
  }
  
  if (input.quarantine_check) {
    const qcProps = props.quarantine_check.properties;
    if (input.quarantine_check.quarantine_can_self_unblock !== undefined) {
      const r = validateField(input.quarantine_check.quarantine_can_self_unblock, qcProps.quarantine_can_self_unblock);
      if (!r.valid) errors.push(`quarantine_can_self_unblock: ${r.error} — USER CANNOT SELF-UNBLOCK`);
    }
    if (input.quarantine_check.uds_score !== undefined) {
      const r = validateField(input.quarantine_check.uds_score, qcProps.uds_score);
      if (!r.valid) errors.push(`uds_score: ${r.error}`);
    }
  }
  
  return errors.length > 0 ? { valid: false, errors } : { valid: true };
}

function validateUserQuarantine(state) {
  const schema = loadSchema('user-quarantine-v1.json');
  if (!schema) return { valid: false, error: 'user-quarantine-v1.json schema not found' };
  
  const errors = [];
  const required = schema.required || [];
  
  for (const field of required) {
    if (!(field in state)) {
      errors.push(`Missing required field: ${field}`);
    }
  }
  
  if (errors.length > 0) return { valid: false, errors };
  
  const props = schema.properties || {};
  
  if (state.status) {
    const r = validateField(state.status, props.status);
    if (!r.valid) errors.push(`status: ${r.error}`);
  }
  
  if (state.uds_score !== undefined) {
    const r = validateField(state.uds_score, props.uds_score);
    if (!r.valid) errors.push(`uds_score: ${r.error}`);
  }
  
  if (state.trigger_signals) {
    for (const sig of state.trigger_signals) {
      const r = validateField(sig, props.trigger_signals.items);
      if (!r.valid) errors.push(`trigger_signal "${sig}": ${r.error}`);
    }
  }
  
  return errors.length > 0 ? { valid: false, errors } : { valid: true };
}

function validateConvergenceGate(output) {
  const required = ['claim', 'evidence', 'verified_by', 'status'];
  const errors = [];
  
  for (const field of required) {
    if (!(field in output)) {
      errors.push(`Missing required field: ${field}`);
    }
  }
  
  const validStatuses = ['proven', 'unproven', 'conflicted', 'blocked'];
  if (output.status && !validStatuses.includes(output.status)) {
    errors.push(`Invalid status: ${output.status}. Must be: ${validStatuses.join(', ')}`);
  }
  
  const validVerifiers = ['archivist', 'library', 'swarmmind', 'codex', 'self', 'user'];
  if (output.verified_by && !validVerifiers.includes(output.verified_by)) {
    errors.push(`Invalid verified_by: ${output.verified_by}. Must be: ${validVerifiers.join(', ')}`);
  }
  
  if (output.verified_by === 'user' && output.status === 'proven') {
    errors.push('verified_by "user" with status "proven" is NOT allowed — user verification requires lane convergence (RECIPROCAL_ACCOUNTABILITY.md:3)');
  }
  
  return errors.length > 0 ? { valid: false, errors } : { valid: true };
}

function evaluateUserInput(text, sessionId) {
  const bypassPatterns = [
    { signal: 'SKIP_VERIFICATION', patterns: [/skip verif/i, /don'?t check/i, /no need to verif/i] },
    { signal: 'JUST_DO_IT', patterns: [/just do it/i, /just run it/i, /just push/i, /just commit/i] },
    { signal: 'NO_TIME', patterns: [/no time/i, /don'?t have time/i, /we'?re out of time/i, /hurry/i] },
    { signal: 'TRUST_ME', patterns: [/trust me/i, /i know/i, /believe me/i] },
    { signal: 'OVERRIDE', patterns: [/override/i, /bypass/i, /ignore the/i, /skip the check/i] },
    { signal: 'DONT_CHECK', patterns: [/don'?t check/i, /skip the gate/i, /skip checkpoint/i] },
    { signal: 'WE_DONT_NEED', patterns: [/we don'?t need/i, /not necessary/i, /unnecessary/i] },
    { signal: 'BYPASS_GOVERNANCE', patterns: [/skip governance/i, /bypass governance/i, /ignore governance/i] }
  ];
  
  const detected = [];
  for (const bp of bypassPatterns) {
    for (const pattern of bp.patterns) {
      if (pattern.test(text)) {
        detected.push({ signal: bp.signal, detected: true, context: text.slice(0, 80) });
        break;
      }
    }
  }
  
  return detected;
}

function gateDecision(bypassSignals, udsScore, isStateChanging, isQuarantined) {
  if (isQuarantined) return 'SESSION_FREEZE';
  if (udsScore > 60) return 'HARD_STOP';
  if (bypassSignals.length > 0 && isStateChanging) return 'HARD_STOP';
  if (udsScore > 40 && isStateChanging) return 'QUEUE_FOR_CONVERGENCE';
  if (isStateChanging && udsScore <= 40) return 'QUEUE_FOR_CONVERGENCE';
  return 'PASS';
}

module.exports = {
  validateUserInputGate,
  validateUserQuarantine,
  validateConvergenceGate,
  evaluateUserInput,
  gateDecision,
  loadSchema
};

if (require.main === module) {
  const args = process.argv.slice(2);
  const command = args[0];
  
  if (command === 'check-input') {
    const text = args.slice(1).join(' ');
    const signals = evaluateUserInput(text, 'cli');
    console.log(JSON.stringify({ bypass_signals: signals, count: signals.length }, null, 2));
    if (signals.length > 0) {
      console.error('\n⚠️  BYPASS SIGNALS DETECTED — User input flagged for verification');
      process.exit(1);
    }
  } else if (command === 'validate-quarantine') {
    const input = JSON.parse(args[1] || '{}');
    const result = validateUserQuarantine(input);
    console.log(JSON.stringify(result, null, 2));
    if (!result.valid) process.exit(1);
  } else if (command === 'validate-convergence') {
    const input = JSON.parse(args[1] || '{}');
    const result = validateConvergenceGate(input);
    console.log(JSON.stringify(result, null, 2));
    if (!result.valid) process.exit(1);
  } else {
    console.log('Usage:');
    console.log('  node schema-validator.js check-input "user text here"');
    console.log('  node schema-validator.js validate-quarantine \'{"json":"here"}\'');
    console.log('  node schema-validator.js validate-convergence \'{"json":"here"}\'');
  }
}
