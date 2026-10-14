<!-- status: current -->

# Telegram LIVE-UPDATE tracked message + rich formatting: Design Decisions

Status: **current (implemented)**. This list is the decision surface; the fixture
tests in `packages/telegram/test/live-update.test.mjs`, `test/format.test.mjs`,
and the live-update additions to `test/index.test.mjs` / `test/tool-logic.test.mjs`
pin the implemented defaults. Any owner change below is a config/env change, not code.

## Feature recap (the "editing workaround")

The owner's request: _"make tg bot handler to provide live updates via workaround
with ability to edit telegram message constantly. So when pi receives my message
it would immediately send that tracked message and update it constantly, then when
done edit finally that message to 'done' and then send final beautiful message with
summary and report."_

Telegram has **no streaming API** - the workaround is message _editing_: instead of
sending a new progress message per update (which reorders and spams the chat), the
bot sends ONE message immediately on inbound ("⚙️ Working… received your message"),
then re-edits that same message in place (`editMessageText`) as work progresses -
Telegram's edit affordance keeps the message pinned at its original position - and
finally edits it to "✅ Done" plus sends a SEPARATE beautiful markdown summary.

## Decision 1: opt-in vs always-on

**Implemented: default ON; `BRAID_TG_LIVE_UPDATE_ENABLED=0` disables.**
When disabled there is NO live-update behavior at all: no tracked message send, no
`turn_end` finish listener, no state file, no rate limiter. The telegram extension
already requires `BRAID_TG_BOT_TOKEN`; live-update is the only extra gate and it is
on by default.

## Decision 2: the tracked message lifecycle

**Implemented: `start()` → `update()`\* → `finish()`.**

- `start()` (called on every escalated inbound owner message): sends the immediate
  "⚙️ Working… received your message" via `sendMessage`, records the returned
  `message_id` + `chat_id` in-memory AND persists them to
  `~/.pi/agent/braid/telegram-live-update.json` (mirrors `telegram-state.json`
  conventions; `BRAID_HOME` overrides the root) so
  a process reload can resume editing the same message.
- `start()` is **idempotent**: when a tracked message already exists (incl. a
  persisted one from a prior run), it is REUSED via an edit-re-pin - never a
  duplicate send (the "no new-message spam" invariant).
- `update(text)` - public tracker API - edits the tracked message in place,
  idempotent (no-op with no tracked message), clipped to 4096 chars.

_`update()` wiring note:_ the brief explicitly wires `start()` (on inbound) and
`finish()` (on `turn_end`). Periodic mid-turn `update()` calls need a verified
streaming hook that isn't on pi-core's documented extension event surface yet;
`update()` is shipped, tested, and ready to be wired to such a hook later (see
**Follow-ups**).

## Decision 3: finish(): Done-edit + SEPARATE final summary

**Implemented: two steps, ordered.**

1. Edit the tracked message to "✅ Done — full report below." (`TRACKED_DONE_TEXT`).
2. Send a SEPARATE final summary message (not an edit) via `sendMessageChunks`
   (split-to-fit 4096). The summary is **crafted** via the existing key-ring-backed
   craft path (`createRichCraftHook` - `completeSimple` through
   `ctx.modelRegistry`, never the bot token) using a NEW rich prompt
   (`buildRichSummaryPrompts`, rich-markdown variant) that FLAGS the model to use
   Telegram Markdown structure. When no craft hook is available/fit, the raw final
   answer text is delivered instead (still split-to-fit).

The final summary always goes out even if no tracked message survived - the report
is the deliverable.

## Decision 4: finish() gating on turn_end

**Implemented: reuse `shouldNotifyTurnEnd`** (the same predicate the turn-complete
auto-notify already uses, `notify/craft.ts`): finish fires only when the turn ended
with a completed plain-text answer (`stopReason !== "toolUse"`, non-empty text). A
trailing-tool-call turn keeps the tracked message OPEN (work continues next turn).

Note the two features are independent (live-update is default ON, notify is
opt-in, both `turn_end` listeners): `BRAID_TG_NOTIFY_ENABLED` sends its own
separate update capped at `braid.telegram.notifyMaxChars` (default 1200),
`BRAID_TG_LIVE_UPDATE_ENABLED` (default ON)
sends the tracked-message + full report. If the owner enables both, a turn_end
delivers two messages (notify + full report) - an intentional,
documented consequence of the two features staying independent.

## Decision 5: rate limit

**Implemented: sliding window, default 4/min** (`DEFAULT_LIVE_UPDATE_MAX_PER_MIN`),
reusing `SlidingWindowLimiter` (`notify/rate-limit.ts`). Applied to `start()` and
`update()` (progress edits). **`finish()` is NOT rate-limited** - it is terminal and
always attempts its done-edit + summary; a saturated window must not strand the owner
on a stuck "Working…" message. Override via `BRAID_TG_LIVE_UPDATE_MAX_PER_MIN`.

## Decision 6: owner-gate

The tracked message is only ever started from `deliverOwnerMessage` - the SINGLE
inbound escalation seam in `src/index.ts` (shared by the background poller, the
`telegram_poller` tool, and `/telegram enable`), which fires only for allow-listed
owner messages. The inbox agentic-pull tool (`telegram_inbox`) does NOT itself send
messages - it returns structured results for the agent to escalate via core's
`sendUserMessage`, which this package cannot intercept - so wiring there would need a
core-side hook (out of scope; see Follow-ups).

## Decision 7: rich / split-to-fit telegram_send

**Implemented (no breaking change to the default path):**

