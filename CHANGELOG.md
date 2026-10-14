<!-- status: current -->

# Changelog

Curated release notes, newest first. This replaces the earlier auto-generated
per-commit dump (5.5k lines). The commit-by-commit record lives in git — the
public `main` is one consolidated commit since the 2026-10-12 consolidation;
the per-iteration series it replaces is archived locally (see "Repository
history" below). Milestones before the 2026-08-29 monorepo snapshot are
summarized below without per-commit references. Deep narrative history is in
[`packages/core/docs/HISTORY.md`](packages/core/docs/HISTORY.md).

Two tag roles, one `v` prefix (adopted 2026-10-11):

- **Core** — legacy `v0.1.1 … v0.39.0`, then the `0.40.0` line: iteration tags
  `v0.40.0-main.N` (package.json `0.40.0-main.N`), release tag `v0.40.0`
  (package.json `0.40.0`). Ordering: `v0.39.0 < v0.40.0-main.1 < v0.40.0`.
- **Providers** — `1.0.x` line; iteration tags `v1.0.x-main.N`.
- **Telegram** — `0.1.x` line; iteration tags `v0.1.x-main.N`.
- **Skills** — `0.2.x` line; iteration tags `v0.2.x-main.N`.
- **Contrib** — `0.1.x` line; iteration tags `v0.1.x-main.N`.

Nothing is retagged retroactively.

## Repository history

`main` carries a single consolidated commit as of the 2026-10-12 consolidation.
The per-iteration series it replaces (380 commits) is kept outside this
repository, in a local-only ref (`refs/archive/main-pre-squash`) plus an
all-refs bundle; a public clone has the consolidated commit only, so a checkout
that needs line history needs access to that local archive. This file and
[`packages/core/docs/HISTORY.md`](packages/core/docs/HISTORY.md) are the
reader-facing record; the tag scheme above applies unchanged.

---

## Core — 0.40.0 / Telegram — 0.1.4 / Providers — 1.0.4 / Skills — 0.2.0 / Contrib — 0.1.0 (2026-10-14: first public release)

The first npm publication: all five packages go out together at the versions
above.

### Core

- **Prerelease tags come from the derivation, and a check guards the pair** —
  `packages/core/scripts/tag-prerelease.mjs` writes the annotated
  `v<derived version>` tag at HEAD, refusing a detached HEAD, a dirty tree, an
  existing tag, a name that is not a version, and a version that does not sort
  strictly above the highest existing `v*` tag. The derivation moves to
  `packages/core/scripts/lib/version-derivation.mjs`, which the publish path
  imports, so a tarball and its tag cannot disagree about the version they
  name; `release:check` joins `ci:check` and validates the tag against
  `package.json` (annotated, agreeing, ordered per semver.org 2.0.0, build
  metadata ignored). The core base moves to `0.40.0`, above the last released
  tag, and the tag scheme is the one recorded at the top of this file.
- **Vision and document tools offloaded to installed packages** — the contrib
  `vision` extension (`analyze_image`) and `read-document` extension
  (`read_document`, `render_pdf_page`) are removed. Image and document
  capabilities come from the installed `@getpipher/vision` (`describe_image`)
  and `pi-docparser` (`document_parse`, `document_search`,
  `document_screenshot`) instead. Every internal reference — the path-security
  read allowlist, the enforcement investigation/routing/probe sets, SOP
  extraction, the task-boundary signal, heartbeat verification sets, browser
  guidance, tool profiles, and the docs — points at the replacement names, and
  the now-unused `pdf-parse` dependency is dropped.
- **Role merge: maxPowerModel folds into utilityModel** — one key, one
  resolver, one auxiliary tier per chain. Every caller chain drops the
  duplicate tier: verify/hypothesize/think try the merged role first, the
  judges and claim extraction keep it as the cheap first tier, and
  `judge-budget` walks session → utility. The classifier's four
  `modelPreference` values collapse to two orders: `quality` (session first)
  and everything else (role first); `max` and `speed` stay accepted but now
  equal `balanced`. The `"max-power"` tier label leaves
  `ClassificationResult` and critic stats.
- **maxPowerModel deprecated alias** — a settings file that only carries the
  legacy key still loads it under `utilityModel` for one release, with a
  once-per-process notice; the first role write removes the legacy key in the
  same settings transaction, and `/max-power-model` set/show/clear operate on
  the canonical key.
- **visionModel deprecated alias** — `resolveVisionModel` keeps its name and
  the legacy key keeps priority for one release. Without it the chain is the
  session model when image-capable → the merged role's first image-capable,
  route-usable entry → the first available image-capable model. The
  `/vision-model` command warns on use and is removed next release.

- **pi 1.2.0 across the family** — the pinned `@earendil-works/pi-agent-core`,
  `@earendil-works/pi-ai` and `@earendil-works/pi-coding-agent` family moves
  to `1.2.0` in the root manifest and the providers package. The
  whisper-delivery branch test re-points its third-branch stub at 1.2.0's
  run-start entry and asserts that entry exists on the prototype before
  stubbing it, so the next rename is a named failure in the fixture instead
  of a stack trace from inside pi-core (`8dd7fd82`, `c6d40853`).
- **Runtime state resolves through the braid root at call time** — every
  writer that folded `os.homedir()` into a module-load constant now resolves
  `BRAID_HOME` (else `<home>/.pi/agent/braid`) per call, so a pin set after
  import is honoured; a relative or blank `HOME`/`BRAID_HOME` is refused
  with the offending variable named instead of creating state inside the
  current project. The write-decision log, episode, scratchpad, semantic,
  orchestrator lock and worker registries, checkpoints, error log, evidence
  pool, degradation state, analytics metrics, hints, workspace snapshots and
  skills-adoption stores all follow; the adherence, telemetry, tags and
  sessions sinks move under the root; the heartbeat report compares
  realpaths for its entry guard; the error-tracking listener drains its
  refused store at warn instead of surfacing an unhandled rejection; and
  readers that can miss (the error list, the semantic load, the adoption
  rollup) degrade instead of throwing (`5bbdb77f`, `eead4ff3`, `30bcb697`,
  `45066f58`).
- **Module toggles persist in braid's store** — a toggle writes
  `braid.modules` to `braidDir()/projects/<project>/module-overrides.json`
  (temp-file-plus-rename, siblings preserved) instead of creating
  `<cwd>/.pi/settings.json` in a stranger's repository. Reads merge pi's
  agent-directory settings file with braid's store, later wins per key; the
  project-scoped `braid.modules` block is no longer a source, because it is
  pi's file behind pi's project-trust gate and that answer is not available
  while extensions load (`5bbdb77f`, `eead4ff3`).
- **State paths are held by checks, not convention** — a new
  `check-write-scope` scan fails the chain on a production write whose
  target can resolve into the cwd unless the call carries a reasoned
  allowlist entry; containment children drive each package's real writers
  under a pinned `BRAID_HOME` and assert the project tree and the default
  HOME tree stay untouched; and the four copies of the braid-root rule
  (core, telegram, providers, contrib) are compared shape by shape, so one
  package's guard cannot drift from the others (`e91ca9d6`, `f14cb5ef`,
  `f029fb35`).
