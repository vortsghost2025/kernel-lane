#!/usr/bin/env node
'use strict';
const fs = require('fs');
const p = 'S:/Archivist-Agent/schemas/inbox-message-v1.json';
let s = fs.readFileSync(p, 'utf8');

s = s.replace(
  '"enum": [ "manual", "session_task", "watcher" ]',
  '"enum": [ "manual", "session_task", "watcher", "auto", "pipeline" ]'
);
s = s.replace(
  '"enum": [ "kilo", "opencode", "other" ]',
  '"enum": [ "kilo", "opencode", "other", "pipeline" ]'
);
s = s.replace(
  '"enum": [ "lane", "subagent", "watcher" ]',
  '"enum": [ "lane", "subagent", "watcher", "task-executor" ]'
);

fs.writeFileSync(p, s, 'utf8');
const schema = JSON.parse(s);
const exec = schema.properties.execution.properties;
console.log('mode:', exec.mode.enum);
console.log('engine:', exec.engine.enum);
console.log('actor:', exec.actor.enum);
