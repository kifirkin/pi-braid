# Context Overflow Investigation
## Root Cause Analysis & Fixes Applied

---

## Architecture Overview

The overflow system has three layers:

### Layer 1: Heartbeat Monitor (NEWLY ADDED)
- Proactive token monitoring via heartbeat policy
- Warns at 70%/80%/90% thresholds
- One whisper per threshold per tick
- Clears warnings when usage drops below 50%
- **Goal**: PREVENT overflow before it happens

### Layer 2: Compaction (reactive)
- `session_before_compact` → injects summarization instructions
- `session_compact` → prunes messages and adds summary
- Triggered by pi runtime's `context` event
- **Goal**: REDUCE context after overflow

### Layer 3: Rotation
- `finalize` triggers session rotation
- Preserves state via three-memory-stores
- Grace period (25 turns) before rotation is enforced
- **Goal**: START FRESH with preserved state

---

## Root Cause: Why Long Sessions Overflow

The system is **reactive, not proactive**:

1. **Compaction only fires AFTER overflow**
   - Pi runtime fires `context` event at some threshold (~90%?)
   - Compaction runs, reduces context by ~40%
   - Agent continues adding messages
   - Context grows back to overflow → repeat

2. **Compaction window shrinks on retry**
   - 1st overflow: keep = 20K tokens
   - 2nd overflow: keep = 20K × 0.6 = 12K tokens
   - 3rd overflow: keep = 7K tokens
   - After 3 retries, window is tiny — agent fills it immediately
   - Overflow → compaction → overflow → compaction → death spiral

3. **No agent self-correction without user intervention**
   - Agent generates messages continuously in autonomous mode
   - No `finalize` or `context_compress` called without explicit instruction
   - Heartbeat warnings tell the agent to compress, but agent must CHOOSE to act
   - In truly autonomous mode, agent may ignore warnings

4. **Module-level retry state (potential issue)**
   - `compactionRetryState` and `overflowRetryState` in `shared.ts`
   - These are module-level singletons (per-process)
   - In single-session (normal case): fine — reset on `session_start`
   - In daemon/multi-session: cross-session contamination possible
   - **FIXED**: wrapped in session-scoped CmState

---

## Fixes Applied This Session

| Fix | Description | Impact |
|------|-------------|--------|
| Proactive token monitoring | Heartbeat monitors `ctx.getContextUsage()` at 70/80/90% | PREVENT overflow before it happens |
| tokenWarningFired in HeartbeatState | Per-session warning state prevents spam | Avoids repeated warnings |
| Module-level retry state | Moved to CmState for session isolation | Multi-session safety |

---

## Why Proactive Monitoring Helps

The heartbeat fires every 30 seconds. At 70% context:
- Agent gets whisper: "Consider /finalize or /context_compress"
- Agent can call `finalize` to trigger rotation
- Rotation preserves state, starts with fresh context
- Loop breaks BEFORE overflow

At 80%: stronger warning
At 90%: critical warning + stops non-essential work

---

## Why It Might Still Overflow

1. **Agent ignores warnings** — autonomous sessions may not respond to whispers
2. **Runtime overflow threshold** — pi runtime fires `context` event at unknown % — might be >90%
3. **Compaction window keeps shrinking** — after 3 retries, keep is 4K tokens
4. **No automatic rotation** — rotation requires `finalize` call, agent must choose to call it

---

## Recommended: Make Warnings Trigger Automatic Actions

The heartbeat can make warnings more actionable by using `pi.sendCommand()` to force context management:

```typescript
// In the 90% threshold action:
if (percent >= 90) {
    // Don't just whisper — inject a command
    pi.sendCommand("force_finalize", {
        reason: "context_overflow_prevention"
    });
}
```

Or modify the `finalize` tool to automatically trigger when context is critical.

---

## Files Changed

- `src/extensions/heartbeat-scheduler/index.ts` — context-monitor policy, tokenWarningFired in HeartbeatState
- `src/extensions/context-manager/handlers/shared.ts` — CmState includes tokenWarningFired