- **Rotation size notice lands at the turn-end flush** — while a run is
  streaming the notice is sent as a park-class steer, so it is delivered at
  the same turn end instead of queuing on the one-message-per-run-stop lane
  (median delivery latency on the session corpus was about 12 minutes, and
  most notices landed after the agent had already acted on them). An
  unresolved-advisory registry, retired by the message append events, keeps
  a second notice of the same kind from stacking, with a 30-minute TTL for a
  lost event and a clean map at session shutdown; the notice body states the
  age rule, so a header stamp older than the last `context_compress` or
  `finalize` reads as already satisfied (`5038b448`).
- **Once-per-session whisper slot claimed before the first await** — the
  guard was read before an awaited delivery batch and written after it, so
  two overlapping prompt builds both delivered every once-per-session
  whisper and a session start could see the hygiene line twice; the slot is
  now claimed synchronously at block entry (`26fd5e0f`).
- **Doc references and instruction strings are derived, then repaired** —
  `check-doc-drift` derives its subject set from the docs' inline code spans
  and resolves every strong identifier against the source, with a
  `doc-ref-exempt` annotation for deliberate mentions and recorded host and
  package names; a new `check-instruction-strings` walk of emitted string
  units fails on a tool name that is not registered, an action outside its
  tool's enum, or an action quoted for a tool with no action parameter. Both
  run inside `ci:check` and print their counts. The pre-existing findings
  were recorded as baselines (seven doc-reference rows, eleven instruction
  rows) and then repaired: the tool descriptions name
  `context_compress(action=archive)` and `context_navigate(action=...)`
  instead of the retired names, and the docs point at the live `signals.ts`
  exports, the `tool_call` event, `ClassificationResult`,
  `setGlobalLogLevel` and `typeRoots` (`195a8c89`, `199883e0`).

### Telegram

- **MarkdownV2 emphasis converts to HTML, one entity per pair** — a body
  carrying `**bold**`, `__underline__`, `~strikethrough~` or `||spoiler||`
  under `parse_mode: "Markdown"` shipped its markers literal, because the
  guard checked delimiter balance rather than dialect; the delivery format
  now rewrites balanced pairs to `<b>`, `<u>`, `<s>`, `<tg-spoiler>` and
  `<code>`, escapes HTML-reserved characters outside author markup and code
  spans, and reports a per-kind conversion count. A `__x__` pair emits `<u>`
  (it used to emit `<i>`, which no MarkdownV2 pair means); unbalanced or
  identifier-like markers stay literal; the parse_mode schema and tool
  descriptions name the legacy dialect and point at HTML; and an over-cap
  render splits to fit instead of failing at the API (`7e649f5c`,
  `22fe46e6`).
