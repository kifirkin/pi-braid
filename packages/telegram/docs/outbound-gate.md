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

The gate is three steps, in this order:

1. **Resolve the wire once** (`resolveDeliveryFormat`). MarkdownV2 marker pairs
   convert to HTML, an explicit `parse_mode` wins, a body carrying a tag-shaped
   token is treated as markup, `rich` marks a long-form body. The conversion's
   output is what is sent.
2. **Refuse what Telegram would reject, and what the owner asked not to read.**
   Nothing is sent on a refusal.
3. **Label it.** The delivered body opens with one line naming the sending
   process (see [the identity line](#the-identity-line)).

## The refusals

| Rule                    | Trigger                                                                      | The error names                  |
| ----------------------- | ---------------------------------------------------------------------------- | -------------------------------- |
| `plain-over-cap`        | body over 280 chars, no `parse_mode`, not `rich`                             | the rule, the length, the cap    |
| `unstructured-over-cap` | a sender-facing body over 280 chars with no structure, whatever it asked for | the rule, the length, the remedy |
| `unsupported-tag`       | a tag Telegram's parser does not accept (`<ul>`, `<div>`, ...)               | the rule and the tag             |
| `unclosed-tag`          | a tag left open (`<b>text`)                                                  | the rule, the tag and its offset |

`unstructured-over-cap` is the half a REQUEST cannot satisfy. `rich: true` and a
bare `parse_mode` used to exempt any body, so a wall of prose could ship past
the cap by asking for the format instead of using it. Past 280 chars the body
itself must carry formatting a reader can see: a tag, a MarkdownV2 pair that
converts to one, a bullet/numbered/heading line, or a `Label: value` line. The
request only chooses the transport that carries that structure. Paragraph breaks
are not structure: three paragraphs of prose are still a wall.

The rule is scoped to bodies with a sender behind them (`source: "tool"`), the
one source where a refusal has a recipient who can rewrite the body. An
automatic source keeps its delivery: a refused crafted summary would simply
never arrive, so only the markup rules apply to it.

`html-syntax` and `stray-end-tag` cover the remaining parser verdicts (a
malformed attribute, a closing tag with no opener); they carry the same tag and
offset fields. The accepted set is the calibrated one in `lib/html-check.ts`: b,
i, u, s, a, code, pre, tg-spoiler, blockquote and the documented aliases
(`strong`, `em`, `ins`, `strike`, `del`, `span class="tg-spoiler"`,
`tg-emoji`). A body over 280 chars sends formatted, never as 600 chars of naked
prose.

## The identity line

Every delivered message states which process sent it, on its own first line:

```
[braid · worker · pi-braid · session 01a1da43 · pid 98675]
```

Rendered by `lib/identity.ts` from what the process can observe (the
`BRAID_SESSION_ROLE` marker, the working directory's name, the pi session id and
the pid), attached in `planOutbound` so no caller renders or forgets it, and
memoized so one session always produces the same label. The session id comes
from the live extension context, not from the environment: pi deletes
`PI_SESSION_ID` from the environment it hands an extension and re-injects it
only into bash children, so an implementation that read `process.env` printed
`session unknown` on every message. `setIdentitySessionSource` registers the
getter once at load; the environment stays the fallback a standalone script
(`node <package>/src/lib/identity.ts`) still has, and the memo is keyed on the
id so a label rendered before the first `session_start` corrects itself. A field
the process cannot observe says so (`unknown role`, `unknown project`, `session
unknown`); a marker this build does not know is reported with its raw value
(`unknown role (oracle)`). Only the label is escaped for the wire mode; the
sender's body is never touched. Split bodies carry it once, in the first part,
and the chat-keyed tracked message keeps the label of the process that pinned
it across every later edit.

The line costs characters on the same message, so `braid.telegram.sendMaxChars`
keeps its meaning as the cap for the BODY, and a body within one label-width of
the cap can need a second chunk. `node <package>/src/lib/identity.ts [--pid N]`
prints the label a process would attach, for a process that registers no
telegram surface (a worker) or a seat checking its own.

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

`test/outbound-gate.test.mjs` (the refusals, the conversions and the label),
`test/identity.test.mjs` (the label's fields, degradation and stability),
`test/outbound-notifications.test.mjs` (every automatic source, the counters,
the debug flag), `test/outbound-tracked-chat.test.mjs` (the chat-keyed tracked
message and the label it keeps). Core's adherence digest has its own fixture:
`packages/core/test/runtime/enforcement/test-adherence-digest.mjs`.
