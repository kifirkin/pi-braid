# Extension: feedback (REMOVED in v0.2.6)

**Status**: ❌ Removed — merged into enforcement turn_end dispatcher (was duplicating scratchpad/think-tool nudges).
See docs/extensions/enforcement.md for the replacement.
**Tests**: None (hard to unit test — UI component)
**Version**: v0.9.x

## Purpose

Structured feedback collection — prompts the user for task-quality feedback at natural breakpoints using interactive UI components. Implements the feedback loop from the BRAID-NEXT proposal.

## Architecture

Two feedback triggers:

1. **Passive** — `feedback_status` tool (agent queries current feedback state)
2. **Active** — `turn_end` event: periodically asks "Was that response helpful?" using interactive TUI components

## Events Handled

| Event              | Handler                                                                     |
| ------------------ | --------------------------------------------------------------------------- |
| `turn_end`         | Every ~5 turns, prompt user for structured feedback via interactive message |
| `session_shutdown` | Flush pending feedback state                                                |

## Tools

| Tool              | Description                                                                               |
| ----------------- | ----------------------------------------------------------------------------------------- |
| `feedback_status` | Returns current feedback counts (helpful, unhelpful, neutral) and last feedback timestamp |

## Key Patterns

- **Cooldown-based**: Only prompts every N turns (configurable) to avoid annoying the user. Resets cooldown on any user message.
- **Interactive prompt**: Uses `ctx.ui.custom()` to create a multi-choice feedback widget in the TUI.
- **Structured storage**: Simple counter state with timestamps. No persistent storage — feedback is ephemeral within session.
