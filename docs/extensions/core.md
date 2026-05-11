# Extension Group: core

Foundation extensions that are always loaded (non-toggleable).

## Extensions

| Extension                    | Files | Purpose                                                          |
| ---------------------------- | ----- | ---------------------------------------------------------------- |
| `polyfill/`                  | 1     | Compatibility layer, session state management, resource cleanup. |
| `metacognition/`             | 1     | Meta-learning, tick interval adjustment, degrade-on-idle.        |
| `scratchpad/`                | 1     | Goal/plan/state management for long sessions.                    |
| `user-message-preprocessor/` | 1     | Message normalization, duplicate detection.                      |

Total: 9 `.ts` files across 4 sub-extensions.

## Key Architecture

All `core` module extensions are **always on** regardless of `BRAID_MODULES` setting.

**Session lifecycle:** session_start → registerSessionCleanup() → session_end → cleanup resources

**Scratchpad eviction:** FIFO with configurable caps (plan:20, done:50, decisions:30, hypotheses:20, notes:30, learnings:50, constraints:20). Prior goal survives set_goal().

## See Also

- [polyfill.md](polyfill.md) — session state management
- [metacognition.md](metacognition.md) — meta-learning
- [scratchpad.md](scratchpad.md) — goal/plan management
- [user-message-preprocessor.md](user-message-preprocessor.md) — message normalization
