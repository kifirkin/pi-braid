# Extension: prompt-builder

**Status**: ✅ Working
**Tests**: None
**Version**: v0.10.x

## Purpose

Custom system prompt generation — builds the pi-braid system prompt from structured data sources. Completely overrides pi's native system prompt generation.

## Architecture

Reconstructs the system prompt from structured data (not fragile string extraction). Each prompt section is a helper function:

- Identity, environment (L1), date/time
- Agent identity description
- Tool descriptions (from tool registry)
- Procedural skills (verbatim from templates)
- Available commands
- Memory + context hygiene instructions
- Implicit budget guidelines
- Enforcement signals documentation

## Events Handled

| Event                   | Handler                                                                 |
| ----------------------- | ----------------------------------------------------------------------- |
| `session_before_prompt` | Build complete system prompt from all sources, inject as system message |

## Key Patterns

- **Section-based construction**: Each prompt section is an independent function. Sections can be enabled/disabled via config.
- **Tool description augmentation**: Tool `description` field is used as the primary prompt text, replacing fragile `promptSnippet` extraction.
- **Skills documentation**: Scans `~/.pi/agent/skills/` for procedure documentation to inject context-relevant skill descriptions.
- **L1 environment**: Calls into `agent-environment` extension's `gatherL1Environment()` for runtime state injection.
- **Implicit budget**: Section 10 provides token budget guidelines ("think silently, be concise, focus on essentials").
