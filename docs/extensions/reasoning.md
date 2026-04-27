# Extension: reasoning

**Status**: ✅ Working
**Tests**: 18 runtime tests
**Version**: v0.8.x

## Purpose

Reasoning quality metrics — measures entropy, verbosity, recovery, and consistency of agent reasoning across turns. Used by MARS reflector for self-reflection calibration.

## Metrics Tracked

| Metric | Description |
|--------|-------------|
| Entropy | Token distribution spread — low entropy = repetitive/templated reasoning |
| Overlap | Token-overlap between consecutive reasoning blocks — high overlap = stalled |
| Verbosity | Token count per reasoning block — detects bloated output |
| Recovery | Speed of recovery after tool errors — turns between error and recovery signal |

## Events Handled

| Event | Handler |
|-------|---------|
| `message_end` | Sample agent reasoning (hidden CoT tokens) to compute entropy, overlap, verbosity |

## Key Patterns

- **Entropy calculation**: Computed as normalized Shannon entropy of token-frequency distribution. Low entropy (<0.3) triggers repetition warning. Threshold: `ENTROPY_MIN = 0.3`.
- **Overlap detection**: Consecutive reasoning blocks compared via Jaccard similarity on token sets. Overlap >0.7 = stalled. **Checked AFTER entropy** to avoid double-triggering.
- **Recovery tracking**: After a tool error, scans subsequent turns for recovery signal (state change or direction shift). Recovery latency in turns is tracked.
- **Normalized comparison**: All metrics normalized to 0-1 range for consistent thresholding. Running averages computed over sliding window (3 turns default).
