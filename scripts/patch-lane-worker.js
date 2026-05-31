const fs = require('fs');
const path = require('path');

const filePath = '/home/we4free/agent/repos/kernel-lane/scripts/lane-worker.js';
let content = fs.readFileSync(filePath, 'utf8');
let lines = content.split('\n');

let insertLogEventBeforeLine = -1;
let insertLogEventCallAfterLine = -1;

for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes('processFile(filePath) {')) {
    insertLogEventBeforeLine = i;
  }
  if (lines[i].includes('let msg = rawRead.value;')) {
    insertLogEventCallAfterLine = i;
  }
}

if (insertLogEventBeforeLine === -1) {
  console.error('Could not find processFile method start');
  process.exit(1);
}
if (insertLogEventCallAfterLine === -1) {
  console.error('Could not find let msg = rawRead.value; line');
  process.exit(1);
}

const methodLines = [
  '',
  '  logEvent(event) {',
  '    try {',
  '      const laneRoot = path.resolve(this.config.queues.inbox, \'..\', \'..\', \'..\');',
  '      const logDir = path.join(laneRoot, \'lanes\', this.lane, \'state\');',
  '      if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });',
  '      const logFile = path.join(logDir, \'events.log\');',
  '      const entry = {',
  '        timestamp: nowIso(),',
  '        lane: this.lane,',
  '        event,',
  '      };',
  '      fs.appendFileSync(logFile, JSON.stringify(entry) + \'\\n\', \'utf8\');',
  '    } catch (err) {',
  '      process.stderr.write(`[lane-worker] Event logging failed: ${err.message}\\n`);',
  '    }',
  '  }',
];

lines.splice(insertLogEventBeforeLine, 0, ...methodLines);

const shiftedInsertLine = insertLogEventCallAfterLine + methodLines.length;
lines.splice(shiftedInsertLine + 1, 0, '    this.logEvent(msg);');

fs.writeFileSync(filePath, lines.join('\n'), 'utf8');
console.log('Successfully patched lane-worker.js');
