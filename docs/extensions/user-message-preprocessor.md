# Extension: user-message-preprocessor

**Status**: ✅ Working
**Tests**: None
**Version**: v0.11.x

## Purpose

Intelligent user message preprocessing — detects when user messages are trivial, poorly written, non-English, or code-heavy and automatically rewrites them for clarity and completeness before they reach the agent.

## Architecture

Skip-based classification pipeline (in order):

1. **Min length check** — skip messages <10 chars (`minLength`)
2. **Already preprocessed** — if message was preprocessed and user is resubmitting, let it through
3. **Image attached** — skip; image data can't survive the handled → re-submit cycle
4. **Command detection** — skip messages starting with `/` or `!` (`skipCommands`)
5. **Code-heavy detection** — skip if >30% of non-whitespace chars are code-like (`isCodeHeavy`)
6. **Well-written detection** — skip if message looks already well-formed (`looksWellWritten`)
7. **Active compaction** — skip during background compaction
8. **Translation/cleaning** — for remaining messages, call session LLM to clean/translate

If preprocessing changes the text, the editor is updated and the user must press Enter again to send. If unchanged or skipped, the message goes through immediately.

### Preprocessing lifecycle (two-step flow):

1. User submits input → skip checks → LLM call → editor updated with cleaned text
2. User presses Enter again → no re-preprocessing, text sent to agent
3. Next user message → preprocessing runs again

## Events Handled

| Event           | Handler                                                                                                 |
| --------------- | ------------------------------------------------------------------------------------------------------- |
| `input`         | Preprocess user messages before they reach the agent. Runs classification pipeline, rewrites if needed. |
| `agent_end`     | Safety reset of preprocessing state                                                                     |
| `session_start` | Lazy-load compaction state check (avoids circular dependency)                                           |

## Commands

| Command         | Description                 |
| --------------- | --------------------------- |
| `/preprocessor` | Toggle preprocessing on/off |

## Key Patterns

- **Non-blocking by design**: Most messages skip preprocessing entirely (well-written English text passes through). Only ambiguous or problematic messages are rewritten.
- **Per-message lifecycle**: The preprocessing flag is set only during the two-step wait (user reviewing diff) and reset when the message is sent. No global blocking.
- **Role isolation**: The preprocessor uses a strict SYSTEM_PROMPT that explicitly states it is NOT the main assistant. XML `<user_message>` tags wrap the input to visually separate content from instructions.
- **Anti-instruction-following**: The prompt includes explicit DO NOT rules preventing the model from executing commands inside the user message.
- **Language detection**: Via Unicode script ranges (`language-hint.ts`), not stopword counting. Non-English text is translated to English.
- **Images preserved**: Messages with attached images skip preprocessing entirely.
- **Configurable**: Enabled state persists to `~/.pi/agent/settings.json`. Toggle via `/preprocessor` command.
