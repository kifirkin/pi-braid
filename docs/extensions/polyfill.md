# Extension: polyfill

**Status**: ✅ Working (core integration layer)
**Tests**: None
**Version**: v0.11.x

## Purpose

Core pi-braid integration layer — patches the pi host context with pi-braid's model resolvers, commands, and session manager extensions. This is the "glue" between pi's native API and pi-braid's extended tool ecosystem.

## Architecture

Patches the following pi subsystems:

1. **Context methods** — injects `getUtilityModel()`/`getVisionModel()` via `resolveUtilityModel()`/`resolveVisionModel()` from `lib/model-resolver.ts`
2. **Command handlers** — `/retry`, `/models`, `/vendor`, `/tools`, `/tool-status`, `/analytics`, `/context-stats`, `/browser-*`, `/model-picker`
3. **Session manager** — patches `settings.setDefaultModelAndProvider()` to persist model settings
4. **Tool registry** — calls `(pi as any).refreshTools()` after patching to re-wrap tools with patched context

## Events Handled

| Event           | Handler                                                                                           |
| --------------- | ------------------------------------------------------------------------------------------------- |
| `session_start` | Patch runner.createContext, resolve functions, set default model, register commands, refreshTools |
| `message_end`   | Retry interception — detect retry requests and re-route through retry handler                     |

## Key Patterns

- **Runner patching**: Overrides `runner.createContext` to inject pi-braid's model resolvers into every future context. Also patches `settings.setDefaultModelAndProvider` for persistence.
- **Command registration**: Uses `ctx.registerCommand()` to add interactive commands like `/retry` (re-runs last turn), `/models` (list available), `/browser-pick` (element picker).
- **Model resolution priority**: custom setting > defaultModel/defaultProvider > current model > cheapest available.
- **Legacy resolver support**: Stores legacy resolver aliases on `(pi as any)` global for command handlers that don't have direct ctx access.
