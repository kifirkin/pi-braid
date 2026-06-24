<!-- status: current -->

# src/extensions/core/metacognition/handlers/ - Tool Factories

The 4 LLM-callable metacognition tools are defined here as factory functions.
Each file exports a `<name>Execute` function and a `<name>Params` schema, plus
a `create<Name>Tool` function that the index uses to register the tool.

## What "handlers" means here

In this directory, "handlers" = "tool factory functions." Each file is
self-contained: it owns its Typebox schema, its execute function, and the
`create<Name>Tool` wrapper that the index calls.

## Files

| File | Purpose |
|---|---|
| `think.ts` | The `think` tool - structured thinking with chain tracking, calibration feedback, depth budgets. |
| `hypothesize.ts` | The `hypothesize` tool - generate ranked hypotheses with heuristic + evidence-pool scoring (uses `./scoring.ts`). |
| `verify.ts` | The `verify` tool - recursive verification of code/reasoning/plans. |
| `finalize.ts` | The `finalize` tool - pre-flight check before final answer. |
| `scoring.ts` | Internal helper: heuristic + evidence-pool scoring for hypotheses. Imported by `hypothesize.ts` only. |

## Why not in `scheduling/` or `tools/`?

Utility-style tools that have no metacognitive role (e.g. `timer`) live in
`extensions/scheduling/`. There is no `extensions/tools/` directory.
The metacognition tools are tightly coupled to session state and reflect on
the agent's own reasoning. They belong with the metacognition extension.
