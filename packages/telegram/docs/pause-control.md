<!-- status: current -->

# Telegram inline-keyboard pause/resume control: Design Decisions

Status: **current (implemented)**. Fixture tests: `packages/telegram/test/pause-control.test.mjs`
(handler, keyboard, persistence), callback-routing + **pause-gate** additions to
`test/inbound-poller.test.mjs`, and `reply_markup`/`answerCallbackQuery` client additions in
`test/telegram-client.test.mjs`. Pause-gate consumer behavior (inbound held + «⏸ пауза» ack while
paused) is implemented in `lib/inbound-poller.ts` (Decision 6).

## Feature recap

The owner asked: _"Seems need a button for pause or whatever control this through tg"_ - a
button to control the agent from Telegram. This adds an inline keyboard (⏸ Pause / ▶ Resume /
📊 Status) and `callback_query` handling in the inbound poller: **pause** sets the persisted flag
to true, **resume** to false, **status** replies with the current state. Every tap is answered via
`answerCallbackQuery` (toast with the state) and the keyboard is updated in place via
`editMessageText` - paused shows ▶ Resume, running shows ⏸ Pause.

## Decision 1: the pause flag is a CONSUMER signal, not a gate

The module only persists the flag and keeps the keyboard in sync. It **never** blocks the poller,
drops inbound, or changes the core loop. The orchestrator reads the flag via the exported
`getPauseState()` and decides how to honor it. This package stays delivery-neutral.

## Decision 6: the consumer gate lives in the poller

The orchestrator-side consumer behavior is the **pause gate on non-callback inbound**: in
`inbound-poller.ts`, every owner/bootstrap message (text/photo/voice) checks the persisted pause
flag via an injected `getPauseState` reader BEFORE `onOwnerMessage` is called. While paused:

- the message is **not injected** - `onOwnerMessage` / `pi.sendUserMessage` are never called (no
  turn is triggered); the owner is told once with `«⏸ пауза»` + a ▶️ Resume hint;
- the ack is sent **once per paused period** (reply-storm guard), keyed on the period's `updatedAt`:
  `pauseAckUpdatedAt` holds the `updatedAt` of the last acked period, so messages inside the same
  period are held silently and any resume/re-pause transition changes `updatedAt` and re-arms the
  ack for the next period. Not persisted - a poller restart re-acks once (fresh session);
- the held message is still confirmed (offset advances, confirm-on-read) - the owner was acked,
  and after ▶️ Resume the next message flows normally;
- retry-buffer messages are gated too (a queued owner message stays queued while paused);
- **callback_query taps are NEVER gated** - pause/resume/status buttons are the owner's control
  path and are routed to `handlePauseCallbackQuery` even while paused.