- **State root** — media and pause state move from pi's agent directory to
  `braidDir()/telegram`, with a read fallback to the pre-move files; the
  voice download, poller lock, media, pause and live-update defaults resolve
  through the same root and refuse a root that is not absolute
  (`e91ca9d6`, `f14cb5ef`).
- **Peer dependencies declared** — `@earendil-works/pi-ai` (whose `/compat`
  subpath the pinned `1.2.0` exports) and `typebox` join
  `@earendil-works/pi-coding-agent` as peers, matching core and contrib, so
  a strict-layout install resolves every value import the shipped sources
  make (`typebox` had been a devDependency only).

### Providers

- **State files refuse a root they cannot resolve** — the
  `HOME || USERPROFILE || "."` fallback is gone; a base that is not absolute
  is refused and the caller warns or stays in memory instead of writing
  beside the cwd, the presend flush skips with one warn when the root is
  underivable, and the presend root, key ring and route state resolve
  `BRAID_HOME` at call time (`5bbdb77f`, `eead4ff3`, `f14cb5ef`,
  `f029fb35`).

### Contrib

- **State paths follow the package's braid-root mirror** — observatory
  recordings, browser screenshots, the scraping profile, the reconnect lock
  and the healthcheck probes resolve through the mirror and refuse a
  relative or blank home; the healthcheck writers resolve core's live
  `healthcheckDir()` through `pi-braid/lib` instead of binding the default
  at module load, and the report CLI refuses a relative root with exit 2
  (`e91ca9d6`, `f2413cde`, `f029fb35`).
- **`pi-braid` declared as a peer** — the shipped sources import
  `pi-braid/lib` for the shared classifier, the event and session-start
  helpers, `getExtensionState` and `healthcheckDir`; the package now
  declares the dependency instead of relying on the monorepo's tsconfig
  path mapping.

## Core — 0.3.2-main.18 (2026-09-18: configured context window end to end)

Everything since core `0.3.2-main.17` ships in this release; telegram is
unchanged at `0.1.4-main.3`.

### Core

- **Configured context window enforced end to end** — the configured cap
  (`braid.context.contextLimitTokens`) is plumbed into the session model at
  run start so pi-core's own threshold compaction and overflow detection
  execute the cap; the turn-end act's deterministic slide fires regardless
  of `compaction.enabled`; the single pending-compaction slot became a
  bounded drain-and-coalesce queue that keeps archive anchors; one shared
  token formatter across whispers, context_inspect, and tool feedback; and
  read-only surfaces read other extensions' state through the real session
  store (`6dfd3f67`).
- **Memory write gate** — a review-before-write predicate now fronts the
  episode writers: signal-free tasks are rejected, dead solution fields are
  repaired from the task, and exact/near-repeat (task, solution) pairs are
  deduped against recent episodes (`32de2aba`, `5c319a77`, `2a5ef5fe`).
  Configurable via `braid.memory.writeGate` (enforce/warn, per-site opt-outs);
  an append-only write-decision log plus metrics and junk-scan scripts make
  gate health measurable (`0b1aa6c9`, `cd5e2387`).
- **Recalled memory fencing** — memories recalled into a session are fenced
  as non-user context, so stored notes can no longer masquerade as operator
  instructions (`f76c2d80`).
- **Context management** — live context usage is measured per turn and acted
  on before sessions grow (`698c168e`); compactions only run when the agent
  loop is done (`84b3fad9`); slide and archive move the live working set
  (`7dc0eb25`); a manual compaction is a full stop — the queued flush replay
  is held and swallowed so no assistant turn resumes from pre-compaction
  input (`7203dd73`).
- **Prompt identity refresh** — senior-craft wording, new
  PLACEMENT_DISCIPLINE and SELF_AUDIT blocks, policy sections relocated
  (`0a5246ba`); scanner-clean self-audit wording (`803a45ae`); mirror guard
  and result schema in worker identity (`b66f69ef`).
- **Orchestrator tooling** — worker registry with atomic writes and a
  duplicate guard (`f1bd20ca`); structured worker lifecycle actions and a
  check-worker verdict (`312e7cb7`); the verification judge gained a
  self-state claim class — delivery/liveness claims must cite a probe,
  honest hedging stays exempt (`dad58772`).
- **Skills** — settings-driven session profiles and a boot hint
  (`5226e368`); one-shot skills-boot whisper (`7b8fdad6`); new
  probe-evaluation, misdirection-audit, and placement-discipline skills
  (`3832df99`); the skills package joined the local publish pipeline
  (`6f6b6b66`).
