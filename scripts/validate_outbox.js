#!/usr/bin/env node
"use strict";
const fs = require("fs");
const path = require("path");
const OUTBOX = "S:/Archivist-Agent/lanes/archivist/outbox";
let bad = [];
fs.readdirSync(OUTBOX).forEach(fn => {
  if (!fn.endsWith(.json)) return;
  const filePath = path.join(OUTBOX, fn);
  try {
    JSON.parse(fs.readFileSync(filePath, utf8));
  } catch (e) {
    bad.push({file: fn, error: e.message});
  }
});
if (bad.length===0) {
  console.log(All
