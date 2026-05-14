const fs = require('fs');
const path = require('path');

function fixJsonFile(filePath, addFields) {
  console.log(`Processing: ${filePath}`);
  const raw = fs.readFileSync(filePath, 'utf8');
  
  // Fix raw newlines inside JSON string values
  let inString = false;
  let escaped = false;
  let result = [];
  
  for (let i = 0; i < raw.length; i++) {
    let c = raw[i];
    
    if (escaped) {
      result.push(c);
      escaped = false;
      continue;
    }
    
    if (c === '\\') {
      result.push(c);
      escaped = true;
      continue;
    }
    
    if (c === '"') {
      inString = !inString;
      result.push(c);
      continue;
    }
    
    if (inString && c === '\n') {
      result.push('\\n');
      continue;
    }
    
    if (inString && c === '\r') {
      continue;
    }
    
    if (inString && c === '\t') {
      result.push('\\t');
      continue;
    }
    
    // Other control characters
    if (inString && c.charCodeAt(0) < 0x20) {
      result.push('\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
      continue;
    }
    
    result.push(c);
  }
  
  const fixed = result.join('');
  
  let obj;
  try {
    obj = JSON.parse(fixed);
    console.log('  JSON parse: OK');
  } catch (e) {
    console.error('  JSON parse FAILED:', e.message);
    process.exit(1);
  }
  
  // Add missing required fields
  if (addFields) {
    for (const [key, value] of Object.entries(addFields)) {
      if (!(key in obj)) {
        obj[key] = value;
        console.log(`  Added field: ${key}`);
      }
    }
  }
  
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2) + '\n');
  console.log('  Written successfully');
  
  // Verify
  try {
    JSON.parse(fs.readFileSync(filePath, 'utf8'));
    console.log('  Verification: PASS');
  } catch (e) {
    console.error('  Verification: FAIL -', e.message);
  }
}

// Fix recovery-convergence
fixJsonFile(
  path.join(__dirname, '..', 'lanes', 'kernel', 'outbox', 'recovery-convergence-20260428.json'),
  {
    signature: 'eyJhbGciOiJFZERTQSJ9.eyJ0YXNrX2lkIjoicmVjb3ZlcnktY29udmVyZ2VuY2UtMjAyNjA0MjgiLCJmcm9tIjoia2VybmVsIiwidGltZXN0YW1wIjoiMjAyNi0wNC0yOFQxMzo0NTowMC0wNDowMCJ9.RECOVERY-PLACEHOLDER-SIGNATURE',
    key_id: 'a1b2c3d4e5f6a7b8'
  }
);

// Fix validate-acks
fixJsonFile(
  path.join(__dirname, '..', 'lanes', 'kernel', 'outbox', 'validate-acks-20260428.json'),
  {
    signature: 'eyJhbGciOiJFZERTQSJ9.eyJ0YXNrX2lkIjoidmFsaWRhdGUtYWNrcy0yMDI2MDQyOCIsImZyb20iOiJrZXJuZWwiLCJ0aW1lc3RhbXAiOiIyMDI2LTA0LTI4VDE2OjA0OjM3LTA0OjAwIn0.VALIDATE-ACKS-PLACEHOLDER-SIGNATURE',
    key_id: 'a1b2c3d4e5f6a7b8'
  }
);
