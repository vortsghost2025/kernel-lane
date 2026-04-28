# Phase 1 Remediation Playbook - Archivist Lane

## Critical Security Issues - Immediate Action Required

### Overview
This playbook provides step-by-step remediation procedures for Archivist lane Phase 1 critical security vulnerabilities identified in system code review.

**Priority:** P0 - Production Blocker  
**Target Completion:** Within 48 hours  
**Owner:** Archivist Lane  
**Authority:** 100 (Governance Root)

---

## 1. TAURI COMMAND INJECTION VULNERABILITY (CRITICAL)

**Severity:** CRITICAL  
**CVSS Score:** 9.8 (Critical)  
**Location:** `ui/app.js` (lines 158-250)

### Issue Description
User-controlled strings are passed directly to Tauri `invoke()` commands without sanitization, allowing potential command injection attacks.

### Remediation Steps

#### Step 1: Implement Command Allowlist
Create `src-tauri/conf/tauri.conf.json` with strict command allowlist:

```json
{
  "tauri": {
    "security": {
      "csp": "default-src 'self'",
      "dangerousRemoteResourceIpc": false
    },
    "allowlist": {
      "all": false,
      "shell": {
        "all": false,
        "execute": false,
        "sidecar": false
      },
      "fs": {
        "all": false,
        "readFile": true,
        "writeFile": false,
        "readDir": true,
        "copyFile": false,
        "createDir": false
      }
    }
  }
}
```

#### Step 2: Input Validation Layer
Create `src/validation/commandValidator.js`:

```javascript
const ALLOWED_COMMANDS = new Set([
  'list_directory',
  'read_file',
  'scan_folder'
]);

const ALLOWED_PATHS = [
  '/scanned/folders/',
  '/output/'
];

export function validateCommand(command, args) {
  // Command whitelist check
  if (!ALLOWED_COMMANDS.has(command)) {
    throw new Error(`Command not allowed: ${command}`);
  }
  
  // Argument sanitization
  const sanitizedArgs = args.map(arg => {
    if (typeof arg !== 'string') return arg;
    
    // Remove shell metacharacters
    return arg.replace(/[&|;`$><*?\\[\]{}()^~!]/g, '');
  });
  
  return { command, args: sanitizedArgs };
}

export function validatePath(path) {
  // Path traversal check
  if (path.includes('..') || path.includes('//')) {
    throw new Error('Path traversal detected');
  }
  
  // Allowed path prefix check
  const isAllowed = ALLOWED_PATHS.some(allowed => 
    path.startsWith(allowed)
  );
  
  if (!isAllowed) {
    throw new Error('Path not in allowed directories');
  }
  
  return path;
}
```

#### Step 3: Update Tauri Invocation Points
In `src/ui/app.js`, wrap all `invoke()` calls:

```javascript
import { validateCommand, validatePath } from '../validation/commandValidator';

// BEFORE (VULNERABLE):
// const result = await invoke('list_directory', { path: userInput });

// AFTER (SECURE):
try {
  const validatedPath = validatePath(userInput);
  const { command, args } = validateCommand('list_directory', [validatedPath]);
  const result = await invoke(command, { path: args[0] });
} catch (error) {
  console.error('Command validation failed:', error.message);
  // Show user-friendly error
}
```

### Verification
```bash
# Test with malicious input
node test/command-injection-test.js
# Should block all injection attempts
```

---

## 2. CSP BYPASS VIA TAURI INVOKE (HIGH)

**Severity:** HIGH  
**CVSS Score:** 7.5 (High)

### Issue Description
Tauri bridge bypasses Content-Security-Policy, allowing arbitrary command execution.

### Remediation Steps

#### Step 1: Strengthen CSP Header
Update `tauri.conf.json`:

```json
{
  "tauri": {
    "security": {
      "csp": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'"
    }
  }
}
```

#### Step 2: Add Pre-Invoke Security Check
Create `src/security/invokeGuard.js`:

```javascript
export function securityPreCheck(operation) {
  const context = window.__SECURITY_CONTEXT__;
  
  // Check if operation is allowed in current state
  if (!context.isAuthenticated && operation.requiresAuth) {
    throw new Error('Authentication required');
  }
  
  // Rate limiting
  if (context.invokeCount > 10) {
    throw new Error('Rate limit exceeded');
  }
  
  context.invokeCount++;
  return true;
}
```

### Verification
```bash
# CSP audit
npm run audit:csp
```

---

## 3. UNSANITIZED WINDOW TITLE (MEDIUM)

**Severity:** MEDIUM  
**CVSS Score:** 5.3 (Medium)

### Issue Description
Window title set from unsanitized user input in Rust backend.

### Remediation Steps

#### Step 1: Sanitize in Rust Backend
Update `src-tauri/src/lib.rs`:

```rust
use regex::Regex;

