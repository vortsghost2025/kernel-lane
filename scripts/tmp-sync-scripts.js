const fs = require('fs');
const p = require('path');
const arDir = 'S:/Archivist-Agent/scripts';
const lanes = [
  { name: 'kernel', root: 'S:/kernel-lane' },
  { name: 'library', root: 'S:/self-organizing-library' },
  { name: 'swarmmind', root: 'S:/SwarmMind' }
];

// Get all scripts in Archivist
const arScripts = fs.readdirSync(arDir).filter(f => f.endsWith('.js'));

for (const lane of lanes) {
  const laneScripts = new Set(fs.readdirSync(p.join(lane.root, 'scripts')).filter(f => f.endsWith('.js')));
  let copied = 0;
  for (const script of arScripts) {
    if (!laneScripts.has(script)) {
      const src = p.join(arDir, script);
      const dest = p.join(lane.root, 'scripts', script);
      fs.copyFileSync(src, dest);
      copied++;
    }
  }
  console.log(lane.name + ': copied ' + copied + ' missing scripts');
}