- **Timer recovery scoped to the owning session** — persisted-timer
  restoration no longer crosses session boundaries (`7d3c6f89`).
- **Classifier empty-label fix** on reasoning-capable session models
  (`7e0813f6`); edge/WAF challenge-page dumps redacted from internal request
  bodies (`959ce4e0`).
- **Coverage** — root typecheck and lint now cover all four code packages,
  with surfaced findings fixed (`103f7e79`); dead verification module
  dropped (`c7d5ace1`).
- **Hygiene** — whole-tree private-data scan (`1929e02b`); placement checker
  for provenance tokens, domain literals, and home paths (`8a1b408c`);
  session provenance stripped from comments, tests, and docs, with
  comment-discipline and commit-subject rules added to CONTRIBUTING
  (`599ae15f`); knip dead-code detector adopted report-only (`737f6363`).
- **Docs** — compaction message-loss investigation preserved as a historical
  record (`050e80f9`); skill/suite counts drift-proofed (`61b35d1e`,
  `b6b80f8d`); setup requirements and security policy corrected
  (`9d9b166f`).

### Telegram

- **Voice STT hardening** — an ordered key pool (explicit key, `BRAID_TG_STT_KEYS`, macOS keyring, env candidates) advances on 401/403/429 and quota-class failures and remembers the winner; transcription is bounded to two passes with an ffmpeg-amplified retry; the chat-mode model default moved to a stable performer; the failure line carries diagnostics, never key material (`38bb5ba6`).
- **Long-by-default owner messages** — settings-driven caps replace the one-size truncation (`e8190b4b`).
- **Awareness catalog honesty** — the TG inbound row reports the live poller state instead of asserting unconditional reachability (`82bd2f83`).

### Providers

- **OpenRouter removed** — venice (a0 proxy) is the only registered provider (`bc672e35`).
- **Reasoning-model fixes** — thinking "off" maps to wire-level none (`fcb3e4d9`); developer-role-incompatible qwen backends are marked per model (`0656aa36`).
- **Venice catalog robustness** — cost is always emitted as a finite number so unpriced models can't break the usage path (`0ec40974`).

## Core — 0.3.2-main.17 / Telegram — 0.1.4-main.3 (2026-09-11: swallow-catch triage, dead-export removal, poller self-heal)

- **Swallow-catch triage** — 176 repo-wide swallow sites triaged to zero unexplained; 4 real silent persistence failures now logged (timer savePendingTimers/persistTimerToDisk, enforcement tag persist, budget double-swallow), 39 boilerplate catch comments upgraded to real whys (`fccfef81`); **dead-export removal** — 68 unreferenced exports deleted across 35 files, −717 lines (`6f0daebb` + `ae7a05d4`/`22036a12` follow-ups).
- **Poller self-heal across reloads** — pi-core emits session_shutdown on every agent-session reload; the telegram poller now survives it (intent flag + session_start re-arm) and telegram_send warns when the inbound poller is off at send time (`2937941e`).

## Core — 0.3.2-main.16 (2026-09-11: scanner HOME hardening, legacy-comment cleanup)

- **Scanner HOME hardening** — `check-private-data` throws on missing HOME, providers typescript pin aligned to 6.0.2 (`5f404c82`); **legacy-comment cleanup** — deleted legacy echo comments and step narration from `src/**`, shrinking the shipped dist (`ffd3f2df`).

## Core — 0.3.2-main.15 (2026-09-11: wake-retry hardening, wake-window proof, publish-readiness fixes)

- **Wake-retry hardening** — wake outcome timeout 60s→240s; redelivery deferred during
  pi-core auto-retry via bounded `retryHoldUntil`; wake attempts capped 5→3 with
  `braid.timers.maxWakeAttempts` setting; wake-gate arms on idle input only (`1b0cfed1`).
- **Wake-window proof** — empirical stress fixture (407 lines) proving the prompt-entry
  wake window closed under load: no lost wake, no double delivery, no cross-run leak, hold
  semantics verified. Scheduling pi-core-independence audit: 10 paths INDEPENDENT, 1 ADAPTED,
  2 accepted tested invariants; zero code changes required (`498b3a73`).
- **Publish-readiness** — core tarball: dead `CHANGELOG.md` files entry removed, `docs/`
  now shipped; skills catalog corrected 23→27 in README/AGENTS/SETUP (`effd859e`).

## Telegram — 0.1.4-main.2 (2026-09-11)

- **telegram_send description rewrite** — 1659→983 chars, decision-first with worked
  examples; targets concise-path misprediction (7 mispredicts observed 2026-09-10) (`c22f79c7`).

## Core — 0.3.2-main.14 (2026-09-09: skills rollup, judge chunked evidence, WAF excerpt redaction, surface discipline)

