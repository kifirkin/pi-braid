# Timer Delivery Investigation (June 2026)

User report: "Timers are now delivered as user input filled in the input
rather than a whisper that wakes the agent."

This is a behavior change from the previous design. Investigation follows.

## What the SDK provides (from `dist/core/extensions/types.d.ts`)

| Method | Returns | What it does | Notes |
|--------|---------|--------------|-------|
| `pi.sendMessage(customMessage, {triggerTurn, deliverAs})` | `void` | Inject a **CustomMessage** (customType/content/display) | `triggerTurn:true` wakes the agent. "Whisper" path. |
| `pi.sendUserMessage(text, {deliverAs})` | `void` | "Send a user message to the agent. Always triggers a turn." | **User-style input path.** |
| `pi.appendEntry(customType, data)` | `void` | Persist to session log, NOT sent to LLM | Audit log only. |

The SDK docs (`docs/extensions.md:1314-1360`) say:

> `pi.sendUserMessage` ... sends an actual user message that appears as if
> typed by the user. Always triggers a turn.

> `pi.sendMessage` ... Inject a custom message into the session. `triggerTurn: true`
> ... trigger an LLM response immediately.

So "user input filled in input" = `sendUserMessage` (per the SDK contract).
"Whisper that wakes the agent" = `sendMessage({ triggerTurn: true })`.

## What the timer extension currently does

File: `src/extensions/scheduling/timer/index.ts`

```ts
export function scheduleTimer(
  sessionId: string,
  delayMs: number,
  reason: string,
  tag?: string,
  wake: boolean = true,   // ← DEFAULT IS WAKE=TRUE
): string { ... }
```

In the `fireTimer()` function:

```ts
if (timer.wake === true) {
  // → pi.sendUserMessage(text, { deliverAs: "followUp" })
  // USER-STYLE INPUT. Per SDK contract: "Always triggers a turn".
  pi.sendUserMessage(text, { deliverAs: "followUp" });
} else {
  // → sendTrackedMessage (custom message, whisper)
  // Soft nudge, no forced turn.
  sendTrackedMessage(pi, { ... }, { deliverAs: "steer", triggerTurn: false }, ...);
}
```

**So `wake: true` literally IS user input filled in the prompt**, per the
SDK contract. This is exactly what the user is observing.

## Why this is wrong (the user's complaint)

1. **The timer tool's `set` action doesn't expose `wake`**, so agents
   calling `timer set` always get `wake: true` (the default), meaning
   they ALWAYS get user-style input delivery.

2. **The JSDoc on `scheduleTimer` is stale/contradictory**:
   > "the fire whisper uses triggerTurn: true to wake the agent"

   But the actual code uses `sendUserMessage`, NOT
   `sendMessage({ triggerTurn: true })`. The comment was written for an
   older design that has been changed.

3. **The inline comment in `fireTimer` admits the truth**:
   > "Bypasses sendTrackedMessage because the soft-nudge nature of
   > sendMessage(steer) can be ignored by the agent mid-stream."

   The author wanted a hard wake, and chose `sendUserMessage` to force it.
   But this means every timer fire looks like user input in the TUI,
   not a system whisper.

4. **The only caller of `wake: true` is `register-session-compact.ts`**,
   the post-compaction auto-resume timer. That timer genuinely needs to
   force a turn (the agent has been compacted and may be idle). The
   `wake: true` default is correct for THAT use case.

## The fix: separate the two use cases

The two timer delivery paths serve genuinely different needs:

| Use case | Right delivery | Why |
|----------|---------------|-----|
| Post-compaction auto-resume (3 min) | `sendUserMessage` (forced wake) | Agent may be idle; need to guarantee turn. User is the one who compacted, so it's like a user nudge. |
| User/agent-scheduled reminders ("remind me in 5 min") | `sendMessage({ triggerTurn: true })` | Should look like a system whisper + LLM wake, not fill the input box. |
| Background heartbeats | `sendTrackedMessage` (no wake) | Soft nudge, no forced turn. |

