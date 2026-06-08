# src/lib/ai/ — LLM Utilities

Helpers for calling LLMs in a structured way. Used by extensions that need
to invoke models (critic, classifier, polish) with consistent error handling
and result parsing.

## Files

| File | Purpose |
|---|---|
| `critic-registry.ts` | Catalog of available critics (judges that evaluate LLM output). Each critic has a tier, name, and prompt template. |
| `critic-gate.ts` | Utility-model-first gate pattern — uses a small/fast model to decide whether the full critic should run. Reduces cost. |
| `critic-stats.ts` | Statistics on critic invocations (success rate, duration, tier distribution). |
| `text-classifier.ts` | Generic text classifier — runs utility model with structured schema, returns typed result. |
| `language-hint.ts` | Detects the language of input text (used to route language-specific processing). |
| `llm-call.ts` | Low-level wrapper around `pi.getModel()` + `streamSimple`. Handles abort, retry, and structured output parsing. |
| `model-resolver.ts` | Resolves model by alias (e.g., "utility" → cheapest model). |

## Local Contracts

- All LLM calls should go through `llm-call.ts` for consistent abort/retry behavior.
- All classifications should go through `text-classifier.ts` — it handles the utility-model-first gate via `critic-gate.ts`.
- Don't hardcode model names — use `model-resolver.ts` aliases.

## Anti-patterns

- Don't call `streamSimple` directly from extensions. Use `llm-call.ts`.
- Don't parse LLM JSON inline. Use `text-classifier.ts` which handles `withTypeBox` schemas.