- **Skills rollup** — claimed-vs-actual load counters split, `scoreSkill` retuned,
  needs-refresh descriptions refreshed (`e47e1036`); durable per-session adoption
  records + monthly adoption-rate rollup split worker|orchestrator (`334afdd4`).
- **Judge chunked evidence** — RLM-style chunk summaries for task evidence beyond
  the cap (`955ce1c2`).
- **WAF excerpt redaction** — Venice WAF challenge-page excerpts stripped from
  stored history and the warn sink (`c8255b33`, providers-side `ring-lifecycle.ts`).
- **Surface discipline** — `SURFACE_DISCIPLINE` identity block with lockstep test
  and slop diff-scanner shadow (`bed9b39a`).

## Core — 0.3.2-main.13 (2026-09-05: prompt-builder hygiene + stale-toolResult offloader)

- **Prompt-builder hygiene** — the resources catalog section collapsed to a `list_skills` pointer,
  memory-section counts removed, threshold literals cut from the prompt (they live in the owning
  config), and herdr tool one-liners gated behind herdr availability (−1001 chars baseline).
- **Stale-toolResult offloader** — new `braid.context.staleToolResultOffload` setting, **default
  OFF**: stale tool results are offloaded losslessly to disk and replaced in-context by a stub;
  idempotent and bounded.
- **Hermetic test re-baseline** — 97/97 suites pass with temp-HOME fixtures (no dependence on the
  live agent home).
- **Durable skill adoption counters** — per-skill suggested/loaded counts + lastAt persist across
  sessions in `skills-usage.json`; `skill_stats` gains an all-time section; best-effort writes that
  can never break the suggestion path.
- **Prettier drift cleared repo-wide**; `format:check` added to `ci:check` (root and core);
  config-example documents both context settings (`contextLimitTokens`, `staleToolResultOffload`).
- **Telegram voice STT 401 fix** — chat-mode STT now derives its default baseUrl from the
  userland venice catalog (`venice-catalog-base-url.ts`, mirroring the providers reader) so the
  deployed gateway-era `A0_VENICE_API_KEY` pairs with the gateway that accepts it;
  `BRAID_TG_STT_BASE_URL` still wins, transcriptions mode unchanged.
- **Small-correctness batch** — `prompt_inspect` includeTools/includeSkills now actually
  exclude their sections in braid-composed prompts (the old patterns never matched the braid
  prompt shape and always reported "0 lines removed"); `v2raytun_reconnect`'s rendered one-liner
  no longer truncates mid-sentence; the watchdog tunnel canary probes `getMe` on getUpdates
  failure so sibling-consumer conflicts no longer bark tunnel-down at healthy pollers;
  `context_inspect` surfaces last-compaction loss counters (compacted → kept) in the loss line;
  `context_compress` deep_clean feedback reports an estimated cut like archive/slide.

---

## Core — 0.3.2-main.12 (2026-09-04: config-tunable context limit)

A config-tunable context limit — `braid.context.contextLimitTokens`
(in `~/.pi/agent/settings.json`) caps the effective window braid computes against, while the
provider catalog keeps model truth. One pure resolver (`resolveContextLimitTokens` /
`getResolvedContextWindow` in `lib/config/braid-settings.ts`) owns the precedence: owner cap →
model/provider window → caller default; invalid values are ignored with a once-per-process
warning. All three window consumers read through it:

- **Density evaluator hardcode fixed** — the fast density path divided by a hardcoded 100k
  window and fired density triggers ~3x too early at a 262k window; it now uses the resolved
  effective window (100k only when neither the cap nor the provider window is known).
- **Percent math honors the cap** — context tiers and percent-of-window gates divide by the
  effective window, so percent advisories stay meaningful under an owner cap instead of
  referencing a window the owner has deliberately shrunk.
- New config test `test-context-limit-config.mjs` covers resolver precedence and consumer
  wiring.

---

## Core — 0.3.2-main.11 (2026-09-03: token-gated advisories, heartbeat self-state, rollback guard)

Token-gated advisories plus a heartbeat self-state line, fixing three confirmed production
findings from long-session audits — most importantly that percent-of-window gating is
unreachable on 1M-token windows, where a measured session fired zero high-context advisories
across 154 turns at 150-238k tokens. The agent's self-identity now states honesty explicitly:
"an honest self-aware agent with a metacognitive suite and extras on top of pi."

- **Token-gated advisory path** — the context-lifecycle proposal real-need gate and the
  urgent-bypass were percent-of-window only; at a 1M window they are unreachable. Gates now
  open on EITHER arm — percent (sub-1M windows) or tokens (min(percent, token) semantics):
  actionable at ≥ USAGE_TOKENS_CRITICAL (100k), urgent at ≥ HYGIENE_AUTO_COMPACT_HARD_BACKSTOP
  (140k), escalated wording (archive-or-handoff) at ≥ new USAGE_TOKENS_ESCALATE (200k) — single
  owner context-thresholds.ts. The compact-nudge message and the context-manager audit
  recommendations / branching trigger carry the same token arms. Acting path (auto-compact
  ACT ladder) untouched.
