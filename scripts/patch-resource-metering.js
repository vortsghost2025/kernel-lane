const fs = require('fs');
const path = require('path');

const filePath = '/home/we4free/agent/repos/kernel-lane/scripts/lane-worker.js';
let content = fs.readFileSync(filePath, 'utf8');
let lines = content.split('\n');

// Find the line number of the class closing brace (the `}` before async function sleep)
let insertPos = -1;
for (let i = 0; i < lines.length; i++) {
  if (lines[i].trim() === '}' && i+1 < lines.length && lines[i+1].trim() === '' && i+2 < lines.length && lines[i+2].startsWith('async function sleep(')) {
    insertPos = i;
    break;
  }
}
if (insertPos === -1) {
  console.error('Could not find LaneWorker class closing brace');
  process.exit(1);
}

// Method to add
const methodLines = [
  '  logResourceMetrics() {',
  '    try {',
  '      const metricsDir = path.join(this.repoRoot, \'lanes\', this.lane, \'metrics\');',
  '      if (!fs.existsSync(metricsDir)) fs.mkdirSync(metricsDir, { recursive: true });',
  '      const metricsFile = path.join(metricsDir, \'resource_usage.jsonl\');',
  '      const cpu = process.cpuUsage();',
  '      const mem = process.memoryUsage();',
  '      const entry = {',
  '        timestamp: nowIso(),',
  '        lane: this.lane,',
  '        pid: process.pid,',
  '        cpu: { user: cpu.user, system: cpu.system },',
  '        memory: {',
  '          rss: mem.rss,',
  '          heapTotal: mem.heapTotal,',
  '          heapUsed: mem.heapUsed,',
  '          external: mem.external,',
  '          arrayBuffers: mem.arrayBuffers,',
  '        },',
  '      };',
  '      fs.appendFileSync(metricsFile, JSON.stringify(entry) + \'\\n\', \'utf8\');',
  '    } catch (err) {',
  '      process.stderr.write(`[lane-worker] Resource metrics logging failed: ${err.message}\\n`);',
  '    }',
  '  }',
];
lines.splice(insertPos, 0, ...methodLines);

// After adding method, line numbers increased. Now find the processOnce calls.
// We'll search for lines containing exactly "const summary = worker.processOnce();"
let callOccurrences = [];
for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes('const summary = worker.processOnce();')) {
    callOccurrences.push(i);
  }
}
if (callOccurrences.length < 2) {
  console.error('Expected at least 2 worker.processOnce() calls, found ' + callOccurrences.length);
  process.exit(1);
}

// Insert logging after each occurrence. We need to insert in reverse order to not mess indices.
const insertCalls = callOccurrences.map(idx => idx + 1); // insert after
// We'll sort descending
insertCalls.sort((a, b) => b - a);
for (const pos of insertCalls) {
  lines.splice(pos, 0, '    worker.logResourceMetrics();');
}

fs.writeFileSync(filePath, lines.join('\n'), 'utf8');
console.log('Successfully added resource metering - method and invocations');
