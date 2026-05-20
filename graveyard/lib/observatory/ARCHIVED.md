# observatory.ts — Agent Observatory Server

**Origin**: Commit `201c59a9` — "feat: Agent Observatory — real-time monitoring with three.js visualization"

**What it was supposed to do**: Embedded WebSocket server that captured Event Bus events,
agent state, and tool metrics, streaming them to a three.js-based visualization frontend.

**Why it was abandoned**: The monolithic server was superseded by a lighter daemon-client
pattern. The full server code was decomposed into:
- `braid-os/observatory-daemon.ts` — singleton daemon
- `braid-os/braid-daemon.sh`, — daemon lifecycle management
- `contrib/observatory/` — lightweight client connecting to the daemon

The old server was never removed during the refactor.

**What replaced it**: `src/contrib/observatory/index.ts` (client) + `braid-os/observatory/index.html` (frontend)
+ `braid-os/` (daemon).

**Tests**: `test/runtime/test-observatory-extension.mjs` — tests the extension client, not the dead server.
`test/runtime/test-observatory.mjs` was removed.