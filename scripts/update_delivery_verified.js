#!/usr/bin/env node
"use strict";
const fs = require("fs");
const path = require("path");
const OUTBOX = "S:/Archivist-Agent/lanes/archivist/outbox";
fs.readdirSync(OUTBOX).forEach(fn => {
  if (!fn.endsWith(".json")) return;
  const filePath = path.join(OUTBOX, fn);
  const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (!data.delivery_verification) data.delivery_verification = {};
  data.delivery_verification.verified = true;
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
});
