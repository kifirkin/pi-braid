# Benchmark Saturation Analysis — 2026-04-24

## Executive Summary

**Standard benchmark problems are 100% saturated.** 144/144 runs (4 configs × 2 providers × 6 problems × 3 trials) all pass at 100%.

No differentiation possible with current problems. Must use variant problems or harder tasks.

---

## Full Results

### stepfun (4 configs × 6 tasks × 3 trials = 72 runs)

| Config         | flatten_deep | merge_sorted | reverse_words | group_anagrams | binary_search | is_balanced |      Total       |
| -------------- | :----------: | :----------: | :-----------: | :------------: | :-----------: | :---------: | :--------------: |
| no-bash        |     3/3      |     3/3      |      3/3      |      3/3       |      3/3      |     3/3     | **18/18 (100%)** |
| baseline-bash  |     3/3      |     3/3      |      3/3      |      3/3       |      3/3      |     3/3     | **18/18 (100%)** |
| braid-full     |     3/3      |     3/3      |      3/3      |      3/3       |      3/3      |     3/3     | **18/18 (100%)** |
| braid-research |     3/3      |     3/3      |      3/3      |      3/3       |      3/3      |     3/3     | **18/18 (100%)** |

### minimax (4 configs × 6 tasks × 3 trials = 72 runs)

| Config         | flatten_deep | merge_sorted | reverse_words | group_anagrams | binary_search | is_balanced |      Total       |
| -------------- | :----------: | :----------: | :-----------: | :------------: | :-----------: | :---------: | :--------------: |
| no-bash        |     3/3      |     3/3      |      3/3      |      3/3       |      3/3      |     3/3     | **18/18 (100%)** |
| baseline-bash  |     3/3      |     3/3      |      3/3      |      3/3       |      3/3      |     3/3     | **18/18 (100%)** |
| braid-full     |     3/3      |     3/3      |      3/3      |      3/3       |      3/3      |     3/3     | **18/18 (100%)** |
| braid-research |     3/3      |     3/3      |      3/3      |      3/3       |      3/3      |     3/3     | **18/18 (100%)** |

### Grand Total: 144/144 runs = **100% pass rate**

---

## Interpretation

```
no-bash (5 tools only)     ████████████████████████████████████ 100%
baseline-bash (+bash)      ████████████████████████████████████ 100%
braid-full (29 extensions) ████████████████████████████████████ 100%
braid-research (contrast)  ████████████████████████████████████ 100%
```

**The configs are NOT differentiated by task performance** on standard problems.

**Why?** The 6 benchmark problems test Level 1 (algorithmic) and Level 2 (recombination) skills. When both are saturated, no config differentiation is possible.

**What this means:**

- Compliance framing doesn't hurt (no compliance theater visible)
- Identity framing doesn't help (beyond baseline)
- Both stepfun and minimax are strong enough for these problems
- pi-braid extensions provide zero measurable benefit on standard tasks

---

## Solution: Variant Problems

VAR-MATH (2507.12885) approach: generate structurally different variants of the same skill. Same algorithmic difficulty, different surface form.

If standard = 100% but variants drop to 50% → contamination.
If braid-research > braid-full on variants → MDA/contrast phrases help generalization.

**Implementation**: `evaluation/variant_generator.py` — 17 variants across 4 problem types.

**Next step**: Run variant benchmark to find where configs actually differ.

---

## Key Bug Fix Applied This Session

**pi `--no-extensions` bug**: `--no-extensions` with directory `-e` paths broke provider loading (stepfun disappeared).

**Fix**: Use `--no-extensions -e <path>/index.ts` (explicit file, not directory) for both poorman-providers and braid-develop. Updated `benchmark_multi_turn.py`.

---

## Session Files (Raw)

Session files from last night's session (for tool behavior analysis):

- `~/.pi/agent/sessions/--Users-kifir-projects-vibe-implicit-framing--/2026-04-23T07-24-45-193Z_019db93a-1709-7069-87e1-acd0803c2dad.jsonl`

Raw benchmark results:

- `evaluation/runs/results_20260424_154901.json` (braid-research stepfun)
- `evaluation/runs/results_20260424_155219.json` (no-bash stepfun)
- `evaluation/runs/results_20260424_155533.json` (baseline-bash stepfun)
- `evaluation/runs/results_20260424_155904.json` (braid-full stepfun)
- `evaluation/runs/results_20260424_160659.json` (no-bash minimax)
- `evaluation/runs/results_20260424_161013.json` (baseline-bash minimax)
- `evaluation/runs/results_20260424_161331.json` (braid-full minimax)
- `evaluation/runs/results_20260424_161646.json` (braid-research minimax)

---

## What the Session Revealed About pi-braid Bugs

From session `2026-04-23T07-24-45` (2612 lines):

### 1. UX Extension OSC Pollution

- OSC 777 notifications polluted stdout in print mode (benchmark)
- Fixed: added `isTTY` guard in `ux/index.ts`

### 2. Context Overflow Bugs (FIXED in today's commits)

- `e096118`: Context window errors were retried WITHOUT checking first → infinite loop
- `bc93442`: LLM summarization ran at 200K+ tokens → garbage output
- `15b32f1`: Compaction produced nonsense (removed wait-review module first, then fixed compaction itself)

### 3. Whisper Enforcement Bug (FIXED)

- `2c2ce51`: 90% whisper was a "should" not a "must" → model ignored whisper directives
- Now hard-coded as mandatory

### 4. Infrastructure Theater (8 items NOT wired → zero behavioral change)

- Belief store: exists but NOT wired into heartbeat-scheduler
- Three-memory stores: work but NOT auto-recalled during task
- Session cleanup: missing (memory leak via `process.cwd()`)
- Policy engine: implemented but not used for proactive token monitoring
- Analytics: exports to file but NO feedback loop closes
- Session-recall: only triggers on session rotation, not mid-task
- `discoverPiPackage()`: not used in prompt-builder
- Polyfill/async migration: incomplete (preprocessor, guardian, repl still sync)

### 5. Context Management (S-MMU)

- Compaction proposals triggered at 61% context but no compression executed
- Context hygiene module exists in heartbeat but NOT wired to actual compaction
- `memory_recall` exists but only fires on rotation, not when agent stalls

---

## Temp Agent Settings Approach

To use a temp `~/.pi/agent/settings.json` for isolated testing:

```bash
# Option 1: Symlink ~/.pi to temp dir
TEMP_PI=$(mktemp -d /tmp/pi-test.XXXXX)
mkdir -p "$TEMP_PI/sessions"
cat > "$TEMP_PI/settings.json" << 'EOF'
{
  "extensions": ["/path/to/extension/dist/index.js"],
  "compaction": { "aggressive": true, "maxMessages": 40, "minAge": 5 },
  "providers": {}
}
EOF
mv ~/.pi ~/.pi.real && ln -s "$TEMP_PI" ~/.pi
# ... run tests ...
rm ~/.pi && mv ~/.pi.real ~/.pi
```

```bash
# Option 2: Capture session files separately (no settings change)
# Use PI_SESSION_DIR env var or --session-dir flag
pi --session-dir /tmp/my-sessions -- echo test
```

```bash
# Option 3: Benchmark approach — --no-extensions + explicit -e
# Disables all extensions, then loads only specified ones
pi -p --no-session \
  --no-extensions \
  -e ~/projects/agents/pi-poorman-providers/index.ts \
  -e ~/projects/agents/pi-braid-develop/dist/index.js \
  --provider stepfun --model step-3.5-flash-2603
```
