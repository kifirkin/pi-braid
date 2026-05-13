# Nudge Fatigue — Compliance Theater in System Prompts

**Date**: 2026-04-22
**Session**: 12
**File**: `src/extensions/context-manager/handlers/rotation.ts`

---

## The Bug

Agent received **50+ identical rotation nudges** across 50+ consecutive turns (501-550+). Each nudge followed the same compliance-framed pattern:

```
🔄 Session Rotation Recommended
1. Store important context in memory
2. Tag the current position
3. The next finalize() call will trigger rotation
```

Agent ritualistically obeyed: `memory_store` → `context_tag` → `finalize`. But `finalize` returned "Task incomplete", so rotation never happened. The nudge kept firing. The agent kept complying. **Neither side broke the loop.**

## Root Cause

1. **`turn_end` fires after every tool call**, not once per user turn. Agent calls 3 tools → 3 nudges.
2. **No deduplication**. `turnsSinceRotation` increments; `shouldRotate()` returns true; nudge sends. Every time.
3. **No action acknowledgment**. Agent does `memory_store` + `context_tag`, but handler doesn't know. Next `turn_end` → another nudge.
4. **Compliance-framed language** in nudge triggers compliance theater: agent follows instructions literally without resolving root cause.

## The Fix (Session 12)

### State Extension (global-state.ts)

Added nudge dedup fields to `RotationState`:

- `lastNudgeTurn` — prevents same-turn duplicates
- `lastNudgeTimestamp` — time-based cooldown (5 min)
- `nudgeCount` — tracks total nudges
- `actionTaken` — suppresses after agent action

### Handler Changes (rotation.ts)

1. **Deduplication gate**: skip if already nudged this turn
2. **Action cooldown**: skip for 50 turns OR 5 minutes after `memory_store`/`context_tag`/`finalize`/`context_archive`
3. **Action tracking**: `tool_end` listener watches for rotation-relevant tools
4. **Identity-framed language**: "You are managing a long session" instead of "The session is getting large. Consider..."
5. **Final reset**: `finalize` handler clears all nudge state

### Research Grounding

- **Implicit Framing** (this project): compliance directives → letter-satisfying, intent-ignoring behavior
- **Repetition Blindness** (Crick & Koch, 2003): repeated identical stimuli → cognitive suppression
- **Nudge Saturation** (Thaler & Sunstein, 2008): beyond threshold, nudges become noise

## Test Coverage

`test/runtime/test-nudge-dedup.mjs` — 5 tests:

1. First nudge at threshold fires
2. Same-turn suppression
3. Action-taken cooldown (within window)
4. Cooldown expiry (fires after)
5. finalize resets all state

All pass ✅

## Before vs After

| Dimension           | Before                          | After                         |
| ------------------- | ------------------------------- | ----------------------------- |
| Nudges per crossing | Unlimited                       | 1 per 50 turns (after action) |
| Framing             | Directive ("you MUST consider") | Identity ("you are managing") |
| Action awareness    | None                            | Tracks 4 tools                |
| Cooldown            | None                            | 50 turns + 5 minutes          |
| Reset on finalize   | Partial                         | Complete                      |

## Open Questions

1. **Is 50 turns the right threshold?** Should it scale with session size?
2. **Should nudges escalate?** First: whisper. Second: steer. Third: block?
3. **Can we measure nudge effectiveness?** Did agent actually rotate, or just ritual-comply?
4. **Should system nudges go through judge?** Self-audit of nudge quality before delivery.

---

_Document generated after fixing nudge loop in Session 12. Related: NUDGE-QUALITY-RESEARCH.md (meta-irony analysis)._
