# Architecture Insight: Heartbeat as Event Bus

**Type**: Architecture Enhancement  
**Based on**: Timer proposal + heartbeat scheduler architecture + event-driven design  
**Related**: AGENT-TIMER-POMODORO.md  

---

## The Pattern Already Exists

The heartbeat scheduler is **already** an event bus. Every N turns, it:
1. Emits a tick event
2. Fires cognitive modules
3. Evaluates conditions
4. Updates state

Now consider: what if **everything asynchronous** emits events through this bus?

```
CURRENT (fragmented):
  ┌──────────────────┐
  │ Timer Manager     │ ← timer fires → reminder → hardcoded injection
  ├──────────────────┤
  │ Memory Manager   │ ← TTL expires → eviction → hardcoded update
  ├──────────────────┤
  │ Heuristic Engine │ ← update fires → reflection → hardcoded trigger
  └──────────────────┘

EVENT-DRIVEN (unified):
  ┌──────────────────────────────┐
  │   HEARTBEAT EVENT BUS       │
  │                              │
  │  on('timer_fire', handler)  │
  │  on('memory_evict', handler) │
  │  on('heuristic_fire', h)    │
  │  on('turn_complete', h)     │
  │  on('context_full', h)      │
  │  on('belief_conflict', h)   │
  │                              │
  │  emit('agent_reminder', msg)│ ← forces new turn
  └──────────────────────────────┘
```

---

## The Unified Event Model

```typescript
// All asynchronous events through one bus

type AgentEvent =
  | { type: 'timer_fire'; timer: ScheduledTimer; payload: string }
  | { type: 'memory_evict'; belief: Belief; reason: string }
  | { type: 'memory_conflict'; beliefs: [Belief, Belief]; conflict_type: string }
  | { type: 'heuristic_update'; heuristic: Heuristic; delta: Delta }
  | { type: 'turn_complete'; turns: number; outcome: Outcome }
  | { type: 'context_full'; usage_percent: number }
  | { type: 'belief_conflict'; beliefs: [Belief, Belief] }
  | { type: 'policy_violation'; policy: Policy; context: Context }
  | { type: 'task_progress'; task: Task; percent: number };

interface EventBus {
  on<T extends AgentEvent['type']>(
    event: T,
    handler: (event: Extract<AgentEvent, { type: T }>) => void
  ): void;

  emit(event: AgentEvent): void;

  once<T extends AgentEvent['type']>(
    event: T,
    handler: (event: Extract<AgentEvent, { type: T }>) => void
  ): void;

  off<T extends AgentEvent['type']>(
    event: T,
    handler: Function
  ): void;
}
```

---

## Why This Is Better Than Current Approach

### Current: Hardcoded Integration

```
Heartbeat tick → Check timers → Fire timer → Inject reminder
                 → Check TTL → Evict memory → Update context
                 → Check heuristics → Fire update → Reflect

Every integration is hardcoded in the heartbeat tick function.
Adding a new async mechanism = modifying heartbeat tick.
Tight coupling, hard to test, fragile.
```

### Event-Driven: Decoupled

```
Heartbeat tick → emit('tick', { turn, timestamp })
                   ↓
              ┌─────────────────────────────────────┐
              │ EVENT BUS                            │
              │                                      │
              │ timer_manager:  if tick → check timers →
              │                              emit('timer_fire', {...}) →
              │ memory_manager:  if tick → check TTL →
              │                            emit('memory_evict', {...}) →
              │ heuristic_engine: if tick → check updates →
              │                              emit('heuristic_update', {...})
              └─────────────────────────────────────┘
                   ↓
              Agent turn forced when any handler calls emit('agent_reminder')

Adding a new async mechanism = add one handler to the bus.
No heartbeat modification needed.
```

---

## Concrete Implementation

```typescript
// src/lib/event-bus.ts

type EventHandler<T extends AgentEvent = AgentEvent> = (event: T) => void;

class EventBus {
  private handlers: Map<string, Set<EventHandler>> = new Map();

  on<T extends AgentEvent['type']>(
    eventType: T,
    handler: EventHandler<Extract<AgentEvent, { type: T }>>
  ): void {
    if (!this.handlers.has(eventType)) {
      this.handlers.set(eventType, new Set());
    }
    this.handlers.get(eventType)!.add(handler as EventHandler);
  }

  emit(event: AgentEvent): void {
    const handlers = this.handlers.get(event.type);
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(event as any);
        } catch (e) {
          log.error(`Event handler error for ${event.type}:`, e);
        }
      }
    }
  }

  off<T extends AgentEvent['type']>(
    eventType: T,
    handler: EventHandler<Extract<AgentEvent, { type: T }>>
  ): void {
    this.handlers.get(eventType)?.delete(handler as EventHandler);
  }
}

export const eventBus = new EventBus();
```

