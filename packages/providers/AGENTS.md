# pi-braid-providers: LLM provider registration

Tiny, focused extension. Registers an LLM provider with `pi` and injects provider-specific parameters on requests to known Venice models.

## Setup

```bash
npm install
```

This installs `@earendil-works/pi-coding-agent` (devDep for types) and
`@earendil-works/pi-ai` (devDep for types + peerDep for runtime). The pi
runtime provides pi-ai at runtime - it's not bundled here.

## Files

| File                | Purpose                                                                                                                                                                         |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.ts`          | Registers the configured routes + wires the key-ring and rotation handlers                                                                                                      |
| `venice-catalog.ts` | Userland catalog seam: loads the owner-private venice model catalog + gateway URL                                                                                               |
| `venice-direct.ts`  | The `venice-direct` route module: constants, direct key ring, model configs (rotation is the engine's job)                                                                      |
| `probe.ts`          | Non-billable route probes: the provider-agnostic runner plus the adapter table                                                                                                  |
| `outage-watch.ts`   | Out-of-loop connectivity watch: failure classification, circuit breaker, bounded recovery probe, stall lines                                                                    |
| `route-state.ts`    | Cross-session route state (probe/death/fail-back/warm-model records) over a shared, CAS-guarded file                                                                            |
| `state-paths.ts`    | Every state-file location this package writes: pi's agent directory, absolute-or-nothing (never relative to the cwd), plus the braid data root that mirrors core's `braidDir()` |
| `ring-health.ts`    | Read-only health surface over the key-ring and route-state files: hash-only summaries, never a writer                                                                           |
| `ring-provider.ts`  | Ring-backed api-key auth, and the re-pointing of a pi-ai provider definition onto a route's ring                                                                                |
| `package.json`      | `@earendil-works/pi-coding-agent` + `@earendil-works/pi-ai` devDeps, `pi-ai` peerDep                                                                                            |
| `tsconfig.json`     | TypeScript config for type checking                                                                                                                                             |

## Local contracts

- **Standalone extension:** no other contrib deps. Resolved via `@earendil-works/*` from npm.
- **Silent failures are forbidden:** if a provider registration fails, log it loudly. Don't `try { registerProvider } catch {}`.
- **Provider IDs are stable:** `agent-zero` (the registered id when the userland
  catalog exists - renamed from `a0` by owner directive; owner configs update
  at republish), `venice-direct` (the route over
  Venice's own API, same registration condition), and `braid` (the virtual-only
  namespace of the health-routed `auto` entry - no physical models, no route;
  sessions persist `braid/auto`). User configs reference the registered ids -
  renaming breaks users silently. The generic key-ring plumbing
  is provider-agnostic; tests may register synthetic routes via
  `registerRoute`. The ordered route table (`braid.providers.routes`) is the
  single source of rotation order: on a ring death the engine in
  ring-lifecycle.ts walks it and engages the first route that is not the dead
  one, has a usable key, and can serve the dead turn's model id. With no
  `routes` key the default pair (`agent-zero`, `venice-direct`) applies.
- **One key source per route.** Every route in the table resolves its key from its own ring. A route this
  package builds itself (`agent-zero`, `venice-direct`) does so by construction; a route served by pi-ai's own
  first-party provider definition is re-registered with its api-key auth re-pointed at the route's ring
  (`ring-provider.ts`), so no route needs a bare env var beside its `_P0.._P9` slots. The definition is
  reused whole - models, base URL, headers and the api dispatch with its per-provider stream wrappers come
  through untouched, and only `auth.apiKey` changes. A ring with no keys falls back to a stored credential
  (the `/login` path) and then to nothing; a ring with keys outranks the credential.
- **The virtual model never translates its own id.** The health-routed entry
  (`auto`) picks a route for the logical model the request asks for: the
  physical model the session was on when it has one, else the configured
  `defaultModel`. A configured base that IS the virtual id - or is absent -
  resolves through the route table instead (the id the most routes serve, ties
  by first appearance in `braid.providers.routes`), so no request is ever
  dispatched to the virtual model itself. The ids come from the table, never
  from a literal in the router. One entry is registered per seat: `braid/auto`
  when this build carries the agent-zero route (the auto route spans several providers,
  so its entry lives under this package's own `braid` namespace instead of
  borrowing the gateway route's id), and `opencode-go/auto` when the route
  table names that provider (the composition root names it; nothing in the
  router does). Each entry's collision check reads its own provider's physical
  model list, so a provider that later ships a physical `auto` skips only its
  own entry, with one diagnostic naming the collision. The `braid` namespace is
  virtual-only - this package registers no physical model under it, so its
  list is empty by construction.
- **No dynamic model discovery at runtime:** the model list is built from the
  userland venice catalog file (owner-private, absent from the public tree).
  Adding a model = editing the catalog file, not this package.
- **Venice parameter injection follows the route descriptor:** the `before_provider_request` handler applies the Venice payload tweak only when the registration table attributes the body's model id to a route whose descriptor sets `venicePayload`. Its other job is deliberately route-independent: every string in the outgoing body leaves with the edge filter's request-side trigger neutralized (a space inserted, text kept readable), because the shared gateway host blocks on body content and not every route reaching it sets the flag. Nothing in the request path names a provider or a built-in model-id literal.
- **Domain literals live in one table:** the probe runner (`probe.ts`) is provider-agnostic - a
  provider id, a status-endpoint URL path or a response field name belongs in the adapter table
  there, or in the owner's `braid.providers.routes` config, and nowhere else. `route-state.ts` is
  colder still: it stores one opaque record per provider id and interprets nothing.
- **The health reader is read-only and provider-blind.** `ring-health.ts` is the read side of the
  two state files: it knows their schemas because it lives beside the writers, but it hardcodes no
  provider id (every id is an argument or is discovered from the files), never writes, locks or
  migrates, and copies only the named hash and counter fields. A reader that could write would be a
  second writer, which is the failure it exists to rule out. A consumer outside this package imports
  it; nothing in `packages/core` does, because the dependency runs from the consumer to this
  package, never the reverse. It is also not a second opinion: the rendering takes the resolved
  death window from its caller and marks a recorded death `(expired)` with the router's own
  predicate (`deathInForce`), never with an age test of its own.

## Settings surface

`state-paths.ts` owns every state-file location this package writes: pi's agent
directory (`homedirAgentDir()`, or `piAgentDir()` where `PI_CODING_AGENT_DIR`
was already honored) and the braid data root the `presend` flushes use
(`braidDataRoot()`, core's `braidDir()` mirrored). Neither falls back to a
relative path: a base that cannot be resolved absolutely comes back as `null`,
each writer refuses to write without it, and the presend guard skips its flush
with one warn instead of writing beside the cwd.

`~/.pi/agent/settings.json` (owner-owned, read-only here) is read fresh on
every consultation through ONE reader - `readProvidersSettingsFromSettings`
(ring-lifecycle.ts): one file walk, each block validated by its own resolver
(`routes` by `resolveRoutesConfig`). Absent/invalid blocks resolve to `null` /
an empty map. Route diagnostics and the `routes`-vs-legacy transition warnings
are returned by the reader and emitted once per throttle window at
`session_start` (`emitProvidersSettingsDiagnostics`).

| Key                          | Shape                                                                                                                                                                                                                                                                 | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `braid.providers.fallback`   | `{ "provider": "<id>", "model": "<id>" }`                                                                                                                                                                                                                             | **Deprecated.** No longer drives any rotation; the settings reader still resolves it so it can name the legacy key in the routes-transition diagnostic. Ignored when `routes` is set.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `braid.providers.lastResort` | `{ "<source provider id>": "<leg provider id>" }`                                                                                                                                                                                                                     | **Deprecated.** No longer drives any rotation; the same routes-transition diagnostic names it. Ignored when `routes` is set.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `braid.providers.routes`     | `[ { "provider": "<id>", "keys": "<ENV_PREFIX>", "modelIds"?: ["<model id>"], "models"?: { "<dead model id>": "<provider model id>" }, "venicePayload"?: <boolean>, "probe"?: { "url": "<status url>", "authHeader"?: "<header>", "balanceFloorUsd"?: <number> } } ]` | Ordered route table: array order is the rotation order. `provider` and `keys` are required non-empty strings; `provider` must be unique within the array; `modelIds` is an optional list of extra model ids attributed to the route (trimmed, non-empty); `models` is an optional dead-model-id → provider-model-id map; `venicePayload` is an optional boolean switching the Venice payload tweak on for this route; `probe` is an optional non-billable status capability (`balanceFloorUsd` is a non-negative finite number, absent ⇒ the probe layer's default). An invalid entry is skipped and named in a diagnostic (index + field). Present ⇒ it is the only rotation source and the legacy `fallback`/`lastResort` keys are ignored (one warning). Absent ⇒ the default pair (`agent-zero`, `venice-direct`) applies and ONE warning names the replacement shape. Attribution is configuration, not a built-in literal: the table holds exactly the configured routes, and the request path recognizes a route by the model ids it declares (`modelIds` plus the provider ids its `models` map resolves to) and shapes its payload only when that route sets `venicePayload`. Defaults for a configured route: `modelIds` empty, `venicePayload` false. |
| `braid.providers.outage`     | `{ "enabled"?: <boolean>, "failures"?: <int>, "windowMs"?: <ms>, "probeIntervalMs"?: <ms>, "probeTimeoutMs"?: <ms>, "stallMs"?: <ms>, "notifyFloorMs"?: <ms> }`                                                                                                       | Outage-watch thresholds, read once at extension load (defaults: enabled, 3 failures, 5 min window, 60 s probe interval, 3 s probe budget, 10 min stall window, 60 s notify floor). Every field is validated on its own; an invalid or absent field keeps its default. `failures` consecutive connectivity failures inside `windowMs` open that route's circuit breaker (stream/streamSimple then fail fast with the watchdog verdict until a probe passes); `stallMs` is how long one session's LLM attempts must keep failing before its stall line. Absent block ⇒ code defaults; no env vars.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

When a route carries `probe`, ONE probe runs at extension registration
(fire-and-forget, never awaited) and its outcome is recorded in
`~/.pi/agent/.provider-route-state.json`, so the next session inherits what
this one observed. A route without `probe` is never probed - the default
routes carry none, so a config that does not opt in behaves exactly as it did
before probes existed.

A recorded outcome carries the route's `state`, its `remainingUsd` (the
endpoint's own remaining figure: Venice's `balances.USD`, OpenRouter's
`limit_remaining`), any spend/cap/reset the shape reports, and a `reason` when
it could not read a healthy state. A route whose status document reports a
spendable USD balance is classified against `probe.balanceFloorUsd` (default
`1`): above the floor is `ok`, at or below it but above zero is `degraded`,
and zero or below is `unavailable`. A route whose shape reports no balance is
classified on headroom alone, exactly as before.

`braid.providers.fallback` and `braid.providers.lastResort` are retired: they
no longer drive any rotation. The settings reader still resolves them so the
`routes`-transition diagnostic can name the legacy keys; the ordered
`braid.providers.routes` array is the only rotation-order source. When `routes`
is absent the default pair (`agent-zero`, `venice-direct`) applies, plus one migration
warning at session start.

## Outage watch

A transport outage (a gateway/tunnel storm, hung requests) used to spend
pi-core's whole turn-retry budget while nothing reached the owner, because the
held agent loop cannot run the in-session whisper path. `outage-watch.ts` is
one out-of-loop watcher per extension load:

- **Classification.** A failure counts as connectivity-class only when it
  reports a transport idiom (timeouts, socket/DNS errors, HTTP 5xx) and is not
  an outcome another subsystem owns (key quota/auth/403, rate limit, edge/WAF
  page, payload/context window, abort). Throttle and payload classes keep
  their existing behavior exactly.
- **Breaker.** `failures` consecutive connectivity failures inside `windowMs`
  open the route's breaker. While open, the dispatch registered for that route
  throws the watchdog verdict instead of re-sending: it names the route, the
  failure count, the first-failure time, the next probe time, and the owner
  alert status, in wording outside pi-core's retryable vocabulary, so the turn
  ends instead of re-running into the outage. One half-open call per
  `probeIntervalMs` decides recovery: success closes the breaker, failure
  re-arms the interval. Non-connectivity deaths leave the breaker untouched.
- **Probe.** While open, a bounded GET of the route's own base URL (one
  attempt, `probeTimeoutMs`, any answer below 500 counts as reachable) closes
  the breaker on success; recovery never needs a restart. Routes with no base
  URL recover through the half-open real call.
- **Notifier.** Transitions are published to the Telegram channel through the
  process-global slot the telegram package writes
  (`__braid_provider_outage_notify`, the same seam pattern as
  `WATCHDOG_TG_SIGNAL_KEY`); an absent slot logs the fact and the breaker text
  says so. Down and recovery messages are transitions only, and each claims a
  machine-global floor record (`.provider-outage-notify.json`) first, so a
  fleet sharing one host produces one owner message per transition. A failed
  send releases the claim.
- **Stalls.** A tracked session whose LLM attempts keep failing without a
  success for `stallMs` gets one log line and one Telegram line per episode,
  so a stuck fleet is visible even while every turn is held.

## Adding a new model

1. Find the model in the provider's catalog (the owner-private venice
   catalog file - not in this package).
2. Add an entry there with id, name, contextWindow, cost, and any
   provider-specific compat flags (e.g., `requiresReasoningContentOnAssistantMessages`).
3. Run `npm run typecheck` to verify.

## Verification

- `npm run typecheck` for syntax and type checking.
- `npm test` runs the fixture-driven suites, including `test/probe.test.mjs`
  (probe runner + adapter table + route plumbing, offline) and
  `test/route-state.test.mjs` (read tolerance, hash-only identity, lock + CAS),
  and `test/ring-health.test.mjs` (the read-only health surface: read
  tolerance, entry mapping, provider discovery, path defaults, read-only),
  and `test/outage-watch.test.mjs` (failure classification, breaker
  transitions + half-open gate, blocked-text retry vocabulary, notify claim
  floor, stall lines, config resolution - all with injected clock, probe and
  sender).
- Manual: load pi with this extension, switch the model (`/model`), confirm the new entry is registered.

## Migration status

The migration target is `pi.registerProvider()` (old compat API) to
`createProvider()` + `setProvider()` on the pi-ai `Models` instance. <!-- doc-ref-exempt: pi-ai migration target, not shipped here -->

**Current stance: defer to pi-core.** The compat path works today. The cleanest
migration requires pi-core to expose a `ModelRegistry.getRegisteredProviders()`
API so pi-braid's loader can sync custom providers to the Models instance after
all extensions load - with zero coupling between pi-braid and any provider extension.

Until pi-core adds this, `pi-braid-providers` continues using `pi.registerProvider()`;
the migration waits on that API, not on a local change.
