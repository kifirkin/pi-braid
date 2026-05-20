# cognition-evaluator.ts — Cognition Quality Evaluation

**Origin**: Commit `0aeb7684` — "feat: metacognition decomposition + cognition evaluator"

**What it was supposed to do**: Score think/hypothesize/finalize quality from session evidence.
Measured reasoning depth, hypothesis coverage, verification rigor.

**Why it was abandoned**: The enforcement module's `handler-registry.ts` explicitly chose NOT
to import it (comment: "without importing error-classifier"). The metacognition extension
tracks its own metrics internally. This file was a heuristic evaluation layer that was
never wired because the inline tracking was sufficient.

**What replaced it**: Inline metrics tracking in `src/extensions/core/metacognition/index.ts`
(via `getMetaState()`).

**Tests**: `test/runtime/test-cognition-evaluator.mjs` — was actively testing the dead module.
Removed.