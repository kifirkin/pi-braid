<!-- status: historical -->

# pi-braid History

How pi-braid came to be, for visitors who want the story rather than the
release notes. Release-level detail lives in the
[changelog](../../../CHANGELOG.md); what's next is in [ROADMAP.md](ROADMAP.md);
first-time setup is in [SETUP.md](SETUP.md).

> A note on granularity: the public git history is a single consolidated commit,
> and the changelog's "Repository history" section records what it condensed.
> Milestones before the 2026-08-29 monorepo snapshot are summarized here from
> the project's own records - dated, but without per-commit references.

## The idea

pi is a coding agent with a base loop and a small built-in toolset.
pi-braid is a layer over it with one premise: an agent that can see and
manage its own cognition is more reliable than one that can't. Everything in
the repo serves that premise - enforcement of behavior policies, memory that
survives sessions, structured reasoning before hard decisions, verification
after edits, and background services that notice degradation before the user
does.

## Foundations (April – May 2026)

The repo was carved out of the earlier pi-mono/pi-braid lineage in mid-April
2026 and immediately went for capability with zero external dependencies: a
native `web_fetch` and CDP-driven browser automation (April 15), later joined
by a typed event bus for cross-extension signals, proactive context
projection, and analytics events.

May produced the three-memory-stores design - episodes (what
happened), semantic facts, and procedural heuristics - with deep merge,
cross-search, and project-scoped isolation. Memory with provenance is what
lets the rest of the suite reason about its own past without leaking one
project's context into another.

## Prompt architecture (June – August 2026)

The prompt-builder went through several rewrites, each shrinking token count
while increasing specificity. It was decomposed into composable
`PromptSection` fragments with pointer blocks (June 2026), a behavior-modes
system was dropped in favor of static identity invariants (July), and a
research pass - comparing four prompt generations - concluded that identity
framing beats explicit directives, and that descoped, anti-sycophancy framing
outperforms compliance theater. Later additions: a discovery stance, guarded
tool-usage pipelines, a once-per-session awareness whisper, per-tool
instruction ownership (a tool's owning package speaks for it), and a
time-awareness layer that renders every braid-facing timestamp in the owner's
timezone so long sessions never reason from a stale clock.

## Packaging and publishing (July 2026)

What began as a single extension folder became a disciplined five-workspace
monorepo (July 27): `core` (the suite), `skills` (a content-only skill pack),
`contrib` (code-only extras), `providers` (LLM providers with a multi-key API
key ring), and `telegram` (a bidirectional channel). The same period shipped
the user-facing docs (README rewrite, canonical [SETUP.md](SETUP.md)), a
versioned local publish pipeline (`publish-local.mjs`, `base-branch.iteration`
scheme with auto-revert), release guards, and the `0.40.0-main.N` iteration
scheme for weekly releases without semver churn.

## Reliability (August – September 2026)

The longest-running theme. Compaction became lossless by design - speaker
attribution and sliding-window compaction landed in late July, an append-only
originals archive in August - so nothing thrown away is truly gone. Heartbeat
telemetry was rebuilt on live
measurements (context tokens, cache-hit share, tokens/sec) after the old
pipeline was caught running on placeholder constants. A watchdog learned not
to bark storms. An OOM class was found and fixed where pi-core removed a
field the detector keyed on and every heartbeat tick started serializing the
entire session graph - the fix introduced scalar-whitelisted metrics and a
hard size limit on serialized state. Context hygiene got its own enforcement:
token-gated advisories that stay reachable on 1M-token windows, hard backstops
on runaway tool results, and a manual-compaction contract that treats a
compaction as a full stop. The memory layer gained a review-before-write gate
that rejects signal-free writes and dedupes repeats before they hit disk.

## Tooling and hygiene (September 2026)

As the suite matured, the project started gating itself: a whole-tree
private-data scan (home paths, API keys, session files) runs in CI and
locally; a placement checker scans for provenance tokens, domain literals in
generic layers, and owner paths; knip reports dead code; doc status markers
and a doc-drift detector keep prose from lying about the codebase. Comment
discipline is codified in CONTRIBUTING: comments explain why, history lives
in git.

## The satellite packages

- **providers** - grew a generalized API key ring (rotation, exponential
  backoff, persisted exhaustion, self-healing retry), then consolidated onto
  a single venice (a0 proxy) registration with per-model capability flags and
  robust cost handling.
- **telegram** - grew from a one-way send tool into a bidirectional channel:
  long-poll inbound, photo and voice messages with speech-to-text (an ordered
  key pool with failover), inline-keyboard pause/resume, and a strict
  truncation contract that never silently cuts the owner's messages.
- **skills** - a content-only pack (one SKILL.md per skill) that stays out of
  every other package to avoid silent skill shadowing; it publishes through
  the same local pipeline as the code packages.

## Where it stands

The monorepo publishes weekly `main.N` iterations, gates every change behind
typecheck, lint, tests, doc checks, and the private-data scan, and stays an
early-stage project by its own README's honest label. The open working set is
in [ROADMAP.md](ROADMAP.md).
