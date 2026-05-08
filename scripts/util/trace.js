'use strict';

const crypto = require('crypto');

function newTrace() {
  return {
    trace_id: crypto.randomUUID(),
    run_id: crypto.randomUUID(),
    timestamp_start: new Date().toISOString(),
    tool_calls: [],
    constraint_evals: [],
    decision_path: [],
    checkpoints: []
  };
}

function addToolCall(trace, tool, args, response, status) {
  trace.tool_calls.push({
    tool_call_id: crypto.randomUUID(),
    tool,
    args: args || null,
    response: response || null,
    status: status || 'unknown',
    ts: new Date().toISOString()
  });
}

function addDecision(trace, decision) {
  trace.decision_path.push({ ts: new Date().toISOString(), ...decision });
}

function checkpoint(trace, name, stateObj) {
  const hash = crypto.createHash('sha256')
    .update(JSON.stringify(stateObj))
    .digest('hex');
  trace.checkpoints.push({ name, ts: new Date().toISOString(), state_hash: hash });
  return hash;
}

function addConstraintEval(trace, evalResult) {
  trace.constraint_evals.push(evalResult);
}

function finalizeTrace(trace) {
  trace.timestamp_end = new Date().toISOString();
  trace.duration_ms = Date.now() - new Date(trace.timestamp_start).getTime();
  return trace;
}

function writeTrace(trace, dir) {
  const fs = require('fs');
  const path = require('path');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `trace-${trace.trace_id}.json`);
  fs.writeFileSync(file, JSON.stringify(trace, null, 2), 'utf8');
  return file;
}

module.exports = { newTrace, addToolCall, addDecision, checkpoint, addConstraintEval, finalizeTrace, writeTrace };
