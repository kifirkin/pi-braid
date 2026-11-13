<!-- status: current -->

# Outbound gate: what may leave for the owner's chat

The owner's rule, in his words: no raw unstructured text longer than a tweet
length, and the automatic messages reviewed the same way. This file is the
contract behind that rule; `packages/telegram/src/lib/notify/outbound.ts` is the
code.

## One decision, at the sender

Every owner-facing message in this package passes `planOutbound` before a client
call exists: the `telegram_send` tool, the tracked "working" message, the turn
summary, the turn-complete notify, the adherence digest, the watchdog canary and
the provider outage alert. A per-notification check is a promise each new
notification can forget; a check at the sender is a promise the wire keeps.

The gate is two steps, in this order:

1. **Resolve the wire once** (`resolveDeliveryFormat`). MarkdownV2 marker pairs
   convert to HTML, an explicit `parse_mode` wins, a body carrying a tag-shaped
   token is treated as markup, `rich` marks a long-form body. The conversion's
   output is what is sent.
2. **Refuse what Telegram would reject, and what the owner asked not to read.**
   Nothing is sent on a refusal.

## The three refusals

| Rule              | Trigger                                                        | The error names                  |
| ----------------- | -------------------------------------------------------------- | -------------------------------- |
| `plain-over-cap`  | body over 280 chars, no `parse_mode`, not `rich`               | the rule, the length, the cap    |
| `unsupported-tag` | a tag Telegram's parser does not accept (`<ul>`, `<div>`, ...) | the rule and the tag             |
| `unclosed-tag`    | a tag left open (`<b>text`)                                    | the rule, the tag and its offset |

`html-syntax` and `stray-end-tag` cover the remaining parser verdicts (a
malformed attribute, a closing tag with no opener); they carry the same tag and
offset fields. The accepted set is the calibrated one in `lib/html-check.ts`: b,
i, u, s, a, code, pre, tg-spoiler, blockquote and the documented aliases
(`strong`, `em`, `ins`, `strike`, `del`, `span class="tg-spoiler"`,
`tg-emoji`). A body over 280 chars sends as HTML or `rich`, never as 600 chars
of naked prose.

## Long bodies

`rich: true` marks a body as long-form: the plain cap does not apply, the body is
converted once, and a converted body over Telegram's 4096-per-message limit is
split tag-aware so every chunk parses on its own. The tool's `braid.telegram.sendMaxChars`
still caps the rendered result of a conversion: when the conversion would cross
it, the conversion is refused and the authored text ships.

## The counters

`outboundMetricsSnapshot()` and `renderOutboundMetrics()` report four numbers;
`BRAID_TG_OUTBOUND_METRICS=1` logs the line after every send or refusal:

- **tracked acks**: tracked "working" messages pinned (one per chat, not one per
  seat, see [the tracked message](live-update.md));
- **owner messages in the last hour, by source**: `tool`, `tracked`, `summary`,
  `turn-notify`, `adherence-digest`, `watchdog-signal`, `outage-notify`;
- **escalations suppressed**: crossings the adherence meter folded into a digest
  instead of sending each one (the meter reports the count with the message);
- **refusals by rule**: what the gate stopped, by rule name.

## Tests

`test/outbound-gate.test.mjs` (the refusals and the conversions),
`test/outbound-notifications.test.mjs` (every automatic source, the counters,
the debug flag), `test/outbound-tracked-chat.test.mjs` (the chat-keyed tracked
message). Core's adherence digest has its own fixture:
`packages/core/test/runtime/enforcement/test-adherence-digest.mjs`.
