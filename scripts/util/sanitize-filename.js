#!/usr/bin/env node
'use strict';

function sanitizeFilename(name) {
  return name
    .replace(/(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/g, '$1$2$3T$4$5$6')
    .replace(/:/g, '-')
    .replace(/[<>|?*"\\]/g, '_');
}

module.exports = { sanitizeFilename };
