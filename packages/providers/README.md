# pi-braid-providers

Key rotation, provider failover, and route health for the [pi](https://github.com/earendil-works/pi)
coding agent: several keys per provider, a dead key retired instead of retried, and a failover to a
healthier route when a provider's ring runs dry.

## Install

```bash
pi install npm:pi-braid-providers
```

Then name your routes (see Configuration). Until a route and its key are configured, the extension
loads the machinery and registers no provider: inert, not broken.

## What you get

| Surface            | What it gives you                                                                                                                                                     |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Multi-key rotation | Numbered keys per provider, falling back to the bare variable. On a quota, auth or 403 error the active key is retired and the next request uses the next healthy one |
| Persisted state    | Key-ring state on disk, so a restart skips keys already known dead instead of retrying the same 403                                                                   |
| Turn retry         | When a turn fails and a fresh key remains, the next key serves the retry; fatal account errors are never disguised as retryable                                       |
| Failover           | An ordered route table, walked one rotation per episode, with one notice to the owner and a bounded fail-back probe that returns when the dead route recovers         |
| Route health       | `ring_health` reports each ring and each route's last probe: read-only, key hashes only, never writes                                                                 |
| Request guard      | `braid.context.presendGuard` flushes oversized strings to disk above 90% of a known window, so a large request shrinks instead of being rejected                      |

## Configuration

### Routes

`braid.providers.routes` is an ordered array; array order is rotation order. Each entry names the
provider id pi will expose, the environment variable prefix its keys load from, and optionally the
model ids it serves and a non-billable status probe:

```json
{
  "braid": {
    "providers": {
      "routes": [
        {
          "provider": "venice-direct",
          "keys": "VENICE_API_KEY",
          "probe": {
            "url": "https://api.venice.ai/api/v1/api_keys/rate_limits",
            "balanceFloorUsd": 1
          }
        }
      ]
    }
  }
}
```

A route is recognized by the model ids it declares, so a route you did not configure is never
routed to. With no `routes` key, the two routes this build carries are used in order: the gateway
route, whose model catalog comes from a userland file that this package does not ship, and
`venice-direct`, which serves Venice's own API. Without that catalog the gateway route does not
register, and only routes you configure serve traffic. A route's `probe` declares a status
endpoint that is checked with the route's own key, at registration and on a bounded interval
afterwards; the check is never a billable call, and its result steers routing only while it is
fresher than `braid.providers.probeFreshnessMs`.

### Settings

| Key                                  | Default               | Effect                                                                            |
| ------------------------------------ | --------------------- | --------------------------------------------------------------------------------- |
| `braid.providers.routes`             | the pair above        | Ordered route table; a configured array replaces the default pair entirely        |
| `braid.providers.probeFreshnessMs`   | `900000` (15 minutes) | How long a recorded probe or death may steer routing; `0` disables probe steering |
| `braid.context.presendGuard.enabled` | `true`                | The 90% request guard described above                                             |

### Environment

`AGENT_ZERO_API_KEY` for the gateway route, `VENICE_API_KEY` for the direct route; numbered
suffixes (`_P0` through `_P9`) add rotation keys, and the bare variable is used when no numbered
key exists.

## Limits

- It is not a proxy or a gateway you can point other tools at: it plugs into pi's model registry.
- A route you did not configure is never routed to.
- Fatal account errors (quota, billing, balance) stop the turn rather than rotate.
- Ring and route state live directly under `~/.pi/agent/`, not under `braid/`:
  `.key-ring-state-<provider>.json` and `.provider-route-state.json`. Key material is never
  written, only key hashes.

## For maintainers

The route table internals, the probe adapter table, the state store protocol and the failure
classes are in [AGENTS.md](https://github.com/kifirkin/pi-braid/blob/main/packages/providers/AGENTS.md),
which the tarball does not carry.

## License

[MIT](LICENSE)
