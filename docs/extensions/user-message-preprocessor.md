# Extension: user-message-preprocessor

**Status**: ✅ Working
**Tests**: None
**Version**: v0.10.x

## Purpose

Intelligent user message preprocessing — detects when user messages are trivial, poorly written, non-English, or code-heavy and automatically rewrites them for clarity and completeness before they reach the agent.

## Architecture

Multi-stage analysis pipeline:

1. **Length check** — skip messages >5000 chars (`maxChars`)
2. **Code block stripping** — strip ``` blocks before analysis
3. **Bulk code detection** — skip if code blocks are the majority of content
4. **Prose brevity check** — skip if actual text <20 chars after stripping code
5. **Well-written detection** — skip if message already looks well-formed (`looksWellWritten`)
6. **English detection** — skip if >10% English stopwords (`isLikelyEnglish` with stopword ratio)
7. **Translation** — for non-English messages, translate to English (if not already detected as English)

## Events Handled

| Event   | Handler                                                                                           |
| ------- | ------------------------------------------------------------------------------------------------- |
| `input` | Preprocess user messages before they reach the agent. Runs analysis pipeline, rewrites if needed. |

## Tools

_(Tools removed 2026-04-28)_ `preprocessor_config` and `preprocessor_stats` were removed to reduce surface area. Preprocessor config is now internal only. Use `~/.pi/agent/settings.json` to toggle enabled/disabled, or the `/preprocessor` command.

## Key Patterns

- **Non-blocking by design**: Most messages skip preprocessing entirely (well-written English text passes through). Only ambiguous or problematic messages are rewritten.
- **Conservative approach**: Language detection via Unicode script ranges, not stopword counting. Non-English text is translated to English.
- **Images preserved**: Messages with attached images skip preprocessing to avoid image data loss during the `handled` → re-submit cycle.
- **Configurable**: Enabled state persists to `~/.pi/agent/settings.json`. Toggle via `/preprocessor` command.