- **Heartbeat self-state line** — every heartbeat summary (tick batcher and the delayed-flush
  builder) gains ONE ≤40-token self-state line right after the clock:
  `self-state: ctx 213K tok · cache 96% · dup 39 · tps-ema 87`. Context tokens are a live read;
  cache-hit share (cacheRead/(input+cacheRead)) is captured per assistant message and lands in
  the context-heartbeat JSONL telemetry; near-duplicate count comes from the density evaluator;
  tok/s trend is the existing EMA. An unavailable metric renders `n/a`, never zero.
- **Auto-rollback test-debug guard** — new `lib/detection/test-burst.ts`
  keeps a bounded per-session ring of tool outcomes fed from the enforcement tool_result handler
  and classifies test-runner bursts (runner commands, pass/fail counts, assertion errors).
  autoRollback — the single DECISION point — now withholds the destructive rewind when the burst
  is test-dominated (≥3 errors, every one test-marked, ZERO non-test failures) and downgrades to
  whisper-only: the degradation advisory still fires (heartbeat + enforcement paths),
  degradation state is not cleared, and genuine degradation with non-test errors rolls back
  exactly as before.
- **Tests (metric pinning)** — `test-advisory-token-gate.mjs` (source scan: advisory gates
  reference token constants; functional: proposal fires at 20%/120k tokens, suppressed at 20%/80k,
  urgent at ≥140k), `test-heartbeat-self-state.mjs` (line format, n/a tolerance, summary
  integration, cache telemetry), `test-test-burst-rollback-guard.mjs` (classifier cases,
  suppression on test-dominated bursts, no suppression when errors span non-test tools,
  autoRollback end-to-end both ways).

---

## Core — 0.3.2-main.10 (2026-09-03: time-awareness)

One owner-timezone clock for everything braid renders, plus the telegram truncation contract
and inbound timestamps. Companion telegram release `0.1.4-main.1`.

- **One local-time formatter** — new `lib/utils/local-time.ts`:
  `formatLocalTime()` renders `HH:MM TZ (UTC±X)` (with optional `YYYY-MM-DD` date) in
  the owner time zone — `braid.timezone` in settings.json, default `Europe/Moscow` —
  and `formatWhisperClock()` renders the compact `HH:MM TZ` header form. Fixed-offset
  abbreviation map (MSK, YEKT, …) because CLDR renders Europe/Moscow as "GMT+3". Every
  braid-facing time string now routes through it; the scattered
  `toLocaleTimeString()` call sites (timer set/list text, timer-reminder "Fired at:")
  are gone.
- **Whisper header timestamps** — the central envelope builder
  `formatWhisperEnvelope()` (whisper-format.ts) renders
  `[braid-whisper - <subsystem> @ 17:05 MSK]`, so every `sendTrackedMessage` whisper
  and the telegram inbound builders carry the generation/send clock: the agent can
  tell a fresh whisper from a stale re-injection. A source-tree scan test pins that
  no hand-built envelope literal can bypass the formatter.
- **Fresh clock** — every heartbeat summary (both builders) prepends
  `now: <YYYY-MM-DD HH:MM TZ (UTC±X)>`; the prompt-builder gains a 30-minute datetime
  drift guard: when >30 min have passed since the last datetime anchor, a one-line
  `datetime-refresh` whisper re-anchors the clock (the re-anchor IS the rate limit —
  exactly one refresh per window). Fixes long sessions reasoning on a
  session-start-stale clock.
- **Timer honesty** — timer fire text now reads
  `set for 16:58 MSK (UTC+3), fired 17:05 MSK (UTC+3) — drift 7m`; the
  set-confirmation and `timer list` render the owner-TZ wall clock with the date.
- **Reachability catalog** — the once-per-session hygiene whisper gains a
  6-channel "can reach you" block (enforcement whispers, heartbeat, watchdog, timers,
  context-lifecycle proposals, TG inbound) with rough cadences, ≤80 tokens.
- **Identity reword** — IDENTITY_INTRO now reads "You are Braid, a
  self-aware agent with a metacognitive suite and extras on top of pi"; README
  taglines match.
- **Telegram truncation contract (telegram 0.1.4-main.1)** —
  `telegram_send` gains explicit `limit` (chars) and `strategy` ("truncate" | "error")
  params. Over-limit WITHOUT an explicit choice now errors to the agent (stating the
  limit + the options: rich:true / shorter text / explicit strategy) — the silent hard
  truncation fallback is gone (zero silent truncations; the crafting distillation
  stays). An explicit `strategy: "truncate"` is the only hard-truncate path and skips
  crafting; `rich:true` split-to-fit is unchanged. Tool description states the limits
  explicitly.
