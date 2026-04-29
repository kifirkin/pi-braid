# Extension: ux

**Status**: ✅ Working
**Tests**: None
**Version**: v0.9.x

## Purpose

UX conventions and user interaction patterns — provides the agent with consistent guidelines for responding to users, handling tool outputs, and managing conversation flow.

## Architecture

UX conventions are injected into the system prompt via `prompt-builder`. This extension defines the conventions but doesn't have its own tools — it's a configuration/guidelines extension.

## Events Handled

| Event                   | Handler                                            |
| ----------------------- | -------------------------------------------------- |
| `session_before_prompt` | Inject UX convention guidelines into system prompt |

## Key Patterns

- **Prompt-only extension**: No tools. No state. Just convention injection.
- **Convention scope**: Response formatting, tool output display, error communication, follow-up question patterns.
