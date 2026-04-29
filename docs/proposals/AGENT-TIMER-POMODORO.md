# Proposal: Agent Timer — Non-Blocking Reminder System

**Type**: Agent Enhancement  
**Priority**: P1 (Simple but powerful)  
**Based on**: Pomodoro technique + heartbeat scheduler architecture + user's insight  
**Owner**: pi-braid research + overnight development

---

## The Problem

**Agent hangs on bash sleep:**

```bash
# Current behavior — BLOCKS for 60 seconds
$ sleep 60 && echo "done"

# Agent can't do other work during this time
# Tool call just hangs, waiting
```

**What we want:**

```python
# Agent: "I need to wait for the build to complete. I'll set a timer and work on something else."
timer_set(delay=60, reason="Build should complete soon, check result")

# Agent immediately continues with other work
# After 60 seconds, gets a reminder: "[TIMER] Build should be done, check result"
```

**Why current approach fails:**
- `sleep` in bash blocks the tool call → agent is frozen
- No way to resume without polling or blocking
- Long-running processes can't be handled gracefully
- Agent prefers `sleep` because it's simple → but it blocks everything

---

## The Core Insight

> *Agent sets up a timer internally (via heartbeat scheduler), provides final answer without hanging, and timer fires a reminder that forces a new agent turn to resume.*

This is fundamentally different from bash sleep:
- **Bash sleep**: Blocks the tool call, agent frozen, no other work possible
- **Timer**: Returns immediately, agent continues, fires reminder asynchronously

The agent can:
1. Set timer → immediately provide answer/continue work
2. Do other useful work
3. Get reminder when timer fires → resumes naturally via new turn

---

## Minimal Design

### The Tool Interface

```typescript
// Timer tool — minimal, 3 functions

interface TimerSet {
  delay_seconds: number;    // How long to wait
  reason: string;          // What to check/do when timer fires
  tag?: string;           // Optional identifier for cancellation
}

interface TimerSetResponse {
  timer_id: string;       // For cancellation
  fires_at: number;        // Unix timestamp when it fires
  message: string;         // Confirmation
}

// Agent calls this instead of bash sleep
timer_set(delay_seconds=60, reason="Check if build completed")
// → Returns immediately, does NOT block
// → Heartbeat scheduler tracks the timer
// → After 60 seconds: reminder fires → new agent turn
```

```typescript
// Query and cancel
timer_list()           // Show active timers
timer_cancel(id)       // Cancel a running timer
```

### Heartbeat Scheduler Integration

```typescript
// In heartbeat-scheduler/index.ts

interface ScheduledTimer {
  id: string;
  firesAt: number;        // Unix timestamp
  reason: string;
  tag?: string;
  turnsRemaining: number;  // For display
}

class TimerManager {
  private timers: Map<string, ScheduledTimer> = new Map();

  setTimer(delaySeconds: number, reason: string, tag?: string): string {
    const id = `timer_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const firesAt = Date.now() + (delaySeconds * 1000);
    this.timers.set(id, { id, firesAt, reason, tag });
    return id;
  }

  cancelTimer(id: string): boolean {
    return this.timers.delete(id);
  }

  getActiveTimers(): ScheduledTimer[] {
    return Array.from(this.timers.values()).sort((a, b) => a.firesAt - b.firesAt);
  }

  // Called by heartbeat on each tick
  checkExpiredTimers(now: number): ScheduledTimer[] {
    const expired: ScheduledTimer[] = [];
    for (const [id, timer] of this.timers) {
      if (timer.firesAt <= now) {
        expired.push(timer);
        this.timers.delete(id);
      }
    }
    return expired;
  }
}
```

### Timer Reminder Event

```typescript
// When a timer fires, it creates a reminder message
// This gets injected into the agent's context on the NEXT turn

