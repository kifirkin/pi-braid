<!-- status: current -->

# Self-Harness Loop: src/lib/harness/

Failure collection and weakness mining. `failure-trace-collector.ts` observes the
tool-loop detector's per-session state (written by the enforcement extension on
every tool call and turn end) and records `FailureSignature`s;
`weakness-miner.ts` clusters them by type and tool name, and
`summarizeClusters()` feeds the heartbeat evolver's whisper, which is the only
consumer. The loop is passive: it reads existing state, adds no instrumentation,
and makes no LLM calls.

The proposal half was deleted. It was a proposer and an LLM-as-judge validator
that generated and scored candidate edits to harness surfaces, plus the JSONL
ledger that stored them; the proposer ran from a descriptive placeholder
instead of the actual surfaces, no consumer acted on its output, and the loop
spent LLM calls every session on proposals that could not be applied. Git
history is the archive for that half. The enforcement extension still tracks
`consecutiveErrorTurns` and `validationFailures`; a collector that reads those
flat counters correctly would be new work, not a revival of the deleted one.
