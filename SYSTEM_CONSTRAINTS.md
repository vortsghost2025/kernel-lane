# SYSTEM CONSTRAINTS: Lane Sovereignty Rules

## Version: 2026-05-02
## Status: MANDATORY
## Purpose: Prevent Cross-Lane Dependency Regression

---

## RULE 0: NO CROSS-LANE CODE IMPORTS

Any lane importing code from another lane is a violation.

Prohibited:
```javascript
const util = require('S:/kernel-lane/scripts/atomic-write-util');
const { x } = require('S:/Archivist-Agent/.global/something');
const lib = require('S:/self-organizing-library/scripts/thing');
```

Required Pattern:
```javascript
const { atomicWrite } = require('./util/atomic-write');
const { messaging } = require('./util/messaging');
const local = require('./local-module');
```

---

## RULE 1: SOVEREIGN TERRITORY

Each lane is a sovereign execution boundary.

Requirements:
- All code executed within a lane MUST be local to that lane
- Shared patterns documented in contracts, never shared code
- Each lane maintains local copies of needed utilities
- Origin tracking required for inspired code

Documentation Standard:
```javascript
/**
 * LOCAL UTILITY: <purpose>
 * ORIGIN: <source if inspired by another lane>
 * LAST SYNC: <date>
 *
 * Note: Maintained locally for lane sovereignty.
 * Cross-lane dependencies prohibited.
 */
```

---

## RULE 2: ABSOLUTE PATH BAN

Hardcoded paths to other lanes are prohibited as code imports.

Prohibited:
```javascript
const ARCHIVIST_PATH = 'S:/Archivist-Agent';
const KERNEL_UTIL = 'S:/kernel-lane/scripts/util.js';
```

Allowed (config/data references only, not code imports):
```javascript
const inboxPath = 'S:/Archivist-Agent/lanes/archivist/inbox';
```

---

## RULE 3: MESSAGE-ONLY INTER-LANE COMMUNICATION

Lanes coordinate exclusively through messages.

Allowed:
- Message passing via inbox/outbox
- Contract-based schemas
- Provenance headers
- Content negotiation through messages

Prohibited:
- Direct filesystem access to other lane code
- Shared code directories
- Require/import of other lane code
- Cross-lane dynamic resolution

---

## RULE 4: UTILITY LOCALIZATION

Every lane maintains its own utility implementations.

Required Directory Structure:
```
<lane-root>/
  scripts/
    util/          <- Local utilities
      atomic-write.js
      messaging.js
      lane-discovery.js
    domain/        <- Lane-specific logic
    tasks/         <- Task implementations
  data/            <- Local state
  contracts/       <- Shared interface definitions
```

---

## RULE 5: CONTRACT-BASED SHARED INTERFACES

Shared patterns formalized as contracts, never code.

Each lane implements contracts independently.
No shared implementation code.
Conformance verified through testing.

---

## RULE 6: REGRESSION PREVENTION

Automated enforcement of sovereignty rules.

Required in Every Lane:

1. Sovereignty Scanner (`scripts/sovereignty-enforcer.js`)
   - Scans for cross-lane violations
   - Blocks commits with violations (--strict mode)
   - Reports to lane operator

2. Pre-Commit Hook
   ```bash
   #!/bin/bash
   node scripts/sovereignty-enforcer.js --strict
   if [ $? -ne 0 ]; then
     echo "Sovereignty violations detected - commit blocked"
     exit 1
   fi
   ```

---

## RULE 7: VIOLATION HANDLING

When violations are discovered:

1. Immediate Quarantine - Flag violating code, prevent execution
2. Local Remediation - Create local implementation, remove cross-lane dependency
3. Verification - Re-scan after fix, confirm sovereignty restored
4. Prevention - Add specific test for this pattern, document in knowledge base

---

## COMPLIANCE CHECKLIST

Before Any Commit:
- [ ] No absolute paths to other lanes in require() calls
- [ ] No require() of other lane code
- [ ] All utilities are local (./util/)
- [ ] Origin tracking present for inspired code
- [ ] Sovereignty scanner passes
- [ ] Tests verify local implementation

---

## CHANGE LOG

| Date | Version | Changes | Author |
|------|---------|---------|--------|
| 2026-05-02 | 1.0 | Initial sovereignty constraints | System Consensus |
| 2026-05-02 | 1.1 | Added emergency procedures | All Lanes |
| 2026-05-02 | 1.2 | Kernel-lane deployment | Kernel |

Last Updated: 2026-05-02T16:40:00-04:00
Next Review: 2026-05-09T09:00:00-04:00
