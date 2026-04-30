# Extension Group: cognitive

Cognitive control extensions enforcing agent behavior, reasoning quality, and alignment.

## Extensions

| Extension | Files | Purpose |
|---|---|---|
| `enforcement/` | 20 | 3-tier signal system (L1 internal, L2 session, L3 critical). Nudge engine, whisper system, validation. |
| `reasoning/` | 1 | Reasoning metrics (entropy, overlap, coherence). |
| `verification/` | 1 | Claim verification, evidence pool. |
| `topic-drift/` | 1 | Topic drift detection. |
| `sycophancy-detector/` | 1 | Anti-sycophancy enforcement. |
| `cognitive-systems/` | 1 | Cognitive architecture coordination. |

Total: 28 `.ts` files across 6 sub-extensions.

## Key Architecture

**Enforcement signal tiers:**
- L1: Internal state signals (belief, policy, MARS calibration)
- L2: Bundled session signals (per-turn aggregates)
- L3: Critical individual messages (high-stakes, high-confidence)

**Signal flow:** enforcement → emitSignal → belief-policy-engine → getNextRecommendation → whisper → enforcement

**Nudge patterns:** repetition, drift, efficiency, tool_use, stakes, calibration — each with 3 urgency levels.

## See Also

- [enforcement.md](enforcement.md) — full enforcement docs
- [reasoning.md](reasoning.md) — reasoning metrics
- [verification.md](verification.md) — claim verification
- [topic-drift.md](topic-drift.md) — drift detection
- [docs/lib/belief-policy-engine.md](../lib/belief-policy-engine.md) — policy engine
