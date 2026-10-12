# pi-braid-providers

Additional LLM providers for `pi-coding-agent`, built on a generalized **API key ring** for multi-key rotation and self-healing.

The `providers` workspace registers providers into pi at session start. The key-ring machinery that both the agent loop and direct extension LLM calls use ships here; the provider itself is the **`agent-zero`** setup: the multi-vendor gateway that proxies Venice's models, configured from a catalog file resolved at runtime.

> **A fresh install registers no provider.** The `agent-zero` model catalog
> (Venice's models) and gateway URL are read from a userland catalog file
> resolved at runtime (see `venice-catalog.ts`) that this package does not
> include. Without it the extension loads with the key-ring machinery active
> and zero registered providers; a synthetic route can be registered through
> `registerRoute` (`ring-lifecycle.ts`), the seam the test suite uses for its
> multi-route coverage.

## The key ring

Each provider gets its own key ring with **exponential backoff**:

- **Multi-key rotation.** Keys load from `${PREFIX}_P0` … `${PREFIX}_P9` in the
  environment, falling back to the bare `PREFIX` var when no numbered keys
  exist. On a quota/auth/403 error the active key is exhausted and the next
  request serves the next healthy key.
- **Persisted state.** Exhausted-key state persists to
  `~/.pi/agent/.key-ring-state-<provider>.json`, so restarts skip known-dead
  keys instead of retrying them and hitting the same 403.
- **Self-healing turn retry.** When a turn fails and a fresh key remains, an
  explicit marker is appended so pi-core re-runs the turn on the next key
  automatically. Fatal account-level errors (quota exhausted, billing, balance)
  are never masqueraded as retryable.
- **Direct-call feedback.** Direct extension LLM calls (an extension's own
  `completeSimple`/`streamSimple` use)
  feed 429/403 back into the ring too, so no dead key is served on those paths.
- **Diagnostics.** Rotation/exhaustion events route through a throttled notify
  sink (not `console.*`); a loud _all-keys-exhausted_ warning fires when every
  key is in backoff.

## Installation

```bash
pi install npm:pi-braid-providers
```

Or register the workspace in `~/.pi/agent/settings.json`:

```json
{
  "packages": ["file:~/pi-braid/packages/providers"]
}
```

## What this does not do

- It does not ship a provider catalog. The `agent-zero` model list and gateway URL are read from a
  catalog file resolved at runtime; without it the extension loads the key-ring machinery and
  registers zero providers.
- It does not rotate to a route you did not configure - a route is recognized only by the model ids
  it declares.
- It does not retry a fatal account error (quota exhausted, billing, balance) as if it were transient.

## Activation preconditions

- `AGENT_ZERO_API_KEY` (or the numbered `AGENT_ZERO_API_KEY_P0`-`P9` rotation keys) set.
- A userland catalog file for the `agent-zero` route; otherwise zero providers register and only a
  synthetic route (via `registerRoute`) can serve traffic.

## Environment variables

```bash
AGENT_ZERO_API_KEY=<your-agent-zero-gateway-key>
# Optional: multiple gateway keys for rotation
AGENT_ZERO_API_KEY_P0=<key-1>
AGENT_ZERO_API_KEY_P1=<key-2>
```

Env vars are resolved at request time by the key ring (`auth.apiKey.resolve`).
`warnBelowKeyCount` (default 4) surfaces keys-remaining on each rotation so
you know when to top up.

## The two routes

When the userland catalog exists, two providers register:

| Provider id     | Serves             | Via                                                 | Key prefix           |
| --------------- | ------------------ | --------------------------------------------------- | -------------------- |
| `agent-zero`    | Venice's models    | agent-zero gateway (`https://llm.agent-zero.ai/v1`) | `AGENT_ZERO_API_KEY` |
| `venice-direct` | The same model ids | Venice's own API (`https://api.venice.ai/api/v1`)   | `VENICE_API_KEY`     |

`agent-zero` is the primary. On any registered route's key-ring death (a quota/auth/403 error that leaves its ring with zero usable keys), the **rotation engine** (ring-lifecycle.ts) walks the ordered route table and engages the first route that is not the dead route, has a usable key, and can serve the dead turn's model id - directly (a shared id) or through its `models` map. The order is `braid.providers.routes` (`[{ provider, keys, modelIds?, models?, venicePayload? }]`), array order being the rotation order; with no `routes` key the default pair is `agent-zero` then `venice-direct`, so an `agent-zero` death still falls over to Venice's own API. The table is the only attribution source: a route is recognized by the model ids it declares (`modelIds` plus the provider ids its `models` map resolves to) and takes the Venice payload tweak only when it sets `venicePayload` - off by default for a configured route, on for the default pair. A route the owner did not configure is neither routed to nor shaped. Exactly one rotation per episode: the engage swaps the session model for the retrying turn and emits one owner-visible whisper. A bounded fail-back probe (`FAILBACK_PROBE_INTERVAL_MS`, 10 min) re-checks the dead route at most once per interval at `turn_end` boundaries; when it recovers the session fails back automatically (one fail-back whisper) and the engage re-arms. State is in-memory per extension load; `session_start` resets the engine.

## Health-routed entries (`auto`)

A route can carry a virtual entry selectable as `<provider>/auto`: one model
that answers each request with the first healthy route in the configured order,
so a per-spawn route decision becomes a per-request one. The auto route spans
several providers, so its entry lives under this package's own `braid`
namespace: `braid/auto` exists whenever this build carries the agent-zero route;
`opencode-go/auto` whenever the owner's route table names that provider -
`opencode-go` sits ahead of the gateway in the live table, so a session that
starts there leaves by the health walk instead of by hand. The entry declares
no context window, max tokens or input types (pi reads those from the physical
model that answered) and never dispatches its own id: a request with no
previous physical model resolves its base id from the route table, or from the
configured `defaultModel`, and the thinking level is resolved against the
target model's own map. A provider that already ships a physical `auto` skips
its own entry with one diagnostic, so a virtual entry can never shadow a real
model.

## Route probes and cross-session state

A route may declare a non-billable status capability in the ordered route table:

```json
{
  "provider": "venice-direct",
  "keys": "VENICE_API_KEY",
  "probe": {
    "url": "https://api.venice.ai/api/v1/api_keys/rate_limits",
    "balanceFloorUsd": 1
  }
}
```

When present, one probe runs at extension registration - a plain GET at the
declared URL with the route's own key as a bearer token, never an inference
call - and the outcome is recorded per route in
`~/.pi/agent/.provider-route-state.json`: the last probe, the last recorded
death (its key identity as a hash, never the key), the fail-back target and the
warmed model ids. A later session reads that file instead of re-learning it.
The probe never throws, never rotates a key and never starts a billable call;
the write is lock- and CAS-guarded exactly like the key-ring state, because
every pi process on the host shares the file.

A recorded outcome carries the endpoint's own remaining figure as
`remainingUsd` (Venice's `balances.USD`, OpenRouter's `limit_remaining`), so no
consumer has to derive remaining by subtracting a monthly figure from a cap. A
route whose status document reports a spendable USD balance is classified
against `probe.balanceFloorUsd` (default `1`, owner-configurable per route):
above the floor is `ok`, at or below it but above zero is `degraded`, and zero
or below is `unavailable`. A route whose status endpoint answers 200 while the
account has no spendable balance therefore no longer reads as healthy.

Two rules keep the layers honest:

- **The runner is provider-agnostic.** Which provider ids exist and what their
  status responses look like lives in ONE adapter table in `probe.ts`. A
  provider absent from it is reported unavailable rather than guessed at.
- **The state store interprets nothing.** It writes down an opaque record per
  route and reads it back; the probe vocabulary and the death classes belong to
  the layers that produce them.

A route without a `probe` descriptor is never probed. Absent probes, resolution
and rotation are unchanged.

## Ring and route health

`ring-health.ts` is the read side of those two files: it summarizes them for a
human or a consumer script without writing, locking or interpreting anything, so
"which keys are in backoff, and what did each route last look like" needs no
knowledge of either store's write protocol.

- `ringHealth(providerId, { stateDir?, file? })` reads one ring file
  (`~/.pi/agent/.key-ring-state-<provider>.json`, or an explicit path).
  `{ provider, present: false }` means no file, or one this reader cannot
  trust; otherwise it carries `rev`, `savedAt`, `activeIndex` and one entry per
  key: `{ exhausted, exhaustedAt, retryCount, exhaustedBy, keyHash }`.
- `routeHealth({ stateDir?, providers?, routeState? })` reports every route it
  can see - the ids the caller names, the routes the route store already
  carries, and the providers with a ring file - as
  `{ provider, ring, lastProbe, deathClass, deathAt, failback, warmModels }`.
  Facts the route store has not recorded come back as `null`, `0` or `[]`.

Four rules hold the reader to its layer:

- **Read-only.** No write, no lock, no migration. The stores own the one write
  protocol; a reader that could write would be a second one.
- **Hash-only.** The ring file holds `hash`, never the key, and the reader
  copies named fields instead of forwarding the document - so a value the ring
  never wrote cannot leak through here.
- **Provider-blind.** Every provider id is an argument or is discovered from
  the files; none is hardcoded, so a configured route table needs no code
  change here.
- **Tolerant, never throwing.** An absent file is the normal empty state and
  stays silent; a malformed, partial or wrong-version file is the same
  `present: false` plus exactly one diagnostic.

The reader takes its file paths from its caller or derives them from the
provider id; it writes no state file of its own and reads the route document
through `route-state.ts`'s reader. Nothing in `packages/core` imports it: an
external consumer imports the package, never the other way round.

`formatRingHealth(routes, freshness)` and `summarizeRouteHealth(routes, freshness)`
turn a report into the `ring_health` tool's text and its `details` payload.
Both take the death window the caller resolved
(`braid.providers.probeFreshnessMs`, the same value the router's death gate is
built with) and mark a recorded death `(expired)` when that gate would no
longer act on it: an age at or past the window, a death with no recorded time,
or any death while the window is switched off. The age rule is the gate's own
predicate (`deathInForce` in `virtual-router.ts`), so the surface and the
router cannot disagree about which deaths act.

## Disabling the provider

The registration lives in `index.ts` behind the venice-catalog seam: remove
(or chmod) the userland catalog file and no provider is registered. All
ring-lifecycle logic stays in `ring-lifecycle.ts`, unit-testable without
loading pi-ai.

## Package layout

```
providers/
├── index.ts           # registers the configured routes + wires key-ring/rotation events
├── venice-catalog.ts  # userland catalog seam (the models file, resolved at runtime)
├── venice-direct.ts   # the venice-direct route module: constants, key ring, model configs
├── key-ring.ts        # multi-key rotation + backoff + persistence
├── ring-lifecycle.ts  # per-request ring attribution, exhaust/self-heal, route-order rotation engine
├── probe.ts           # provider-agnostic probe runner + the adapter table
├── route-state.ts     # cross-session route state, lock + CAS writes
├── ring-health.ts     # read-only health surface over the key-ring + route state files
├── log.ts             # notify-sink routing (no console.*)
└── test/              # fixture-driven behavior pins
```

> The registered id was `venice`, then `a0`, now `agent-zero` - each rename
> follows the gateway the provider serves models through. `venice-direct`, the
> `VENICE_API_KEY` family and `venice-models.json` are unchanged; the gateway's
> own credential namespace moved from `A0_VENICE_API_KEY` to `AGENT_ZERO_API_KEY`
> with the last rename.
