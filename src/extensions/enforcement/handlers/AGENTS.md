<!-- status: current -->

# src/extensions/enforcement/handlers/ - Event Wiring + Analysis Pipeline

The enforcement extension is the largest in pi-braid. Its `handlers/`
directory contains 16+ files with TWO distinct concerns:

1. **Framework event wiring** - files named `register-*.ts` that
   subscribe to pi core events (`registerTool`, `pi.on(...)`, etc.)
2. **Analysis pipeline** - files in `analysis/` subdir that run as
   part of the per-turn analysis phase

## What "handlers" means here

In this directory, "handlers" = "anything that handles an event or runs
in a pipeline." It's the broadest use of the term in the codebase.

## Categories of files here

### Framework event wiring (`register-*.ts`)
These are the entry points for enforcement. They register with pi core
and delegate to the actual enforcement logic.

| File | Event |
|---|---|
| `register-session-start.ts` | `session_start` |
| `register-session-compact.ts` | `session_compact` |
| `register-session-shutdown.ts` | `session_shutdown` |
| `register-input-handler.ts` | `input` |
| `register-message-end.ts` | `message_end` |
| `register-tool-call.ts` | `before_tool_call` |
| `register-tool-result.ts` | `tool_execution_end` |
| `register-auto-retry-end.ts` | `auto_retry_end` |

### Orchestrators (not `register-*`, but invoked at turn end)
| File | Purpose |
|---|---|
| `turn-end-handler.ts` | Main turn-end orchestrator. 376L. |
| `routing-handler.ts` | Routes turn-end events to specific analysis handlers. 215L. |
| `turn-analysis.ts` | Turn-level analysis logic. 141L. |
| `message-analysis.ts` | Message-level analysis. 99L. |

### Other utilities
| File | Purpose |
|---|---|
| `tool-tracker.ts` | Per-tool-call tracking. 137L. |
| `orphan-chains.ts` | Detects orphan tool call chains. 59L. |
| `blocking.ts` | Tool call blocking logic. 79L. |
| `probe-handler.ts` | Lightweight probe for LLM calls. 158L. |

### Analysis pipeline
See `./analysis/AGENTS.md` for the 6 analysis handlers
(bpe, dreamer, drift, feedback, mars, reflection).

## Why so mixed?

Historical: enforcement grew organically as new concerns were added.
A future refactor could split into `framework/`, `orchestrators/`,
`utilities/`, and `analysis/` (the last is already separated). For now,
the `register-*` prefix is the easiest way to spot framework wiring.