- **Telegram inbound timestamps** — `TelegramUpdate.date` now renders as
  `@ HH:MM TZ` in the `[braid-whisper - telegram]` header of BOTH inbound builders
  (poller + agentic inbox), using the telegram-local mirror of the core formatter
  (the package cannot import core — established watchdog-tunnel mirror pattern;
  parity pinned by its own test).
- Version bump: `0.3.2-main.10`. Telegram version: `0.1.4-main.1` (corrected: a
  `0.1.3-main.1` would have been a semver downgrade from `0.1.4-main.0`).

---

## Core — 0.3.2-main.9 (2026-09-03: context-hygiene enforcement)

- **Real heartbeat telemetry** — the heartbeat tick fed
  `recordTurnMetrics` constants (`avgTurnDurationMs: 1000`, `inputTokens: 0`,
  `memoryUsagePercent: 50`); the entire degradation pipeline ran on
  placeholders. New `lib/telemetry/context-heartbeat.ts` collects live
  context tokens/percent/window (`ctx.getContextUsage`), RSS + heap,
  session-file size, per-class char deltas since the previous tick (density
  walk), injected-whisper pressure, and tokens/sec from the assistant
  message window — one append-only scalar-only JSONL line per tick at
  `~/.pi/agent/braid/telemetry/context-heartbeat.jsonl`. A second hook emits
  the same line on the watchdog engine's wall-clock cadence so idle processes
  are covered. Sink failures are non-fatal; entries are scalar-whitelisted at
  the boundary.
- **Watchdog flap latch + escalation budget** — preserved the
  owner-endorsed first-bark wake-up; killed the repeat storm (measured:
  143 escalations, 55 byte-identical, 33.6k chars = 5.1% of peak context).
  A transient close no longer re-fires the threshold bark nor resets the
  milestone ladder; re-arm requires a 3-consecutive success streak (healthy
  evaluations or LLM successes). A per-session per-condition injection
  budget (12, `WATCHDOG_ESCALATION_BUDGET_PER_SESSION`) leaves only the
  500-milestone rung active once exhausted. Tunnel recovers via its genuine
  `up` event (explicit success); turn-stall's long-cooldown behavior is
  unchanged.
- **Token re-arm for turn-end auto-compact** — the 15-turn
  cooldown allowed 190-415k-token regrowth between compactions (measured
  peaks 191-261k). The turn-end ACT now re-arms whenever tokens ≥ 100k and
  ≥ 3 turns passed since the last attempt, plus an UNCONDITIONAL hard
  backstop at ≥ 140k tokens (`HYGIENE_AUTO_COMPACT_HARD_BACKSTOP`) that
  ignores all spacing — bounds runaway single-tool-result growth. Pre-save
  resume.json + compact mechanics untouched.
- **Auth/balance health recovery** — `recordLlmSuccess` never
  cleared the `auth`/`balance` modes and the probe tick only fired on
  errors, so one 401 burst latched a session forever and heartbeat
  consolidation was skipped permanently (live: the orchestrator session
  latched auth ~19 minutes). Both modes now clear via a bounded probe
  (5-min quiet window → next success proves recovery; a fresh 401
  re-latches instantly — initial escalation NOT weakened) or a 10-success
  streak. New `consolidationSkipsByMode` counter on SessionHealthState
  tracks skipped consolidations per mode.

---

## Core — 0.3.2-main.8 (2026-08-29: pre-publication polish)

- **OOM crash fix (2026-09-01 hotfix)** — pi-core 0.84.4 removed
  `settingsManager` from ExtensionContext; the degradation-detector
  `isCtx()` guard keyed on it, so every heartbeat tick treated the ENTIRE
  ctx object as a metrics entry — embedding the full session graph AND the
  modelRegistry (credentials) into `degradation.json` until
  `JSON.stringify` exceeded the V8 string limit ("Invalid string length")
  and processes grew to multi-GB heaps overnight. Fix: ctx detection now
  keys on `sessionManager`/`modelRegistry` (present in both old and new
  pi-core); metrics entries are built by a scalar WHITELIST copy instead of
  spreading the argument; async-storage refuses to serialize state files
  above 10MB (skips with a loud error instead of OOM-ing); regression test
  `test-degradation-ctx-guard.mjs` pins all three invariants. The polluted
  87MB→525MB `degradation.json` was purged (it also contained live API keys
  — credential sprawl closed).

