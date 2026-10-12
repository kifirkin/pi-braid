<!-- status: forward-looking -->

# Roadmap

Active roadmap for pi-braid. Shipped milestones are listed for context; open
items live under [On the horizon](#on-the-horizon). Anything marked shipped is
verified in the current codebase - see [`HISTORY.md`](HISTORY.md) for the
dated, commit-verified timeline.

> This is a modest, current roadmap, not an exhaustive plan. The full
> commit-by-commit history lives in git; deep narrative is in `HISTORY.md`.

---

## Shipped milestones (condensed)

The current codebase is the result of the following waves. Dates and hashes
are reproduced from `git log` in [`HISTORY.md`](HISTORY.md).

- **Feedback + event bus** - native `web_fetch` + CDP browser automation with
  zero external deps; proactive context projection and analytics events on a
  typed event bus.
- **Three-memory-stores** - episodes / semantic / heuristics deep merge with
  cross-search, sessions, and project-scoped isolation.
- **Prompt architecture** - prompt-builder decomposed into `PromptSection`
  fragments + pointer blocks; behavior-mode system replaced by static identity
  invariants; discovery-stance and tool-usage pipelines (sprints A–D).
- **Monorepo migration** - all 5 packages under npm workspaces
  (`core`, `skills`, `contrib`, `providers`, `telegram`); `packages/lib`
  retired into `core/src/lib`.
- **Compaction** - sliding-window compaction, speaker attribution, and a
  lossless append-only originals archive.
- **Providers** - generalized API key ring (multi-key rotation, exponential
  backoff, persisted exhaustion state) + the venice (agent-zero proxy) provider.
- **Telegram channel** - bidirectional channel, photo + voice inbound with
  STT, inline-keyboard pause/resume.
- **Release pipeline** - versioned local publish (`publish-local.mjs`) and the
  `0.3.x-main.N` / `0.1.x-main.N` iteration scheme.

## On the horizon

Open backlog themes, roughly in priority order. None of these are commitments -
they are the current working set. Rows marked RESOLVED are kept for
provenance; they are no longer work.

1. **Providers de-reference (P10b)** - RESOLVED: the Venice registration is a
   userland catalog seam (`providers/venice-catalog.ts`, resolved from
   `$VENICE_CATALOG_FILE` or `~/.pi/agent/venice-models.json`); the provider
   registers only when that catalog exists, and `check-private-data` scans the
   whole tree in `ci:check`.
2. **Version-drift cleanup** - RESOLVED: the four workspace packages declare
   the pi peer as `"*"`; the root manifest pins the installed version
   (`package.json`, the `@earendil-works/*` deps).
3. **Tag-scheme unification** - RESOLVED: two tag roles under one `v` prefix, recorded in
   the root `CHANGELOG.md` - iteration tags `v0.40.0-main.N` (`package.json`
   `0.40.0-main.N`), release tag `v0.40.0`.
4. **CI private-data gate** - RESOLVED: `check-private-data.mjs` is a CI step
   and scans the whole tree by default (tracked plus untracked); the
   staged-file checks are a local pre-commit convenience.
5. **Skills pack** - finish validating the six skills still marked
   `verdict: UNVALIDATED` (`braid-reference`, `misdirection-audit`,
   `placement-discipline`, `probe-evaluation`, `v2raytun-reconnect`,
   `voice-replies`); keep the pack catalog fresh as decision rows land.
6. **Extension surface** - ongoing de-bloat of tool/extension counts;
   subagent-RPC hardening. Worker-stats reporting shipped (`list-workers`
   `includeStats`); the orchestrator's metrics-emission half (writing
   `METRICS_FILE`) is still open.

### History-sweep candidates

From a full sweep of past orchestrator sessions (ideas voiced but dropped).
One step further out than the list above - none are commitments, each needs an
owner go before a wave. Full sourced notes live in the project's private
knowledge base.

7. **Bound + persist in-memory accumulators (P11)** - RESOLVED:
   `lib/utils/bounded.ts` owns the bounded tail (`pushBounded`), adopted at
   the per-turn accumulator call sites. Effort M.
8. **Small-correctness batch** - RESOLVED: the `prompt_inspect` exclusion is
   pinned by `test-prompt-inspect-exclusion.mjs`; the watchdog tunnel-counter
   canary is a getMe-based liveness probe
   (`telegram/src/lib/inbound-poller.ts`); the v2raytun status description is
   complete in the shipped skill. Effort S.
9. **Cross-provider fallback on quota death** - RESOLVED: the route-order
   engine walks to the next route, with bounded turn-level fail-back
   (`providers/index.ts`) and WAF repeat-block rotation
   (`providers/ring-lifecycle.ts`). Effort M.
10. **Key-ring persistence/mutation rewrite** - RESOLVED:
    `mergeFromDiskIfNewer` + `withLockedMutation` + a `lastSyncedRev` CAS
    write (`providers/key-ring.ts`) reconcile persisted state with live
    mutation. Effort M.
11. **Slop P2 cleanup** - PARTIAL: `extractJson` now lives once in
    `lib/utils/extract-json.ts`; the dead-export half shrank further in the
    dead-weight sweep; `check:deadcode` exists but is not yet a `ci:check`
    step; the swallow-catch residual is unchanged. Effort M.
12. **Self-measurement → degradation loop** - OPEN: the sense substrate is
    live (heartbeat, watchdog, analytics); the automatic worker spawn is not
    built - auto-recovery still raises a whisper. Effort M.
13. **Dreamer/BPE fold-or-kill** - RESOLVED: the dreamer's loop path is
    folded into the single enforcement loop emitter (it still records advice,
    delivers no loop whisper); pinned by
    `test-loop-emitter-consolidation.mjs`. Effort S/M.
14. **Telegram inbound file attachments** - RESOLVED: document inbound is
    wired through `telegram/src/lib/document.ts` (inbound poller). Effort M.
15. **Continual-harness self-refinement** - OPEN, owner-gated: the
    `session_before_refine` trigger has no hits in the installed pi build,
    so the upstream seam is not present to build on. Effort L.