### Timer Manager as Event Emitter

```typescript
// src/extensions/timer/index.ts

import { eventBus } from '../../lib/event-bus';

class TimerManager {
  private timers: Map<string, ScheduledTimer> = new Map();

  setTimer(delaySeconds: number, reason: string, tag?: string): string {
    const id = `timer_${Date.now()}`;
    const firesAt = Date.now() + delaySeconds * 1000;
    this.timers.set(id, { id, firesAt, reason, tag });

    // No blocking. Timer will emit via heartbeat.
    return id;
  }

  // Called by heartbeat on each tick
  checkExpired(now: number): void {
    for (const [id, timer] of this.timers) {
      if (timer.firesAt <= now) {
        this.timers.delete(id);

        // Emit event — heartbeat handles it
        eventBus.emit({
          type: 'timer_fire',
          timer,
          payload: `⏰ Timer "${timer.reason}" has fired. Action required.`
        });
      }
    }
  }
}
```

### Heartbeat as Event Loop

```typescript
// src/extensions/heartbeat-scheduler/index.ts

import { eventBus } from '../../lib/event-bus';

function heartbeatTick(state: SchedulerState): void {
  const now = Date.now();
  state.turnCount++;

  // Emit tick event — modules respond via handlers
  eventBus.emit({
    type: 'turn_complete',
    turn: state.turnCount,
    outcome: state.lastOutcome
  });

  // Modules register handlers, not called directly
  // TimerManager registers: if tick → checkExpired()
  // MemoryManager registers: if tick → checkTTL()
  // etc.
}

// Module registration (in each module's init)
eventBus.on('turn_complete', ({ turn }) => {
  timerManager.checkExpired(Date.now());
});
```

---

## The Agent Reminder Pattern

Every async event can force a new agent turn via one mechanism:

```typescript
// In heartbeat tick:
eventBus.on('timer_fire', ({ payload }) => {
  // Inject into agent context → forces new turn
  injectIntoContext({
    type: 'system',
    role: 'system',
    content: payload,
    metadata: { source: 'timer', display: 'explicit' }
  });
});

eventBus.on('memory_evict', ({ belief, reason }) => {
  injectIntoContext({
    type: 'system',
    role: 'system',
    content: `[MEMORY EVICTION] ${belief.entity}:${belief.relation}:${belief.value} — ${reason}`,
    metadata: { source: 'memory', display: 'explicit' }
  });
});

eventBus.on('belief_conflict', ({ beliefs }) => {
  injectIntoContext({
    type: 'system',
    role: 'system',
    content: `[BELIEF CONFLICT DETECTED] ${beliefs[0].value} vs ${beliefs[1].value}`,
    metadata: { source: 'belief_store', display: 'explicit' }
  });
});
```

---

## All Async Mechanisms as Events

| Mechanism | Event | Forces Turn? | Handler |
|-----------|-------|-------------|---------|
| Timer fires | `timer_fire` | ✅ | Inject reminder |
| Memory TTL expires | `memory_evict` | Optional | Log / inject |
| Belief conflict detected | `belief_conflict` | ✅ | Inject warning |
| Heuristic update | `heuristic_update` | Optional | Log / reflect |
| Context full | `context_full` | ✅ | Inject compression request |
| Policy violation | `policy_violation` | ✅ | Inject enforcement |
| Task progress milestone | `task_progress` | Optional | Inject status |

---

## The Core Principle

> *Everything asynchronous forces turns the same way: through explicit event injection into the agent context.*

The heartbeat is not the "thing that fires modules." It's the event loop that routes events to handlers, and handlers decide whether to force a new turn.

---

## Connection to Timer Proposal

The timer is the **simplest example**:

```
timer_set(60, "Check build") → heartbeat.tick() → checkExpired() →
eventBus.emit('timer_fire', {payload}) → injectIntoContext() → new turn
```

But the same pattern works for:
- Memory eviction (TTL)
- Belief conflict (dedup)
- Heuristic updates (reflection)
- Context pressure (compression)

---

## Status

**Design complete**. Implementation: extend each module to emit events through eventBus, rather than hardcoding in heartbeat tick.

---

*Related: AGENT-TIMER-POMODORO.md*  
*Related: HEARTBEAT-SCHEDULER-INTEGRATION (parallel agent working on this)*