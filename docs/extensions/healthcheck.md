# Extension: healthcheck

**Status**: ✅ Working
**Tests**: None
**Version**: v0.4.x

## Purpose

Agent self-diagnostic — validates all tools, extensions, and system resources. The `healthcheck` tool runs comprehensive checks and reports pass/fail/warn status with recommendations.

## Architecture

Modular checks grouped by category:
- `filesystem` — file I/O
- `paths` — path resolution
- `shell` — bash execution
- `state` — extension state
- `resources` — system resources
- `agent` — agent API
- `tools` — builtin tool registry
- `builtin` — builtin functions
- `extensions` — extension health

## Events Handled

None — the tool is called directly by the agent, typically via `evolve health`.

## Tools

| Tool | Description |
|------|-------------|
| `healthcheck` | Run comprehensive health check. Params: `verbose` (detailed output), `categories` (filter specific checks). Returns structured pass/fail/warn per check. |

## Key Patterns

- **Category targeting**: Can run specific checks (`categories: ["filesystem", "shell"]`) instead of full suite.
- **Recommendation system**: Failing checks include actionable recommendations (e.g., "Install ripgrep: brew install ripgrep").
- **No dependencies**: Pure runtime checks — no network calls or external services.
