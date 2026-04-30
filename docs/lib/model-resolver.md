# lib/model-resolver.ts

**Purpose**: Model resolution helpers that respect user settings and fall back to sensible defaults. Used by polyfill to inject `getUtilityModel()`/`getVisionModel()` into every context.

## Architecture

Priority chain for model resolution:

1. Custom setting (via `/vision-model` or `/model` commands) → highest priority
2. `defaultModel`/`defaultProvider` from settings → survives restarts
3. Current `ctx.model` → fallback
4. Cheapest available model → last resort

## Key Functions

| Function                           | Description                                                      |
| ---------------------------------- | ---------------------------------------------------------------- |
| `resolveUtilityModel(ctx)`         | Best model for non-vision tasks (cost-sensitive)                 |
| `resolveVisionModel(ctx)`          | Best model with vision capabilities                              |
| `resolveFromPattern(ctx, pattern)` | Parse `"provider/model-id"` or `"model-id"` and find in registry |

## Key Patterns

- **Provider/model separation**: `resolveFromPattern` splits on `/` to find provider + modelId separately.
- **All-models fallback**: If a pattern doesn't match, searches all models by ID suffix.
- **Settings-first**: Every lookup checks custom settings (set by interactive model selector) before falling through.
- **No side effects**: Pure query functions — they don't change any state or settings.
