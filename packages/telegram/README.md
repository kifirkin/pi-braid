# pi-braid-telegram

<!-- status: current -->

Bidirectional Telegram channel for pi-braid.

```bash
pi install npm:pi-braid-telegram
```

One command, no clone, no build: `pi install` registers the package with pi and installs it under pi's npm directory.

- **Outbound**: `telegram_send` tool - the agent sends text messages to the
  owner (or voice notes once a TTS source is configured). Messages are LONG by
  default: plain text sends verbatim up to the cap (`braid.telegram.sendMaxChars`
  in `~/.pi/agent/settings.json`, default 4096 = Telegram's per-message limit);
  there is no tweet-length default. Over the cap, the crafting model distills
  first and `rich: true` splits-to-fit instead. Returns the delivery
  result (message_id or error). Outbound sends the raw trimmed
  text verbatim - the `[tg-end]` marker is an INBOUND parse boundary only and
  never appears on outbound messages.
- **Turn-complete auto-notify (opt-in)**: with
  `BRAID_TG_NOTIFY_ENABLED=1`, when a turn ends with a completed plain-text
  answer (no trailing tool call), a second LLM call (key-ring-backed via
  `ctx.modelRegistry`, never the bot token) distills the answer into an owner
  update capped at `braid.telegram.notifyMaxChars` (default 1200) and sends it
  through the same outbound seam. Rate-limited (default 4/min,
  `BRAID_TG_NOTIFY_MAX_PER_MIN`); model override via `BRAID_TG_NOTIFY_MODEL`.
  Default OFF - no unsolicited messages.
- **Live-update tracked message (default-on)**: on every escalated
  inbound owner message the bot immediately sends one "⚙️ Working…" message,
  edits it in place (Telegram's edit affordance pins it at its position) as work
  progresses, then on a completed turn edits it to "✅ Done" and sends a SEPARATE
  beautifully formatted full report via rich Markdown + split-to-fit
  (`sendMessageChunks`). Progress edits are rate-limited (default 4/min);
  `finish()` is never dropped. Default ON - set
  `BRAID_TG_LIVE_UPDATE_ENABLED=0` to disable.
- **Rich / split-to-fit outbound**: `telegram_send` gained optional
  `rich: true` and `parse_mode: "HTML"|"Markdown"`. `rich` bypasses the send
  cap and the craft hook, delivering the text verbatim split on
  paragraph→line→word boundaries with a `(i/N)` marker; bodies that ship as
  HTML are split tag-aware (no cut inside a tag/entity; a chunk closes the tags
  it opens, the next chunk reopens them). A Markdown balance guard
  (`isBalancedMarkdown`) drops `parse_mode` to plain text (never an API error)
  when Telegram would reject unbalanced emphasis/link delimiters, and the
  MarkdownV2→HTML conversion is validated against Telegram's HTML parser
  (`checkTelegramHtml`): a conversion that would cross delimiter pairs, emit an
  unbalanced/broken author tag or cross the cap is refused, and the body ships
  as authored. Default path (no `rich`) is plain text with the
  settings-driven cap.
- **Decision buttons (tap-to-answer)**: `telegram_send` gained optional
  `options` - 1-2 rows of up to 4 `{ label, value }` buttons attached to the
  message as an inline keyboard - and `decisionToken`, their correlation id
  (generated when omitted, echoed in the tool result). A tap is acknowledged
  with a toast and reaches the agent as a normal inbound message
  `[decision] <token> → <label> (<value>)` (through the same coalescing
  window and steer handoff as a text message). The owner can always answer
  in words;
  malformed rows refuse the send (nothing delivered); `pause`/`resume`/`status`
  control taps keep their own handler.
- **Inbound (agentic pull, default)**: `telegram_inbox` tool - the agent calls
  it mid-turn to fetch pending messages from whitelisted chats via `getUpdates`
  (offset confirm-on-read, persisted across restarts). Results come back as
  braid-whisper envelopes (context, NOT synthetic user turns) with sender
  provenance + a per-message `fromOwner` flag; only owner messages may be
  escalated to a turn.
- **Inbound (background poller, opt-in only)**: the legacy long-poll injector
  is OFF by default. Explicitly enable via `BRAID_TG_POLL_ENABLED=1` at load,
  `/telegram enable`, or the `telegram_poller` tool (`action:"enable"`). At
  most ONE poller per process (singleton). Owner messages are delivered as
  `[braid-whisper - telegram] ... [braid-whisper-end]` envelopes.

Zero npm runtime dependencies: the client is built on Node 22's global fetch.
No live credentials, no real network calls in the test suite (recorded-fixture
fake fetch).

## Install

```bash
pi install npm:pi-braid-telegram
```

Or register the workspace in `~/.pi/agent/settings.json`:

```json
{
  "packages": ["file:~/pi-braid/packages/telegram"]
}
```

## What this does not do

- It does not poll or push by default. The background poller is OFF, turn-complete auto-notify is
  opt-in, and the tracked in-progress message fires only on an escalated inbound owner message.
- It does not accept strangers. Only whitelisted chats/users are read, and only owner messages may
  be escalated to a turn.
- It does not bundle a Telegram client library - the Bot API calls use Node 22's global fetch.

## Activation preconditions

- `BRAID_TG_BOT_TOKEN` set - this is what enables the channel.
- A bot token from @BotFather; optionally `BRAID_TG_CHAT_ID` / `BRAID_TG_ALLOWED_USERS` for the
  allow-list.

## Environment variables

| Var                                | Purpose                                                                | Required                                                        |
| ---------------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------- |
| `BRAID_TG_BOT_TOKEN`               | Telegram bot token from @BotFather                                     | **enables the channel** (if-has-token guard)                    |
| `BRAID_TG_CHAT_ID`                 | Owner chat/user id for outbound + allow-list                           | optional (bootstrap fallback)                                   |
| `BRAID_TG_ALLOWED_USERS`           | Extra allow-list ids/@usernames (comma-separated)                      | optional                                                        |
| `BRAID_TG_STATE_FILE`              | Offset/state file path                                                 | optional, default `~/.pi/agent/braid/telegram-state.json`       |
| `BRAID_TG_POLL_INTERVAL_MS`        | Poll cadence (background poller)                                       | optional, default 1500                                          |
| `BRAID_TG_POLL_ENABLED`            | Explicit opt-in: auto-start the background poller at load (`1`)        | optional; default OFF (`TELEGRAM_POLL_ENABLED` alias)           |
| `BRAID_TG_POLL_DISABLED`           | Legacy opt-out flag (superseded by default-off; still honored)         | optional                                                        |
| `BRAID_TG_COALESCE_WINDOW_MS`      | Coalescing window for inbound owner bursts (ms; `0` = next tick)       | optional, default 2000                                          |
| `BRAID_TG_VERBOSE`                 | Route debug/info to the notify sink (still never console.\*)           | optional                                                        |
| `BRAID_TG_NOTIFY_ENABLED`          | Opt-in: turn-complete auto-notify, default OFF                         | optional                                                        |
| `BRAID_TG_NOTIFY_MODEL`            | Crafting model override (`provider/model-id`); default = session model | optional                                                        |
| `BRAID_TG_NOTIFY_MAX_PER_MIN`      | Auto-notify rate cap (sliding window), default 4                       | optional                                                        |
| `BRAID_TG_LIVE_UPDATE_ENABLED`     | Live-update tracked message, default ON (`0` disables)                 | optional                                                        |
| `BRAID_TG_LIVE_UPDATE_MAX_PER_MIN` | Live-update progress-edit rate cap (sliding window), default 4         | optional                                                        |
| `BRAID_TG_LIVE_UPDATE_STATE_FILE`  | Tracked-message state file path                                        | optional, default `~/.pi/agent/braid/telegram-live-update.json` |

All `BRAID_TG_*` names have `TELEGRAM_*` owner-side aliases; `BRAID_TG_*` wins
when both are set. No token → the extension factory returns immediately; no
tools, no command, no poller, nothing crashes (debug log only).

## Tools & command

| Surface                 | Purpose                                                                                                                                                                                                                                                                                                                                   |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `telegram_send`         | Outbound text/voice to the owner (raw trimmed text, no end marker); optional `rich: true` for verbatim split-to-fit delivery, `parse_mode: "HTML" or "Markdown"`, `options` for decision buttons (1-2 rows of up to 4 `{ label, value }` buttons; a tap returns `[decision] <token> → <label> (<value>)`), `decisionToken` correlation id |
| `telegram_inbox`        | Agentic pull - fetch pending messages, confirm-on-read, `fromOwner` flag                                                                                                                                                                                                                                                                  |
| `telegram_poller`       | Enable/disable the singleton background poller (agent tool)                                                                                                                                                                                                                                                                               |
| `/telegram enable`      | Start the singleton background poller                                                                                                                                                                                                                                                                                                     |
| `/telegram disable`     | Stop the singleton background poller                                                                                                                                                                                                                                                                                                      |
| `/telegram send <text>` | Send a message from the shell (raw trimmed text, no marker)                                                                                                                                                                                                                                                                               |
| `/telegram status`      | Show channel + poller state                                                                                                                                                                                                                                                                                                               |

## Components

| Path                            | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/index.ts`                  | Extension factory: if-has-token guard, registers `telegram_send`/`telegram_inbox`/`telegram_poller`, `/telegram` command, singleton poller (OFF by default), TUI-safe notify sink, turn-complete auto-notify (`turn_end` listener, opt-in), live-update tracked message (`start` on inbound / `finish` on `turn_end`, default-on), LLM-crafted + rich/split-to-fit outbound                                                                                                      |
| `src/lib/telegram-client.ts`    | Low-level `api.telegram.org/bot<token>/<method>` client (sendMessage, editMessageText, sendVoiceNote, sendChatAction, getUpdates, getMe, testToken) with injectable fetch; `parse_mode` on text sends/edits                                                                                                                                                                                                                                                                      |
| `src/lib/inbound-poller.ts`     | Long-poll loop: allow-list + bootstrap filtering, group/non-text rejection, confirm-on-read offset persistence, injection retry buffer                                                                                                                                                                                                                                                                                                                                           |
| `src/lib/telegram-inbox.ts`     | `fetchInbox` agentic-pull core: fetch → filter → return with `fromOwner` → confirm offset; braid-whisper envelope formatting                                                                                                                                                                                                                                                                                                                                                     |
| `src/lib/tool-logic.ts`         | `telegram_send` validation, settings-driven cap enforcement (craft hook replaces dumb truncate; `braid.telegram.sendMaxChars` default 4096), rich/split-to-fit + parse_mode + Markdown-balance guard, text/voice delivery orchestration                                                                                                                                                                                                                                          |
| `src/lib/tts.ts`                | Outbound voice synthesis: `braid.telegram.tts` source/rate/voice reader (default edge-tts, rate +20%, RU/EN/HE voices by script), edge-tts → ffmpeg ogg/opus with retry, gated macOS `say` fallback, `source: "none"` → voice refusal; injectable spawn seam                                                                                                                                                                                                                     |
| `src/lib/format.ts`             | `splitLongText` (paragraph→line→word boundaries, `(i/N)` markers), `splitHtmlText` (tag-aware chunks: tags close/reopen across cuts, entities stay whole; an over-cap tag refuses the body instead of being trimmed), `sendMessageChunks` (split-to-fit 4096, parseMode-propagation, replyMarkup on the last chunk), `isBalancedMarkdown` (pre-send guard), `convertMarkdownV2ToHtml` (refuses conversions Telegram would reject), `resolveDeliveryFormat` (mode decision point) |
| `src/lib/html-check.ts`         | `checkTelegramHtml`: strict local mirror of Telegram's HTML parser (tag set, attribute quoting, end-tag attributes, unquoted-value delimiters, span/tg-emoji attribute rules, LIFO nesting), calibrated against the live API; gates every conversion and every HTML wire chunk                                                                                                                                                                                                   |
| `src/lib/decision-buttons.ts`   | Decision-button protocol: `options` rows → `dec:<token>:<value>` inline keyboard (64-byte callback_data cap enforced), tap parse + label recovery, the answered row is dropped from the message while open rows stay (a multi-question keyboard survives a tap), `[decision] <token> → <label> (<value>)` delivery payload                                                                                                                                                       |
| `src/lib/telegram-settings.ts`  | `braid.telegram` caps reader (`sendMaxChars` 4096, `notifyMaxChars` 1200) from `~/.pi/agent/settings.json`: per-call, safe defaults on missing/invalid input                                                                                                                                                                                                                                                                                                                     |
| `src/lib/notify/craft.ts`       | Turn-complete notify: pure detection (`shouldNotifyTurnEnd`), final-text extraction, distilling prompt (cap injected from settings), guard-fallback at the same cap; `buildRichSummaryPrompts` (live-update rich-report prompt)                                                                                                                                                                                                                                                  |
| `src/lib/notify/rate-limit.ts`  | Sliding-window rate limiter (max N per minute, deterministic timestamps)                                                                                                                                                                                                                                                                                                                                                                                                         |
| `src/lib/notify/model.ts`       | Key-ring-backed crafting model call (completeSimple via `ctx.modelRegistry`, never the bot token) + text-craft hooks for `telegram_send`/`/telegram send` and rich summaries                                                                                                                                                                                                                                                                                                     |
| `src/lib/notify/live-update.ts` | Live-update tracker: `start` (send + persist tracked message, idempotent restart re-pin) / `update` (edit in place) / `finish` (edit → Done, then separate rich summary) / `isActive` / `getState` + state-file persistence                                                                                                                                                                                                                                                      |
| `src/lib/notify/turn-notify.ts` | `turn_end` handler orchestration: detect → rate-limit → craft → deliver (injectable for tests)                                                                                                                                                                                                                                                                                                                                                                                   |
| `test/*.test.mjs`               | Unit tests against recorded fixtures (fake fetch / stubbed client), no network; `test/corpus-runner.mjs` replays the committed adversarial corpus (wire validity, fidelity changes, cap contracts)                                                                                                                                                                                                                                                                               |

## Tests

```bash
npm test                 # emits src -> dist (gitignored), runs all test files
npm test -w pi-braid-telegram   # via the monorepo workspace
npx tsc --noEmit         # typecheck (guardrail build)
```

Coverage: client method extraction & error mapping, param validation, cap
enforcement (settings-driven default + explicit limit), allow-list filtering,
bootstrap, offset confirm-on-read
persistence across restarts and fetch calls, retry-on-injection-failure,
group/non-text rejection, if-has-token guard, inbound/outbound envelope
formats (inbound carries the `[tg-end]` end marker; outbound carries NONE),
default-off poller, poll-enabled opt-in, singleton
poller, `/telegram` command verbs, telegram settings caps (defaults,
overrides, invalid-input degradation, per-call re-read), voice TTS
(`braid.telegram.tts` defaults / `source: "none"` refusal / invalid-input
fallback, script→voice, edge-tts retry, gated say fallback, handoff into the
send path), turn-complete
auto-notify (detection,
rate limit, guard fallback, cap + token-budget injection, key-ring model
resolver, no marker on outbound),
live-update tracked message (start/update/finish idempotency, restart re-pin,
rate limit, finish-not-rate-limited, default-on + `=0` opt-out, trailing-tool gating,
state-file persistence), rich/split-to-fit (paragraph→line→word boundaries,
never mid-word, `(i/N)` markers, 4096 cap sequence, honored parse_mode,
Markdown-balance guard, craft bypass when `rich`),
decision buttons (row/token validation, malformed-row refusal, 64-byte
callback_data cap, generated-token echo, dec: parse/label/format, tap handler
ack + delivery payload, multi-question keyboards keep the open rows after a
tap, voice-path refusal, keyboard on the last rich chunk),
callback routing through the real poller (dec: tap delivered as a whisper,
pause tap persists state, unknown data answered without a crash),
format corpus (`test/corpus.test.mjs` + `corpus-runner.mjs`: 76 hostile bodies ×
3 requested modes, recorded live parse verdicts vs the local checker, the 21-cell
resolution matrix, cap-crossing bodies; `test/live-html-probe.mjs` re-verifies
the checker against the live API, opt-in and never run by `npm test`).

## Live E2E (postponed)

Configure the env vars above, add `packages/telegram` to the pi `packages`
list (like `packages/providers`), then: `testToken` → `telegram_send` a text →
`telegram_inbox` to pull replies (or explicitly `BRAID_TG_POLL_ENABLED=1` /
`/telegram enable` for the background injector). `voice: true` synthesizes
through `braid.telegram.tts` (default: latest edge-tts via uvx, rate +20%,
voices picked by script) → ffmpeg ogg/opus → `sendVoice`; `source: "none"`
disables synthesis, and `voice: true` then returns a clear "no TTS source is
configured" error instead of silently sending text. macOS `say` is the
explicit-config emergency fallback (`source: "say"` or `"edge-tts+say"`).