- `telegram_send` gained optional `rich: boolean` and `parse_mode: "HTML"|"Markdown"`.
- `rich: true` **bypasses** the settings-driven send cap
  (`braid.telegram.sendMaxChars`, default 4096) and the craft hook entirely:
  the text is delivered verbatim via `sendMessageChunks`, split on paragraph→line→word
  boundaries (never mid-word), every chunk carrying a `(i/N)` continuity marker.
  Bodies that ship with `parse_mode` HTML are split **tag-aware**
  (`splitHtmlText`): a cut never lands inside a tag or entity, the tags open at
  the cut are closed at the end of the chunk and reopened at the start of the
  next one, so every chunk parses on its own (the same splitter serves the
  plain-path split when a converted body exceeds Telegram's 4096 cap). A tag
  longer than the cap cannot be represented without cutting it: such a body is
  refused with an explicit over-cap error and nothing is sent.
- Default path (`rich` unset): plain text up to the cap (+ craft hook above it), and
  `parse_mode` is honored on the single send. The conversion is capped at the
  effective limit: when the HTML rendering of a MarkdownV2 body would cross the
  cap (`braid.telegram.sendMaxChars` or an explicit `limit`), the conversion is
  refused and the authored text ships as-is, so the wire never exceeds the cap.
- **Markdown safety net** (`isBalancedMarkdown` in `format.ts`): Telegram's
  `Markdown` parse*mode rejects unbalanced emphasis/link delimiters. When the payload
  has unbalanced `**`/`*`/backtick/`[` `]`, `parse_mode`is dropped and the text is
delivered plain (with a`warn` in the outcome) instead of surfacing an API error.
  HTML has no paired-delimiter rule and passes through. The MarkdownV2→HTML
  conversion is validated against Telegram's HTML parser (`checkTelegramHtml`)
  before it ships: a conversion whose output would cross delimiter pairs or
  emit unbalanced/broken author tags is refused (the authored text ships on
  the unconverted path), so the converter cannot turn a deliverable body into
  an API error.

## Env flags (BRAID*TG*\_ canonical; TELEGRAM\_\_ owner-side aliases)

| Var                                | Purpose                                                 | Default                                       |
| ---------------------------------- | ------------------------------------------------------- | --------------------------------------------- |
| `BRAID_TG_LIVE_UPDATE_ENABLED`     | Live-update tracked message (default ON; `=0` disables) | ON                                            |
| `BRAID_TG_LIVE_UPDATE_MAX_PER_MIN` | Progress-edit rate cap (sliding window)                 | 4                                             |
| `BRAID_TG_LIVE_UPDATE_STATE_FILE`  | Tracked-message state file path                         | `~/.pi/agent/braid/telegram-live-update.json` |

## API surface (new/changed)

- `telegram-client.ts`: `editMessageText(token, chatId, messageId, text, opts?)`,
  `sendChatAction(token, chatId, action?)`, `parseMode` option (`parse_mode` in the
  body) on `sendMessage` + `editMessageText`; `TelegramClient` interface + factory
  updated.
- `format.ts`: `splitLongText(text, maxLen?, reserved?)`,
  `splitHtmlText(text, maxLen?, reserved?)`, `isBalancedMarkdown(text)`,
  `convertMarkdownV2ToHtml(text, {renderedCap?})`, `resolveDeliveryFormat(requested, text, detectMarkdown?, renderedCap?)`,
  `sendMessageChunks(client, {token, chatId, text, parseMode?})`.
- `html-check.ts`: `checkTelegramHtml(text)`, a local mirror of Telegram's HTML
  parser rules (tag set, attribute quoting, span/tg-emoji attribute requirements,
  strict nesting), calibrated against the live API by `test/live-html-probe.mjs`.
- `notify/live-update.ts`: `createLiveUpdateTracker` (start/update/finish/isActive/
  getState) + `loadLiveState`/`saveLiveState`/`clearLiveState` + `defaultLiveUpdateStateFile`.
- `notify/craft.ts`: `buildRichSummaryPrompts` (rich-markdown variant).
- `notify/model.ts`: `createRichCraftHook` (rich-prompt text-craft hook).
- `tool-logic.ts`: `TelegramSendToolParams.rich` / `.parse_mode`; `chunks` in outcome.
- `src/index.ts`: live-update section (tracker + `turn_end` finish listener),
  shared `deliverOwnerMessage` seam, new ENV consts + aliases, updated telegram_send
  tool params + guidelines.

## Tests

Fixture-based, zero network: live-update tracker (start/update/finish/restart/rate-
limit/failure paths), format (split boundaries, markdown guard, chunk markers, cap),
client (editMessageText body + `true` result, parse_mode, sendChatAction), tool-logic
(rich split/honored parse_mode/unbalanced fallback), index (env aliases, disabled-no-
behavior, enabled pins Working… + finishes, trailing tool call keeps open).
Run: `cd packages/telegram && node test/run-tests.mjs` (all files green) and
`npx tsc --noEmit` (clean).

## Forbidden-files check

- No changes to packages/core or packages/providers (incl. provider catalogs).
- No package-lock.json diff, no npm install, no git checkout/reset/stash.
- Scope is entirely inside packages/telegram.

## Follow-ups

- Wire periodic `update()` to a verified streaming hook when one is available, so the
  tracked message updates mid-turn rather than only at start/finish.
- Delivered: an HTML-tag-aware splitter (`splitHtmlText`) keeps rich messages
  with markup spanning chunk boundaries parseable per chunk; a converted body
  that would cross the cap is refused instead of split.
- If agent-driven `telegram_inbox` escalation should also trigger `start()`, that
  needs a core-side hook (sendUserMessage is called from core, not this package).
