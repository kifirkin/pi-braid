<!-- status: current -->

# src/lib/ai/ - LLM Utilities

Helpers for calling LLMs in a structured way. Used by extensions that need
to invoke models (critic, classifier, polish) with consistent error handling
and result parsing.

## Files

| File | Purpose |
|---|---|
| `critic-registry.ts` | Catalog of available critics (judges that evaluate LLM output). Each critic has a tier, name, and prompt template. |
| `critic-gate.ts` | Utility-model-first gate pattern - uses a small/fast model to decide whether the full critic should run. Reduces cost. |
| `critic-stats.ts` | Statistics on critic invocations (success rate, duration, tier distribution, Q16 token counts). |
| `cost-report.ts` | USD cost estimates from `critic-stats` token data (P3-25). Computes per-critic + aggregate spend at configurable pricing rates. |
| `text-classifier.ts` | Generic text classifier - runs utility model with structured schema, returns typed result. |
| `post-loop-classify.ts` | Thin wrapper around `classify()` bundling the 4 post-loop guarantees (signal thread, abort demotion, 8s default timeout, caller-supplied onFailure fallback). Use this for `agent_end` / post-loop LLM calls. |
| `language-hint.ts` | Detects the language of input text (used to route language-specific processing). |
| `llm-call.ts` | Low-level wrapper around `pi.getModel()` + `completeSimple`. Handles abort, retry, and structured output parsing. |
| `model-resolver.ts` | Resolves model by alias (e.g., "utility" → cheapest model). |

## Local Contracts

- All LLM calls should go through `llm-call.ts` for consistent abort/retry behavior.
- All classifications should go through `text-classifier.ts` - it handles the utility-model-first gate via `critic-gate.ts`.
- **All post-loop LLM calls (agent_end, post-turn analysis, reflection, etc.) should go through `post-loop-classify.ts`** - it bundles the 4 post-loop guarantees (signal thread, abort demotion, 8s default timeout, onFailure fallback) that hand-rolled callers have repeatedly gotten wrong. See `src/extensions/heartbeat/AGENTS.md` for the abort-handling contract.
- **Direct `callLlm()` callers must thread `ctx.signal` (or the tool execute's `signal` parameter) via the conditional spread pattern** `...(ctx.signal ? { signal: ctx.signal } : {})`. Without this, ESC during the agent's main turn leaks the parallel LLM call until its own timeout fires, producing misleading "LLM error: This operation was aborted" ERROR logs. Verified by `test-direct-callers-signal-threading.mjs` for input-polisher, session-recall, and verification-judge.
- Don't hardcode model names - use `model-resolver.ts` aliases.

## Anti-patterns

- Don't call `completeSimple` directly from extensions. Use `llm-call.ts`.
- Don't parse LLM JSON inline. Use `text-classifier.ts` which handles `withTypeBox` schemas.
