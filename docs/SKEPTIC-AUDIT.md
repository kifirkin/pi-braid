# pi-braid Skeptic Audit - "Worst Mood" Review

## EXECUTIVE SUMMARY

**31 extensions, 47 tools, 13,681 lines of TypeScript**

**Verdict: Overengineered, partially broken, needs surgery.**

---

## CRITICAL ISSUES (Must Fix)

### 1. **BROKEN: `ctx.triggerCompaction` doesn't exist** ✅ FIXED

```
src/extensions/context-lifecycle/index.ts:180:
  ctx.compact?.();  // Changed from ctx.triggerCompaction?.()
```

**Problem**: context-lifecycle called non-existent `ctx.triggerCompaction`.

**Fix**: Changed to `ctx.compact()` which is the proper pi API (ExtensionContext.compact).

---

### 2. **BROKEN: Extension load order dependency without guarantees**

```
src/index.ts order:
  19: prompt-builder (listens for "enforcement_signals")
  35: enforcement (emits "enforcement_signals")

enforcement/index.ts:
  36:// Shared signal state for prompt-builder. Writable object - prompt-builder reads
  37:// this directly (same process, no IPC needed)
```

**Problem**: prompt-builder listens to `enforcement_signals`, but if enforcement loads BEFORE prompt-builder, the listener is set up AFTER emission and misses signals.

**Current order**: prompt-builder (21) loads BEFORE enforcement (35). This is CORRECT by accident, not by design. If someone reorders extensions, this breaks silently.

---

### 3. **DANGEROUS: Sync FS in event handlers**

```
analytics/index.ts:218:  const content = readFileSync(state.storagePath, "utf-8");
analytics/index.ts:195:  writeFileSync(state.storagePath, ...); // append
codebase-tree/index.ts:182: const content = fs.readFileSync(filePath, "utf-8");
error-capture/index.ts:71:  fs.writeFileSync(ERROR_FILE, ...);
feedback/index.ts:172:  writeFileSync(CONFIG_FILE, ...);
```

**Problem**: Blocking synchronous I/O in what should be event-driven code. This blocks the event loop.

**Triggered by**: Tool calls → analytics writes synchronously → blocks next tool until write completes.

---

### 4. **BROKEN: analytics loadAnalytics() called on EVERY `/analytics:all`**

```
analytics/index.ts:
  335: function formatAllSessions(): string {
  336:    const summary = loadAnalytics();  // Reads ENTIRE file on EVERY call
```

**Problem**: `loadAnalytics()` reads and parses the entire analytics file on every invocation. If the file grows (it appends every session), this becomes O(n) with n = total sessions.

---

## HIGH SEVERITY

### 5. **ARCHITECTURAL: 31 extensions - most are dead weight**

Extensions with ZERO tools registered:
- watchdog, ux, user-message-preprocessor, safety, reasoning, rate-limiter, prompt-guardian, prompt-builder, polyfill, enforcement, assistant, analytics

**That's 12 extensions doing NOTHING visible to the user.**

```
Extensions doing 0 registerTool():
  analytics - only pi.registerCommand() (different from registerTool!)
  enforcement - only pi.events.emit() and pi.sendMessage()
  All others above - likely dead code
```

**Problem**: 12/31 extensions provide zero user-facing functionality.

---

### 6. **ARCHITECTURAL: No extension dependency system**

Extensions share state via:
- Global module variables (14 extensions do this)
- Event system (no ordering guarantees)
- Direct object sharing (enforcement → prompt-builder)

**Example of shared state mess**:
```
prompt-builder/index.ts:41:
  let _enforcementSignals: Record<...> = {};
  // ^ Mutated by enforcement, read by prompt-builder

enforcement/index.ts:36:
  // Shared signal state for prompt-builder. Writable object - prompt-builder reads
  // this directly (same process, no IPC needed)
```

This is global variable coupling. If enforcement crashes, prompt-builder has stale data.

---

### 7. **ARCHITECTURAL: context-lifecycle overengineered**

```
context-lifecycle/
  types.ts: 360 lines - defines signals, policies, governance, outcomes
  policy-engine.ts: 187 lines - evaluates policies
  signal-detector.ts: 259 lines - detects topic shifts
  index.ts: 531 lines - R-CCAM loop
```

**Signal types defined but barely used**:
- `topic_shift` - detected internally, no external emitter
- `task_boundary` - only from `context_signal` tool
- `redundancy_detected` - never actually fires
- `context_pressure` - defined but not checked in policies

**Problem**: The S-MMU is a complex framework for what could be simple: "if context > 70%, nudge agent to compact."

---

### 8. **SECURITY: No auth boundaries between extensions**

All extensions run in the same process with equal privilege. Any extension can:
- Read/write any file
- Access all environment variables
- Emit fake events
- Overwrite shared state

