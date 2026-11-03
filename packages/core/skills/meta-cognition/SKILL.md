---
name: meta-cognition
description: "Use when an enforcement signal arrives or a transition is reached - between tasks, after tool calls, on signals. Signal-to-action mappings for enforcement whisper families (verification judge, tool loop, error burst, context advisory, unpersisted learnings, signal density warnings), then close the loop: observe, evaluate, adapt, persist."
triggers:
  - "verification judge"
  - "tool loop"
  - "error burst"
  - "context advisory"
  - "unpersisted learning"
validated: 2026-08-16
verdict: KEEP
---

# Meta-Cognition

When you see this signal, adapt like this:

| When                                                            | Then                                                                                                                         |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Verification judge flags ungrounded claim                       | Call `verify_claim()` on the claim before the next `finalize()`. If unfixable, say "I don't know" and propose how to verify. |
| Tool loop detected (same tool repeated)                         | Stop. Call `think()` with observation and decision. Use the timer tool to break the loop.                                    |
| Error burst (3+ consecutive errors)                             | Stop. Read the errors. Call `hypothesize()` before retrying.                                                                 |
| Context projected full                                          | Tag position with `context_navigate(action="tag")`, then `context_compress(action="archive")`.                               |
| Unpersisted learning whisper                                    | Call `memory_store()` with content, type, and tags.                                                                          |
| Non-test code changed                                           | Write a test if one would catch recurrence of the same bug.                                                                  |
| Same enforcement signal repeats                                 | Check `heuristics_list`. If a rule is active but the signal keeps firing, call `heuristics_evolve()`.                        |
| Signal density warning (narrative that doesn't change behavior) | Cut the sentence. If removing it doesn't change what the reader does, it was noise. Log the pattern with `memory_store()`.   |
| Same gap repeats 3+ sessions                                    | The fix is a new skill - the only artifact that survives projects, restarts, and compactions.                                |

After acting, close the loop: call `memory_store()` for new insights or `heuristics_evolve()` to reinforce/weaken a rule. If it's not persisted, it didn't happen.
