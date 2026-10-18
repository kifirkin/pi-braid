<!-- status: current -->

# Context Policy: Window, Reserve, Bands, Caps, Archiving

The numbers that decide when braid nudges, offloads, archives, or lets pi-core
compact. Each has one owner (a constant or a setting); this page names it.

## The window

`braid.context.contextLimitTokens` is the window every braid surface computes with:
usage math, density, fallbacks, pi-core's threshold compaction and overflow
detection, the TUI footer. It is a ceiling over the provider window: the
polyfill plumb hook reports `min(contextLimitTokens, true model window)` to the
session model on session start (startup, resume, fork, `/reload`) and re-applies
it at `before_agent_start`, so a mid-session model switch is re-plumbed and a cap
above a model's true size never widens it; only an unknown true window takes the
cap alone. Unset, the provider catalog's true size stands.

## Usage bands

| Band           | Fires at | Effect                                                 |
| -------------- | -------- | ------------------------------------------------------ |
| soft, advisory | 30%, 50% | inspect and start tracking; light pruning, archive     |
| warning        | 65%      | tag → checkout → archive pipeline                      |
| critical       | 75%      | immediate hygiene, high priority                       |
| compact 80/90  | 80%, 90% | auto-compaction, medium then aggressive aggressiveness |

Alongside the percent ladder, a token ladder arms at fixed shares of the resolved
window: 0.18W soft, 0.30W advisory, 0.45W warning, act min(0.60W, 130k), 0.85W
escalate, 0.90W backstop; a fired-threshold set clears below 50%. The act is the
one arm with an absolute ceiling, so it stops rising with a window raise; percent
arms fire late on large windows, which is why both ladders exist. `CONTEXT_COMPACT_REFUSE_PERCENT`
(70%) is a hard ceiling for LLM-supervised compaction, not a trigger: above it
`context_compress(action="compact")` refuses and redirects to deterministic slide
mode, guarding against max-call-stack crashes and session corruption at high
usage; hygiene acts re-arm at most once every three turns.

Owner: [`src/lib/detection/context-thresholds.ts`](../src/lib/detection/context-thresholds.ts)
(single home; consumers import, never restate).

### Usage-driven slide compaction

| Setting                            | Default                                              | Effect                                                                                                                                                                                                                | Read cadence                                        |
| ---------------------------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `braid.context.contextAutoCompact` | `{ enabled: true, armPercent: 60, confirmTicks: 2 }` | When live usage stays at or above `armPercent` for `confirmTicks` consecutive heartbeat observations, queues one deterministic slide for the next turn boundary. Set `enabled: false` to turn off this automatic arm. | Re-read at use time, on each heartbeat observation. |

Owner: [`src/lib/config/braid-settings.ts`](../src/lib/config/braid-settings.ts); auto-arm runs in [`src/extensions/memory/context-manager/handlers/tools/context-compress.ts`](../src/extensions/memory/context-manager/handlers/tools/context-compress.ts).

## The compaction reserve

pi-core fires native threshold compaction when `contextTokens > contextWindow −
compaction.reserveTokens`: raw counts, never percents, default reserve 16384.
Untouched, that fixed count re-anchors the trigger to an arbitrary share of a
plumbed window. Braid derives the reserve instead - `window − 75% of window` on
the same ceiling window the plumb wrote or kept, floored at 16384, the floor
doubling as the budget for the post-compaction summary request pi-core caps at
80% of it. The value cannot be written into pi-core from an extension (no
writable settings handle; `pi.getSettings()` returns a copy), so the derivation
surfaces as a once-per-process warning (`applyCompactionReserveTokens`) naming
the value to set; nothing is saved to `settings.json`, and it is
recomputed on every run start: it is a derived invariant of the window, not an
owner setting; a hand-set reserve whose trigger lands outside the 65%..80% band
logs an incoherence warning once per process. Owner:
[`src/lib/config/braid-settings.ts`](../src/lib/config/braid-settings.ts), applied
from [`src/extensions/core/polyfill/index.ts`](../src/extensions/core/polyfill/index.ts).

## Caps and offload

| Setting                                                                                               | Default                             | Effect                                                                                                                                     | Read cadence                                                       |
| ----------------------------------------------------------------------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| `braid.context.toolResultSizeCap` (`enabled`; `maxChars`: `braid.context.toolResultSizeCap.maxChars`) | `enabled: true`, `maxChars: 262144` | Set `enabled: false` to turn off this cap. Results above `maxChars` are flushed losslessly to disk and replaced by a stub naming the file. | Re-read at use time on each tool result and offload recovery call. |
| `braid.context.staleToolResultOffload`                                                                | OFF                                 | Age/size offload of stale large results (`minChars` 4000, `stalenessTurns` 40, `keepRecentTurns` 20, 65536/run).                           | Re-read at use time.                                               |
| `braid.context.contextEmergencyOffload`                                                               | ON                                  | On a context-window (413) error: offload the largest results, then retry once (`minChars` 262144, 1048576/run).                            | Re-read at use time.                                               |

Offloaded payloads land at `<braid home>/offload/<sessionId>/<toolName>-<toolCallId>.txt`
(`offloadDir()` / `getOffloadFilePath` in
[`src/lib/config/braid-paths.ts`](../src/lib/config/braid-paths.ts)); the stub names
the path, so retrieval is a plain `read` and the flush is lossless.

## Archiving and compaction tools

| Tool                | Use                                                                                                                                                                       |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `context_inspect`   | health/usage audit before acting (`quick`, `detailed`, `full`, `prune`)                                                                                                   |
| `context_compress`  | `compact` (drop obsolete/duplicate entries), `archive` (range → topic summary, tag-based bounds), `deep_clean` (tag + archive + compact), `slide` (deterministic, no LLM) |
| `context_navigate`  | `tag` before archiving, `log` history, `checkout` to a leaf                                                                                                               |
| `context_proposals` | list, approve, or reject auto-generated proposals                                                                                                                         |

`context-lifecycle` automates the same tools: on `turn_end` it detects approaching
limits, evaluates a proposal through its policy engine (token budget, cooldown,
cost-benefit), and either injects a `propose` entry or auto-executes; same-type
proposals are debounced for five turns. Owner:
[`src/extensions/memory/context-lifecycle/AGENTS.md`](../src/extensions/memory/context-lifecycle/AGENTS.md);
what compaction loses: [`COMPACTION-LOSS-INVESTIGATION.md`](COMPACTION-LOSS-INVESTIGATION.md) (historical).
