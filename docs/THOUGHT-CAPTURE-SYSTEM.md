<!-- status: forward-looking -->

# "Bend a Finger" — Thought Capture System

## Problem

The user throws out tons of ideas, tasks, observations, and philosophical insights between their messages. These don't fit the current conversation context — they're "parking lot" items that need to be captured, recalled, and orchestrated later when there's no higher-priority work.

Current tools that partially address this:
- `scratchpad(action="add_note")` — captures but no recall trigger
- `memory_store()` — persists but no orchestration trigger
- `timer()` — reminds but doesn't hold content
- `scratchpad(action="add_plan")` — adds to plan but no priority-based scheduling

None of these are designed for "capture a thought that doesn't fit the current context and recall it when the context is right."

## Design

### Core Concept: The Parking Lot

A lightweight, structured storage for thoughts that arise during conversation but aren't immediately actionable. Each thought has:

```
{
  id: "thought-<uuid>",
  capturedAt: <timestamp>,
  source: "user-message" | "self-reflection" | "observation",
  content: "the thought itself",
  context: "what was happening when the thought arose",
  priority: "now" | "soon" | "someday",
  tag: "philosophy" | "task" | "bug" | "idea" | "research",
  surfaceAfter: <timestamp or null>,  // don't show until this time
  surfaced: false,
  resolved: false
}
```

### Storage

Two tiers:
1. **Hot** (scratchpad) — current session, thoughts that are relevant NOW but not in the current turn
2. **Cold** (memory_store) — cross-session, long-term thoughts that need to survive compaction

### Recall Mechanism

At natural turn boundaries (after user message, after tool result), the agent checks:
1. Any hot thoughts with matching context?
2. Any cold thoughts with `surfaceAfter` in the past?
3. Any thoughts tagged with the current topic?

If yes, surface them in a concise "Parking Lot" whisper.

### Orchestration

When there's no higher-priority work:
1. Check the parking lot for items tagged as "task"
2. Prioritize by priority (now > soon > someday)
3. Execute the highest-priority task
4. Mark as `resolved: true` when done
5. If the task needs user input, mark as `blocked` and wait

### Implementation Path

1. **Phase 1** — Manual capture: agent uses `scratchpad(action="add_note")` with a `[PARKING-LOT]` prefix for thoughts that don't fit the current context. At turn boundaries, check for `[PARKING-LOT]` notes and surface them.

2. **Phase 2** — Structured storage: create a dedicated parking-lot extension or use the scratchpad's note system with proper tagging. Add a `parking-lot` tool that allows listing, tagging, and prioritizing captured thoughts.

3. **Phase 3** — Automatic orchestration: the parking lot is checked at natural turn boundaries. When no user input is pending and no high-priority work is active, the agent picks from the parking lot automatically.

### Relationship to Existing Tools

| Tool | Role | Gap |
|------|------|-----|
| `scratchpad` | Hot storage, current session | No recall trigger, no cross-session |
| `memory_store` | Cold storage, cross-session | No orchestration, no priority |
| `timer` | Time-based reminder | No content, no context |
| `whisper` | Surface at turn boundary | No persistent storage |
| `topic_drift` | Context alignment | No thought capture |

### The Name

"Bend a finger" — like how humans physically bend a finger to remember something they need to mention later. The system is the digital equivalent: a lightweight, physical gesture of setting something aside for later recall.

### Next Steps

1. Start using `[PARKING-LOT]` prefix in scratchpad notes for manual capture
2. Design the parking-lot tool schema
3. Implement Phase 1 (manual capture + turn-boundary check)
4. Evaluate whether it should be a braid extension or a scratchpad feature