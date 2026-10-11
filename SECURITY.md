<!-- status: current -->

# Security Policy

## Supported versions

braid is a single-trunk, owner-run project: only the latest `main` is
supported. Fixes land on `main`; older checkouts and published tarballs are
not patched retroactively. Update by pulling `main`, rebuilding, and
republishing your local install (`npm run publish:local`).

## Reporting a vulnerability

Use **GitHub private vulnerability reporting** on this repository:
**Security → Report a vulnerability**. Do not open a public issue with
vulnerability details. There is no security email or other private channel;
GitHub's report form is the only intake.

## In scope

Surfaces braid itself owns:

- **Providers / keyring** (`packages/providers`): the multi-key ring, key
  lifecycle, presend guard, and log sanitation. Focus: anything that could
  leak API keys into logs, error reports, or other channels.
- **Telegram bridge** (`packages/telegram`): outbound sends, inbound
  ingestion, the sender allowlist, message acceptance, and the poller.
- **Prompt / injection layer** (`packages/core`): prompt-builder (system-prompt
  assembly) and enforcement (turn gates, whispers). Focus: anything that lets
  untrusted content inject instructions or bypass a gate.

Not in scope: pi-core itself (report to the pi project) and third-party npm
dependencies (report upstream); mention them only if braid's usage makes
them exploitable.

## What to expect

Best-effort, no bounty, no SLA. Reports are triaged as time allows; you'll
hear back once there is something concrete. Coordinated disclosure is
welcome: please allow a reasonable window for a fix before publishing
details.