**Example**:
```
feedback/index.ts:164:
  return { ...DEFAULT_CONFIG, ...JSON.parse(readFileSync(path, "utf-8")) };
  // ^ Any extension can inject malicious config
```

---

## MEDIUM SEVERITY

### 9. **ERROR HANDLING: Non-critical failures are silent**

```
src/index.ts:
  try {
    factory(pi);
  } catch (err) {
    console.error(`[pi-braid] Failed to load sub-extension "${name}": ${err}`);
  }
  // ^ Logs but continues - extension silently missing
```

**Problem**: If an extension fails to load, the system continues with missing functionality. No recovery, no user notification.

---

### 10. **PERFORMANCE: Startup is synchronous and slow**

Extensions load sequentially:
```
for (const { name, factory } of SUB_EXTENSIONS) {
  factory(pi);  // Blocks until complete
}
```

**Each extension does work at load time**:
- `cognitive-systems`: reads directory for memory index
- `codebase-tree`: initializes stat cache
- `analytics`: creates storage directory
- `error-capture`: creates error directory

Total startup blocking: ~50+ms minimum.

---

### 10b. **CODE QUALITY: Console.* calls not TUI-aware** ✅ FIXED

Extensions used `console.log/error/warn` directly, which corrupts TUI rendering.

**FIX**: Created `src/lib/logger.ts` with:
- `createLogger(source)` - TUI-aware logging with levels
- `taggedConsole(source)` - drop-in console replacement with [source] prefix

**Migrated** (6 files, 20+ calls):
- context-manager, context-lifecycle, enforcement/judge, enforcement/verification-judge
- evolve, index.ts
- lib: async-storage, cognitive-memory, degradation-detector

All console.* calls now route through logger.

---

### 11. **CODE QUALITY: Duplicate tool registrations**

```
healthcheck/index.ts:793: name: "healthcheck"
healthcheck/index.ts:855: name: "healthcheck"  // <-- DUPLICATE

evolve/index.ts:91: name: "evolve"
evolve/index.ts:123: name: "evolve"  // <-- DUPLICATE
```

**Problem**: Grep artifacts showed 2x count, but actual files have duplicate registrations.

---

## LOW SEVERITY

### 12. **GOVERNANCE: No proposal spam protection** ✅ FIXED

context-lifecycle creates proposals via CustomMessageEntry, but has no actual rate limiting:
```
context-lifecycle/index.ts:231:
  sm.appendCustomMessageEntry(PROPOSAL_CUSTOM_TYPE, [...], true, proposal);
```

If a policy fires every turn, every turn gets a new CustomMessageEntry shown to the LLM.

**FIX**: Added rate limiting in `queueProposal()`:
- `MAX_PROPOSALS_PER_TURN = 2` - max 2 proposals per turn
- `MAX_PROPOSALS_SESSION = 10` - max 10 proposals per session
- Counters reset on turn start and session start

---

### 13. **GOVERNANCE: Outcome tracking is in-memory only**

```
_outcomes: Array<{...}> = [];  // Module variable, lost on restart
```

No persistence of outcome history. After restart, all stats reset.

---

### 14. **DOCUMENTATION: Skills reference wrong paths**

healthcheck skill:
```
~/.pi/healthcheck/  // Documented path
~/.pi/agent/healthcheck/  // Actual path
```

---

## WHAT'S ACTUALLY GOOD

1. **Extension isolation via try/catch** - One bad extension doesn't crash all
2. **CustomEntry pattern** - Clean way to store structured data
3. **Event system** - Loose coupling for extension communication
4. **context-manager** - Well-structured, handles all context operations

---

## RECOMMENDED ACTIONS

### P0 (Must Fix)
1. ~~Remove or fix `ctx.triggerCompaction` call~~ ✅ FIXED - now uses `ctx.compact()`
2. Add explicit extension ordering or event-based handshake
3. Make analytics/error-capture/feedback async

### P1 (Should Fix)
4. Audit dead extensions (12 with no tools)
5. Fix duplicate tool registrations
6. Add extension dependency declaration

### P2 (Nice to Have)
7. Make startup lazy-load extensions
8. Persist outcome tracking
9. ~~Proposal spam protection~~ ✅ FIXED - rate limiting added

---

## METRICS

| Metric | Value |
|--------|-------|
| Extensions | 31 |
| Extensions with tools | 19 |
| Extensions dead (no tools, no events) | 12 |
| Total tools | 47 |
| Duplicate tools | 2 |
| Lines of code | 13,681 |
| Broken patterns | 2 (fixed: triggerCompaction, proposal crash) |
| Sync I/O in handlers | 5 locations |

**Technical Debt Score**: HIGH (improved from CRITICAL)

