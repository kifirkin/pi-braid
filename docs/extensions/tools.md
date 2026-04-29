# Extension Group: tools

Utility extensions providing developer and operational tools.

## Extensions

| Extension | Files | Purpose |
|---|---|---|
| `codebase-tree/` | 1 | Directory structure with stats and filtering. |
| `codebase-graph/` | 1 | Dependency analysis, dead code, orphans, cycles. |
| `docs/` | 1 | Document reading (doc, docx, rtf, html, txt, pdf). |
| `healthcheck/` | 1 | Comprehensive self-diagnostic. |
| `latent-activator/` | 1 | Latent behavior pattern activation. |
| `repl/` | 1 | JavaScript REPL (RLM mode with context helpers). |
| `timer/` | 1 | Non-blocking timer (timer_set, timer_list, timer_cancel). |
| `browser/` | 3 | CDP browser automation, execute JS, navigate, screenshot. |
| `web-fetch/` | 5 | Clean markdown web fetching, headers, secrets detection. |
| `vision/` | 1 | Image analysis (visual/UI/layout, sprites, OCR). |

Total: 10 sub-extensions.

## Key Architecture

**codebase_graph:** `find_dead_ends | orphans | hubs | cycles | all`. Currently showing clean hub-and-spoke architecture (0 issues).

**repl:** RLM mode with `ctx` helpers (chunk, search, filter, map, reduce). Context can be inline data, file path (auto-detects JSON/JSONL/text), or glob pattern `{ pattern, baseDir }`.

**latent-activator:** Behaviors are implicit state shifts. Activate via `activate_behavior(behavior)` or `activate_mix(scenario)`.

**healthcheck:** Validates tools, extensions, builtin capabilities, system resources.

## See Also

- [codebase-graph.md](codebase-graph.md) — dependency analysis
- [repl.md](repl.md) — JavaScript REPL
- [healthcheck.md](healthcheck.md) — diagnostics