fn sanitize_window_title(title: &str) -> String {
    // Remove control characters
    let re = Regex::new(r"[\x00-\x1F\x7F]").unwrap();
    let sanitized = re.replace_all(title, "");
    
    // Limit length
    sanitized.chars().take(255).collect()
}

#[tauri::command]
fn set_window_title(title: String) -> Result<(), String> {
    let safe_title = sanitize_window_title(&title);
    
    tauri::Manager::current_window()
        .set_title(&safe_title)
        .map_err(|e| e.to_string())?;
    
    Ok(())
}
```

#### Step 2: Update Frontend
```javascript
// Sanitize before sending
const safeTitle = DOMPurify.sanitize(userInput);
await invoke('set_window_title', { title: safeTitle });
```

---

## 4. PATH TRAVERSAL IN TRUST STORE (HIGH)

**Severity:** HIGH  
**CVSS Score:** 7.5 (High)

### Issue Description
Trust store path constructed without proper validation.

### Remediation Steps

#### Step 1: Use Canonical Paths
Update `src/lib/trustStore.js`:

```javascript
import { LaneDiscovery } from 'S:/Archivist-Agent/.global/lane-discovery.js';

const discovery = new LaneDiscovery();

export function getTrustStorePath(laneId) {
  // Use canonical path from registry
  return discovery.getBroadcastPath() + '/trust-store.json';
}

export function validateTrustStorePath(path) {
  const canonical = getTrustStorePath();
  
  // Must match exactly
  if (path !== canonical) {
    throw new Error('Invalid trust store path');
  }
  
  return true;
}
```

---

## 5. RACE CONDITIONS IN INBOX WATCHER (MEDIUM)

**Severity:** MEDIUM  
**CVSS Score:** 4.3 (Medium)

### Issue Description
TOCTOU (Time-of-Check-Time-of-Use) vulnerability in inbox watcher.

### Remediation Steps

#### Step 1: Implement File Handle Locking
```javascript
import { lockFile, unlockFile } from './fileLock';

async function processMessageSafely(filePath) {
  const lock = await lockFile(filePath + '.lock');
  
  try {
    // Re-validate after acquiring lock
    if (!fs.existsSync(filePath)) {
      return;
    }
    
    const content = fs.readFileSync(filePath, 'utf8');
    // Process safely
  } finally {
    unlockFile(lock);
  }
}
```

---

## IMPLEMENTATION TIMELINE

| Day | Task | Owner | Status |
|-----|------|-------|--------|
| Day 1 | Command allowlist | Security | 📋 |
| Day 1 | Input validation | Frontend | 📋 |
| Day 2 | CSP hardening | Backend | 📋 |
| Day 2 | Window sanitization | Backend | 📋 |
| Day 3 | Trust store fixes | Infrastructure | 📋 |
| Day 3 | Race condition fixes | Backend | 📋 |
| Day 4 | Testing | QA | 📋 |
| Day 5 | Review | All | 📋 |

---

## TESTING REQUIREMENTS

1. **Command Injection Tests**
   - Malicious input blocking
   - Boundary testing
   - Fuzzing tests

2. **CSP Verification**
   - Header validation
   - Bypass attempt tests

3. **Path Traversal Tests**
   - `../` attempts
   - Unicode tricks
   - Case sensitivity

4. **Race Condition Tests**
   - Concurrent file access
   - Lock contention

---

## VERIFICATION CHECKLIST

- [ ] Command allowlist implemented
- [ ] All invoke() calls validated
- [ ] CSP header strengthened
- [ ] Window title sanitized
- [ ] Trust store paths canonicalized
- [ ] Race conditions eliminated
- [ ] All tests passing
- [ ] Security audit completed
- [ ] Penetration test passed

---

## ESCALATION

If remediation cannot complete in time:
1. Notify Archivist immediately
2. Escalate to Governance level
3. Consider temporary shutdown
4. Document all issues

**Contact:** Governance Root (Authority 100)  
**Emergency:** `#security-emergency`

---

*Document Version: 1.0*  
*Created: 2026-04-28*  
*Status: Active*