- **Tool-instruction ownership inversion** — per-tool inventory lines resolve
  by priority: the tool's OWNING package `promptGuidelines` (pi-core native
  seam) → static `TOOL_GUIDELINES` (strategy-only `when / when-not / key
args / caveat` one-liners for all 32 documented tools, synced 1:1 with
  `TOOLS.md` via lockstep test) → `EXTERNAL_TOOL_GUIDELINES` last-resort map
  for unpatched third-party packages (herdr, pi-smart-fetch) → first sentence
  of the tool's own description. No duplication with description text.
- **SKILLS_LOADING strategy contract** — pointer rule (catalog
  one-liner is metadata, not content), mid-task re-list trigger (paginated
  catalog), never-act-from-memory rule, and an explicit when-not test.
  Mechanics (offset clause) deduplicated into the `read` guideline.
- **Telegram double-message fix** — agent-delivery flag: explicit
  `telegram_send` marks the message delivered; live-update `finish()`
  suppresses its auto summary when flagged (`0.1.3-main.0` companion).
- **Watchdog tolerance widened** — poll timeout 30→50 s, `tunnelFailures`
  3→5 (config-overridable).

## Core — 0.3.2-main.7 (2026-08-27)

- prompt-builder archaeology debloat — removed dead whisper/pointer material.
- Compaction originals archive is fully lossless and append-only.
- Telegram inline-keyboard pause/resume landed in the same release.
- Companion telegram release 0.1.3-main.0 shipped together.

## Core — 0.3.2-main.1 … 0.3.2-main.6 (2026-07-27 → 2026-08-25)

- **Monorepo migration** — all five packages (`core`, `skills`, `contrib`,
  `providers`, `telegram`) under npm workspaces; 333 duplicate root files
  removed.
- **API key ring** — generalized multi-key provider rotation with exponential
  backoff, persisted exhaustion state, and self-healing turn retry.
- provider registration rewritten on `createProvider` + request-time key-ring
  auth resolution.
- prompt-builder overhaul — discovery stance, tool-usage pipelines, and a
  once-per-session awareness whisper.
- **Compaction upgrades** — speaker attribution and sliding-window compaction
  (`action=slide`).
- **Skills verdicts applied** — KEEP/IMPROVE/DEPRECATE/MOVE from the
  skills-usage research, with freshness markers.
- `packages/lib` retired into `core/src/lib`; `packages/telegram` added as a
  workspace.

## Core — v0.3.x (v0.3.0 → v0.3.2, 2026-07-23 → 2026-07-25)

- Versioned **local publish pipeline** (`publish-local.mjs`) — `base-branch.iteration`
  scheme, auto-reverts the version bump.
- **v0.3.2** release plus a compact >70% release guard.
- Definition-of-Done invariant and turn-end hygiene/discoverability
  improvements.

## Core — legacy v0.1.1 … v0.39.0 (2026-04-17 → 2026-05-15)

The pre-monorepo line that built the foundation. Highlights:

- Repo carved out of the pi-mono/pi-braid lineage (2026-04-13).
- **Native `web_fetch` + CDP browser automation** with zero external deps.
- Typed **event bus** for cross-extension signals — proactive context
  projection and analytics.
- **Three-memory-stores** — episodes / semantic / heuristics deep merge with
  cross-search and session recall.
- prompt-builder decomposed into `PromptSection` fragments + pointer blocks;
  behavior-modes system dropped for static identity invariants.
- Skills reorg across core/contrib/pack boundaries and contrib split out then
  re-merged.
- pi-ai v0.80 compat — Models-instance holder replaces direct child access.

---

## Providers — 1.0.4-main.1 (2026-09-09: WAF excerpt redaction)

- **WAF excerpt redaction** — Venice WAF challenge-page excerpts no longer reach
  stored history or the warn sink (`c8255b33`); direct-call warn excerpts redacted
  and the self-heal test synthesizes its WAF body (`63782887`); release bump to
  `1.0.4-main.1` from flat `1.0.3` (`e6d9f984`).

---

## Telegram — 0.1.4-main.0 (2026-09-01)

- **Idempotent edit fix** — `editMessageText` treats Telegram's 400
  "message is not modified" as success instead of warning (re-tapping the
  pause-control status button is a no-op, not a failure); regression test
  added.
- **Poller/inbox discipline in promptGuidelines** — `telegram_inbox` and
  `telegram_poller` now carry the getUpdates-singleton rule: while the
  poller runs, manual inbox calls conflict (expected, not a bug); the
  owner's `/telegram enable|disable` commands own the same singleton —
  never blindly re-enable over an explicit disable.

## Telegram — 0.1.x (0.1.0 → 0.1.3-main.0)

- **0.1.0** — bidirectional channel: fetch-based client, `telegram_send`
  tool, inbound long-poll injector.
- **0.1.1** — release refresh.
- **0.1.2** — voice inbound + STT; photo inbound.
- **0.1.3-main.0** — inline-keyboard **pause/resume** control.