function formatTimerReminder(timer: ScheduledTimer): string {
  return `\
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
[TIMER REMINDER] fires at ${new Date(timer.firesAt).toISOString()}

REASON: ${timer.reason}
TIMER_ID: ${timer.id}

Action required: ${timer.reason}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
}

// The reminder is placed in the context like a heartbeat message
// → Agent sees it as a new message/turn
// → Agent responds naturally, checking the reason
// → User sees it in TUI (EXPLICIT, not hidden)
```

---

## Why This Is Non-Blocking

```
Traditional (blocking):
  Turn N:
    Agent calls timer_set()
    → Function waits 60 seconds
    → No other turns possible
    → User sees "running" state, can't interact
    → After 60s: response returned

Timer (non-blocking):
  Turn N:
    Agent calls timer_set() → returns immediately (timer_id)
    Agent provides answer/continues work
    Turn N+1, N+2, N+3: Agent doing other useful work

  Meanwhile, heartbeat scheduler is ticking in background
  After 60s: timer fires
    → Reminder message injected into context
    → Forces new agent turn (like heartbeat)
    → Agent responds to reminder: "Let me check the build..."

User sees:
  Turn N: "I'll set a timer and check the build"
  (Agent continues working on other things)
  [TIMER REMINDER]: "Build should be done, check result"
  Turn N+1: Agent checks build, reports result
```

---

## The Pomodoro Principle

This is exactly Pomodoro technique:
1. Work on task until timer fires
2. Take a break / switch context
3. Resume after break

For agents:
1. Agent starts long-running task, sets timer
2. Timer fires → agent switches to other work OR reports result
3. Can chain timers: "check X in 30s, check Y in 60s, escalate in 120s"

---

## Explicit Is Correct Here

Following the implicit/explicit boundary principle:

```
TIMER REMINDER → ALWAYS EXPLICIT
  - User must see when timers fire
  - User must understand what the timer was for
  - User must have agency to cancel or acknowledge
  - This is RUNTIME BEHAVIOR (like enforcement signals)

Display format:
  ┌─────────────────────────────────────────┐
  │ ⏰ [TIMER REMINDER]                     │
  │ Reason: Check if build completed         │
  │ Timer ID: timer_xxx                      │
  │ Fired at: 2026-04-24T08:15:00Z         │
  │                                         │
  │ [Acknowledge] [Cancel] [Snooze 30s]    │
  └─────────────────────────────────────────┘
```

---

## Use Cases

### 1. Long-Running Process Monitoring

```python
# Agent starts build, doesn't want to hang
bash("npm run build &")  # Start build in background
timer_set(delay=30, reason="Build should be done, check npm run build output")
# Agent immediately continues: "Build started in background..."

# 30 seconds later:
# [TIMER REMINDER]: Build should be done, check npm run build output
# Agent checks output, reports result
```

### 2. Polling Without Blocking

```python
# Instead of: while not done: sleep(5); check() — BLOCKING
# Agent:
timer_set(delay=10, reason="Check API response status after 10 seconds")
# Agent continues with other work

# 10 seconds later:
# [TIMER REMINDER]: Check API response status after 10 seconds
# Agent checks status, decides: done OR set another timer
```

### 3. Pomodoro Work Cycles

```python
# Agent: "I'll work on this refactoring for 25 minutes, then review"
timer_set(delay=1500, reason="Pomodoro complete. Take a break / review progress.")
# Agent does focused refactoring

# 25 minutes later:
# [TIMER REMINDER]: Pomodoro complete. Take a break / review progress.
# Agent pauses, reviews, decides next step
```

### 4. Escalation Chains

```python
# Agent: "I'll check in 10 minutes, escalate in 30"
timer_set(delay=600, reason="Check task progress")
timer_set(delay=1800, reason="ESCALATION: Task overdue, notify user")
# Agent continues

# 10 min: reminder → agent checks
# 30 min: escalation reminder → user notified
```

---

## Implementation Plan

### Phase 1: Core Timer Tool (Day 1)

```typescript
// src/extensions/timer/index.ts

export function timerExtension(): Extension {
  const manager = new TimerManager();

  return {
    name: 'timer',
    tools: [
      {
        name: 'timer_set',
        description: 'Set a non-blocking timer. Returns immediately — does NOT hang. After delay, fires a reminder that forces a new agent turn.',
        parameters: {
          type: 'object',
          properties: {
            delay_seconds: {
              type: 'number',
              description: 'Seconds to wait before firing (1-86400)',
              minimum: 1,
              maximum: 86400
            },
            reason: {
              type: 'string',
              description: 'What to check/do when timer fires'
            },
            tag: {
              type: 'string',
              description: 'Optional identifier for cancellation'
            }
          },
          required: ['delay_seconds', 'reason']
        },
        execute: async ({ delay_seconds, reason, tag }) => {
          const id = manager.setTimer(delay_seconds, reason, tag);
          return {
            timer_id: id,
            fires_at: Date.now() + (delay_seconds * 1000),
            message: `Timer set for ${delay_seconds}s. Will remind at ${new Date(Date.now() + delay_seconds * 1000).toISOString()}`
          };
        }
      },
      {
        name: 'timer_list',
        description: 'List all active timers',
        execute: async () => {
          return { timers: manager.getActiveTimers() };
        }
      },
      {
        name: 'timer_cancel',
        description: 'Cancel an active timer',
        parameters: {
          type: 'object',
          properties: {
            timer_id: { type: 'string' }
          },
          required: ['timer_id']
        },
        execute: async ({ timer_id }) => {
          const cancelled = manager.cancelTimer(timer_id);
          return { cancelled, timer_id };
        }
      }
    ]
  };
}
```

### Phase 2: Heartbeat Integration (Day 2)

```typescript
// In heartbeat-scheduler/index.ts

// Track timers in scheduler state
interface SchedulerState {
  // ... existing fields ...
  activeTimers: Map<string, ScheduledTimer>;
}

// On heartbeat tick:
function onHeartbeatTick(state: SchedulerState, now: number) {
  // Check for expired timers
  const expired = timerManager.checkExpiredTimers(now);

  for (const timer of expired) {
    // Inject reminder into context
    const reminder = formatTimerReminder(timer);
    injectIntoContext(reminder);  // Forces new agent turn

    // Also notify user via TUI (EXPLICIT)
    displayNotification({
      type: 'timer_reminder',
      title: '⏰ Timer Fired',
      body: timer.reason,
      actions: ['Acknowledge', 'Snooze', 'Cancel']
    });
  }
}
```

### Phase 3: TUI Integration (Day 3)

```typescript
// Display active timers in TUI status bar
// Show: "⏰ 2 timers active: build (30s), api (5m)"

// When timer fires:
// - Show prominent notification
// - Add to conversation as system message (user sees it)
// - User can interact: acknowledge, snooze, cancel
```

### Phase 4: Testing (Day 4)

```typescript
// Test cases:
// 1. timer_set returns immediately (doesn't block)
// 2. Timer fires at correct time
// 3. Multiple timers fire in correct order
// 4. timer_cancel works
// 5. Timer fires even when agent is mid-turn (new turn created)
// 6. Timer persists across agent turns
```

---

## Integration with Existing Extensions

### With Heartbeat Scheduler

```typescript
// TimerManager is owned by heartbeat-scheduler
// Heartbeat tick calls checkExpiredTimers()

// This means:
// - Timer fires use existing heartbeat infrastructure
// - No separate thread/process needed
// - Integrates with heartbeat's turn tracking
```

### With Prompt Builder

```typescript
// In system prompt:
const timerSection = `
Active timers:
${activeTimers.map(t =>
  `⏰ [${t.tag || t.id}] fires in ${Math.ceil((t.firesAt - Date.now()) / 1000)}s: ${t.reason}`
).join('\n') || '(none)'}
`.trim();
```

### With Three-Memory (Future)

```typescript
// When timer fires and task completes:
// → Extract SOP from timer-based workflow
// → Store in procedural memory
// → On similar long-running task: suggest timer pattern
```

---

## Why Not Bash Sleep

| Aspect | Bash Sleep | Timer |
|--------|-----------|-------|
| Blocks agent | Yes | No |
| Multiple concurrent waits | No | Yes |
| Visible to user | Hidden | Explicit notification |
| Integrates with agent loop | No | Yes (forces new turn) |
| Cancelable | No | Yes |
| Context-aware reminder | No | Yes (reason attached) |
| Chainable | No | Yes (multiple timers) |

---

## The Deeper Principle

> *Agents should not block waiting. They should set expectations, continue working, and be notified asynchronously.*

This is the same principle as:
- Promises in JavaScript (not awaiting in a loop)
- Cron jobs (schedule and forget)
- Event-driven architecture (not polling)

The agent loop is event-driven. Timers are a natural fit.

---

## Connection to Other Proposals

| Proposal | Connection |
|----------|-----------|
| **Hierarchical Memory** | Timer events → episodic memory extraction |
| **Self-Evolution** | Timer-based workflows → SOP extraction |
| **Memory Leak Prevention** | Timers are EXPLICIT (not implicit injection) |
| **Heartbeat Scheduler** | TimerManager lives here, heartbeat tick checks expiry |

---

## Status

**Implemented** ✅ — `src/extensions/timer/index.ts` on `feature/structured-contrast` branch (worktree). Built, tested, 100% on benchmark.

Implementation details:
- `timer_set(delay_seconds, reason, tag?)` — non-blocking, registers timer
- `timer_list()` — shows active timers
- `timer_cancel(timer_id)` — cancel before firing
- Registers with `pi.on("turn_end")` to check expired timers
- Fires via `onTimerFire` handler pattern

**Still needed**:
- TUI display of active timers (in status bar)
- TUI notification when timer fires (EXPLICIT, following our principle)
- Reminder injection into conversation (via event handler)

---

*Related: HEARTBEAT-SCHEDULER-INTEGRATION (parallel agent working on this)*