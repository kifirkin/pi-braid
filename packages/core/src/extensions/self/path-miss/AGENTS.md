<!-- status: current -->

# src/extensions/self/path-miss/ - Path-Miss Steer

When a tool result reports a missing path, one whisper says which move would
have found it. The failure is the moment the cheaper instrument is obvious;
without it the agent guesses again.

## Files

| File        | Purpose                                                                                              |
| ----------- | ---------------------------------------------------------------------------------------------------- |
| `index.ts`  | The emitter: subscribes to tool results, holds the budget, sends through `sendTrackedMessage`.       |
| `detect.ts` | Recognises a missing-path failure and names the path. Pure: no state, no delivery, no extension API. |

## Local Contracts

- **One line per turn, at most one line per path per session.** The turn flag
  is reset by the `input` handler (the same boundary the whisper family uses);
  the per-path set is keyed on the session id and bounded.
- **No new event registration.** The emitter rides pi's existing `tool_result`
  event, the only seat that carries both the failure text and the call's own
  arguments - the call's `path` is stronger evidence than a parse of the
  message.
- **Delivered as a live steer** (`delivery: "live"`), so it reaches a running
  loop and never wakes one by itself.
- **A suppressed send does not spend the path's budget.** If the whisper funnel
  drops the line, the path stays steerable.
- **Only a missing path is a path miss.** `EACCES`, an unreadable file and a
  failed assertion each call for a different next move.
- Tool coverage: `read`, `edit`, `write`, `bash`. A failure from any other tool
  is not classified, whatever its text says.

## Related modules

- `lib/utils/injection-tracker.ts` - `sendTrackedMessage`, the delivery trunk
  (envelope, flood cap, delivery class).
- `extensions/self/auto-recovery/` and `extensions/self/watchdog/` - the
  neighbouring whisper emitters.
