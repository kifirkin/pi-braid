# Extension: metacognition

**Status**: ✅ Working
**Tests**: None
**Version**: v0.6.x

## Purpose

Core metacognitive tools — `think`, `hypothesize`, `finalize`. These are the foundational reasoning tools that give the agent structured thinking capabilities.

- `think` — Record structured reasoning with depth control, alternatives, and confidence calibration
- `hypothesize` — Generate ranked hypotheses from problems + evidence
- `finalize` — Mark task completion with summary and verification

## Architecture

Wires into `lib/` tools:

- `think` → `lib/think.ts` (structured thinking with recursive depth)
- `hypothesize` → `lib/hypothesize.ts` (problem decomposition + evidence analysis)
- `finalize` → `lib/finalize.ts` (task completion + auto-proceed)

## Events Handled

| Event           | Handler                                          |
| --------------- | ------------------------------------------------ |
| `session_start` | Initialize finalize state, reset counters        |
| `turn_end`      | Check for pending finalize auto-proceed triggers |

## Tools

| Tool          | Description                                                                                                                                                                                                                             |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `think`       | Record structured thinking. Depth levels: `minimal`, `low`, `medium`, `high`, `max`, `quick`, `deep`. Options: `ask_utility_model` for fresh-eyes perspective, `alternatives` for contrast. Auto-decorates with confidence calibration. |
| `hypothesize` | Generate ranked hypotheses from problem + evidence. Parameters: `maxHypotheses` (default 3). Returns structured analysis with root cause, confidence, evidence.                                                                         |
| `finalize`    | Mark task complete. Parameters: `completed` (boolean), `summary` (string), `tasksRemaining` (follow-ups), `autoProceed` (propose next task). Enforces minimum evidence before completion.                                               |

## Key Patterns

- **Confidence calibration**: `think` auto-tags with confidence (0-1) based on evidence strength. Low confidence = accuracy awareness, not weakness.
- **Finalize guarding**: Blocks finalization with `completed:true` if no memory stored or code changed without insight. Forces the agent to persist knowledge before claiming done.
- **Auto-proceed**: When `autoProceed:true`, scans planner/goal manager for the next pending task and proposes it as a follow-up.
- **Depth control**: `think(depth='deep')` invokes utility model (meta-evaluator) for a fresh perspective. Avoids echo-chamber thinking.