DI mirrors the callback handler: `InboundPollerOptions.getPauseState` (default: never-paused, so
unwired pollers are deterministic in tests) is injected by `index.ts` with the real
`getPauseState()` at every `startSingletonPoller` site, so the gate is ON in production whenever
the flag is paused. `sendMessage` (with the poller's `fetchFn`) emits the ack. Config-free: no new
settings/env keys; the gate activates purely on `getPauseState().paused`.

## Decision 2: config via settings, not process.env

No new `BRAID_TG_*` env keys. The state file defaults to `~/.pi/agent/telegram-pause-state.json`
(fixed by the brief) and can be overridden via `braid.telegram.pauseStateFile` in
`~/.pi/agent/settings.json` (mirrors `packages/core/src/lib/config/braid-settings.ts`).
`resolvePauseStateFile()` / `getPauseState()` reflect that resolution.

## Decision 3: atomic persistence

`savePauseState` writes `JSON + "\n"` to `<stateFile>.tmp` then `rename()`s over the target
(write-temp-rename), so a crash mid-write can never leave a truncated state file. `loadPauseState`
reads safely and treats a missing/corrupt file as "not paused". Shape: `{ paused: boolean, updatedAt: number }`.

## Decision 4: callback routing lives in the poller

`getUpdates` already returns `callback_query` updates. The poller routes allow-listed taps to a new
`onCallbackQuery` option (wired in `index.ts` to the pause handler); foreign taps are dropped and
counted (`callbackRejected`), never handed to `onOwnerMessage` - a button tap must not trigger a turn.
Handler failures are requeued and retried next cycle (the retry buffer is now kind-aware:
`"message" | "callback"`). No handler → taps are dropped (offset still advances, confirm-on-read).

## Decision 5: keyboard refresh, idempotent

`handlePauseCallbackQuery` re-reads the persisted state after a transition so idempotent re-taps
(pause while already paused) don't rewrite `updatedAt`, but are still answered and refresh the
keyboard. API failures (answer/edit) are reported in the outcome, never thrown; the flag is
persisted first, so a failed answer never loses the command.

## Decision 7: control-keyboard placement lives at the POLLER-START seam

The owner must actually SEE the ⏸ Pause / ▶ Resume / 📊 Status control - not just have the code exist.
`sendControlKeyboard` was exported but NOBODY called it (code-only). The natural lifecycle seam is
`startSingletonPoller` in `src/index.ts` - the orchestrator-side wiring that constructs and starts the
inbound poller (the entity that owns the poller). On EVERY poller start (env `BRAID_TG_POLL_ENABLED=1`
auto-start at boot, `/telegram enable`, `telegram_poller enable`) it fires a new `placeControlKeyboard`
helper: reads the persisted pause flag via the SAME `getPauseState` reader the poller gate uses, then
`sendControlKeyboard` places the control in the owner chat (`resolveChatId()` - `BRAID_TG_CHAT_ID`, else
the first allow-listed sender, else captured from the first owner message).

Delivery-neutrality is kept: nothing self-sends on import - the FACTORY (the consumer that owns the
poller) places, via a new `onStart` hook on `startSingletonPoller`. When the owner chat is not yet known
at start (no chat-id env and no allow-list - pure first-message bootstrap), placement is DEFERRED
(`placeControlKeyboard` returns `deferred: true`, nothing sent) and fired once when the first owner
message captures `ownerChatId` (`deliverOwnerMessage` → `flushDeferredControlPlacement`, one-shot).
Post-resume correctness is already cheap and unchanged: `handlePauseCallbackQuery` edits the SAME
keyboard in place (`editMessageText`) on every tap, so pause/resume refresh the existing message - no
per-transition re-send/spam.

## Decision 8: placement is a once-per-poller-start, best-effort, DI-able helper

`placeControlKeyboard(chatId, deps)` in `lib/pause-control.ts` reads the flag (DI-able `getPauseState`;
default never-paused) and delegates to `sendControlKeyboard`. Failures are reported, never thrown; a
failed placement is NOT retried (one-shot, logged - avoids side-effect storms). A no-op re-enable (the
singleton is already running) does NOT re-place. Test coverage: `placeControlKeyboard` unit tests
(correct chatId + paused→▶ Resume / running→⏸ Pause, defer on unknown chat, failure reporting) in
`test/pause-control.test.mjs`, plus end-to-end wiring tests in `test/index.test.mjs` (boot auto-start
places into the owner chat; `/telegram enable` places; no-chat bootstrap defers to the first owner
message, one-shot). The boot placement shifts the exact `sendMessage` counts of the live-update factory
tests (they now see the control keyboard as `sent[0]`) - those tests were updated accordingly.

## API surface (new)

- `telegram-client.ts`: `answerCallbackQuery(token, cqId, { text?, showAlert? })`,
  `replyMarkup` option (`reply_markup` in the body) on `sendMessage`/`editMessageText`,
  `TelegramReplyMarkup`/`TelegramSendOptions` types, `TelegramCallbackQuery` on `TelegramUpdate`,
  factory merges per-call options with bound ones.
- `lib/pause-control.ts`: `getPauseState(stateFile?)`, `defaultPauseStateFile()`,
  `resolvePauseStateFile()`, `loadPauseState`/`savePauseState`, `buildControlKeyboard(paused)`,
  `sendControlKeyboard(client, token, chatId, paused)`, `placeControlKeyboard(chatId, deps)`,
  `handlePauseCallbackQuery(deps, cq)`.
- `lib/inbound-poller.ts`: `onCallbackQuery` option; `getPauseState` / `pauseAckText` options
  (pause gate); `PAUSED_INBOUND_ACK_TEXT`; `PollOnceResult.callbacks` / `.callbackRejected` /
  `.paused` (held by the gate).
- `src/index.ts`: wires `onCallbackQuery` into every poller start site (tool command, `/telegram
enable`, env auto-start); wires the real `getPauseState()` as the poller's pause-gate reader;
  re-exports the pause-control public surface for the orchestrator.

## Tests

Zero network: keyboard builder (running/paused buttons), persistence incl. atomic no-`.tmp`-left-behind,
`getPauseState`, `sendControlKeyboard`, handler pause/resume/status/unknown/idempotent/restart/API-failure,
poller routing (owner vs foreign, no-handler drop, retry), pause gate (held + «⏸ пауза» ack + no
injection, once-per-paused-period in-batch and cross-cycle, resume callback ungated + post-resume
delivery, normal flow while running, re-arm on a new paused period, non-fatal ack failure),
`placeControlKeyboard` (running/paused/deferred/failure), poller-start placement wiring (boot auto-start,
`/telegram enable`, no-chat bootstrap defer one-shot), client `answerCallbackQuery` + `reply_markup`
bodies + factory merge.
Run: `cd packages/telegram && node test/run-tests.mjs` (14 files green) and `npx tsc --noEmit` (clean).

## Forbidden-files check

- No changes to packages/providers (incl. provider catalogs), no package-lock diff, no npm install,
  no git checkout/reset/stash, no push.
- Scope is entirely inside packages/telegram.

## Follow-ups

- Telemetry: the gate currently holds (does not queue) paused inbound by design - the owner is acked
  and re-sends after resume. Queue-until-resume would be a behavior change; not planned.
