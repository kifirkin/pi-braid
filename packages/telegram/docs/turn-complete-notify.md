# Turn-Complete Auto-Notify: Design Decisions

<!-- status: current -->

Status: **pending owner sign-off**. This list is the deliverable-1 surface; the
fixture tests in `packages/telegram/test/notify.test.mjs` pin the implemented
defaults. Any owner change to a default below is a config/env change, not code.

## Feature recap

When the agent finishes a turn with a completed plain-text answer (no trailing
tool call), a SECOND LLM call (the "crafting model") distills the answer into
an owner update capped at `braid.telegram.notifyMaxChars` (default 1200) and
sends it over Telegram through the SAME
outbound seam as `telegram_send` / `/telegram send`. The `[tg-end]` marker is
an INBOUND parse boundary only and never appears on outbound.

## Decision 1: which turns notify

**Implemented: completed-answer turns only.**
`shouldNotifyTurnEnd(event)` notifies iff the `turn_end` message is an assistant
message with non-empty text AND `stopReason !== "toolUse"`. A `toolUse`
stopReason means the model's last action was a trailing tool call (work
continues next turn) → no notify. This satisfies the brief's "NO crafting when
last tool call trailing".
Rejected alternatives:

- _Always_ (every turn, including mid-work tool turns) - would spam the owner.
- _Quiet-window_ (only during owner-defined quiet hours) - no owner-supplied
  quiet-hours config exists; OBE once the owner defines one.
- _Per-session opt-in_ (agent decides each session) - the agent is the one
  being notified about; it should not be the gatekeeper.

## Decision 2: opt-in vs always-on

**Implemented: opt-in via `BRAID_TG_NOTIFY_ENABLED=1` (default OFF).**
No unsolicited messages until the owner enables it. The telegram extension
already requires `BRAID_TG_BOT_TOKEN`, so this is the only extra flag. When the
flag is off, the `turn_end` listener is NOT registered at all (verified by
`test/index.test.mjs`).

## Decision 3: utility vs max-power model

**Implemented: session model by default, env override wins.**
`resolveNotifyModel()` (notify/model.ts): `BRAID_TG_NOTIFY_MODEL`
(`provider/model-id`) → else `ctx.model` (session model) → else first available
registry model. The call is key-ring-backed: the API key comes from
`ctx.modelRegistry.getApiKeyForProvider(provider)`, which
pi-braid-providers wires to the key-ring (`ring-lifecycle.ts` auth.resolve →
`getActiveKey`) - never the bot token.
Note: core's `/utility-model` role key (`/max-power-model` is a deprecated
alias of it) lives in core's global-state (unreachable from the standalone
telegram package without a cross-package import). The env override is the
telegram-native equivalent.
Owner call: if honoring the /utility-model role key is required, that needs the
core-extension placement (Architecture B) instead - documented as a follow-up.

## Decision 4: rate limit

**Implemented: sliding window, max 4/min by default.**
`SlidingWindowLimiter` (notify/rate-limit.ts), override via
`BRAID_TG_NOTIFY_MAX_PER_MIN`. Deterministic by explicit-timestamp `try(now)`.
Sliding window (vs fixed minute) so a turn at 59.9s does not immediately reset.

## Decision 5: content template

**Implemented: distilling prompt** (`buildNotifyPrompts` in notify/craft.ts):
"state what was done / key result, ≤ `braid.telegram.notifyMaxChars` chars
(default 1200), plain text, no greetings/no
sign-off/no markdown; reply DONE if no actionable content." The crafting model
produces the message; `truncateGuard` (same cap, ellipsis) is the guard-fallback
when crafting fails or returns something malformed. The model's output budget
scales with the cap (`craftMaxTokensFor`) so a long target is not cut mid-sentence.

## Decision 6: telegram_send / /telegram send reuse the same seam

`runTelegramSend` gained an optional `craft` hook. When text exceeds the
settings-driven send cap (`braid.telegram.sendMaxChars`, default 4096), the
crafting model produces the message (replacing the old dumb truncation);
the cap stays as the guard threshold. Short text skips crafting
(no model call). `/telegram send` now routes through `runTelegramSend` -
the exact same outbound path - so crafting, cap fallback, and
no-[tg-end] behavior are shared.

## Placement decision (why telegram, not a new core extension)

The brief leaned "a new small extension under packages/core/src/extensions/"
but allowed "or a new extension" with "read how existing extensions register
listeners and mirror it". Chosen: the notify feature lives in the TELEGRAM
package because:

- It owns the outbound seam + client/token/chatId - deliverable 3 ("same
  outbound seam") is literal, with zero cross-package coupling.
- It already registers pi.on listeners in its factory (16f pattern); a
  `turn_end` listener mirrors it exactly.
- The alternative (core notify extension + delivery sink registered by
  telegram) requires a telegram→core import. It works today via the workspace
  symlink but is a phantom dependency and makes the telegram test chain depend
  on core's dist being freshly built - fragile under the "no package-lock diff"
  gate. Avoided.
- The crafting LLM call reuses "our systems": `completeSimple` from
  `@earendil-works/pi-ai/compat` (the exact path core's llm-call.ts wraps at
  llm-call.ts:50) + `ctx.modelRegistry` for model + key-ring key.

## Forbidden-files check

- No packages/providers source changes by this task (a pre-existing,
  unrelated working-tree modification was left untouched).
- No package-lock.json diff, no npm install, no git checkout/reset/stash.
- No changes to packages/core or packages/providers source.