**Problem**: The current `wake: boolean` is too coarse. `wake: true` lumps
"force-turn user-style input" with "soft whisper that triggers a turn".

**Fix**: Replace `wake: boolean` with `wake: "user" | "steer" | "silent"`,
or expose the choice more clearly.

## Recommended fix (3 options)

### Option A: Three explicit modes (RECOMMENDED)

Replace `wake: boolean` with a 3-valued enum:

```ts
type TimerWakeMode = "user" | "steer" | "silent";

// "user"   → sendUserMessage (forced turn, fills input) — for auto-resume
// "steer"  → sendMessage({ triggerTurn: true }) (whisper that wakes) — for reminders
// "silent" → sendTrackedMessage (whisper, no wake) — for heartbeats
```

- Default: `"steer"` (most common case: agent wants a reminder, but
  doesn't want to fill the input box)
- Tool exposes a `wake` parameter so the agent can choose
- `scheduleTimer()` API: parameter name stays `wake` for compat, but
  accepts the new values

This is a small breaking change but the new defaults match user
expectations:
- Agent says `timer set 5min "review"` → whisper that wakes
- Internal post-compaction → `"user"` mode
- Background heartbeats → `"silent"`

### Option B: Flip the default to silent (MINIMAL CHANGE)

Change `scheduleTimer` default from `wake: true` to `wake: false`, and
update `register-session-compact.ts` to explicitly pass `wake: true`.

- Minimal change (1 line default, 1 call site explicit)
- But then the post-compaction auto-resume semantics get buried
- And the agent tool never exposes `wake`, so reminders become silent
  by default (no wake). The agent has to do `wake: true` somehow.

### Option C: Always use `sendMessage({ triggerTurn: true })` for wake (SDK-CORRECT FIX)

Change the `wake: true` branch to use `sendMessage` instead of
`sendUserMessage`. This is what the original JSDoc said it did.

```ts
if (timer.wake === true) {
  pi.sendMessage({
    customType: "timer",
    content: [{ type: "text", text }],
    display: true,
    details: { ... },
  }, { triggerTurn: true });
}
```

This is what the user is asking for: a "whisper" (customType content)
that also wakes the agent (triggerTurn: true). Fills neither the input
box nor looks like a user message.

Trade-off: the original author explicitly noted that the agent might
ignore `sendMessage(steer)` mid-stream. So if the agent is mid-tool-call
when the timer fires, the wake might be deferred until the tool
finishes. For post-compaction auto-resume that's acceptable; for
urgent reminders it might not be.

## My recommendation: Option C (correct fix) + Option A (better API)

1. **Immediately**: change `wake: true` to use `sendMessage({ triggerTurn: true })`.
   This matches the original JSDoc and the user's expectation. The
   "agent mid-stream ignores it" risk is mitigated by the busy guard
   already in place.

2. **Following**: add the 3-mode enum for finer control, exposing
   `wake` in the tool schema so the agent can pick.

3. **Update doc comments** to accurately reflect the delivery paths.

## Summary

| Delivery | What the user sees | When used |
|----------|-------------------|-----------|
| `sendUserMessage` (current `wake:true`) | Text in input box + auto-submit | Post-compaction auto-resume (currently only this) |
| `sendMessage({ triggerTurn: true })` (proposed) | Whisper-style message in TUI + LLM wakes | Should be the default for agent-scheduled reminders |
| `sendTrackedMessage` (current `wake:false`) | Whisper in TUI, no forced turn | Background heartbeats |

The user's request is to switch from "user input" to "whisper" delivery
for the wake=true path. The fix is straightforward: replace
`sendUserMessage` with `sendMessage({ triggerTurn: true })` in the
`wake: true` branch. Post-compaction auto-resume will still wake the
agent (via `triggerTurn: true` on the custom message), but it will no
longer fill the input box.
