# Extension Group: tools

Utility extensions providing developer and operational tools.

## Extensions

| Extension           | Files | Purpose                                                   |
| ------------------- | ----- | --------------------------------------------------------- |
| `codebase-tree/`    | 1     | Directory structure with stats and filtering.             |
| `docs/`             | 1     | Document reading (doc, docx, rtf, html, txt, pdf).        |
| `healthcheck/`      | 1     | Comprehensive self-diagnostic.                            |
| `latent-activator/` | 1     | Latent behavior pattern activation.                       |
| `timer/`            | 1     | Non-blocking timer (timer_set, timer_list, timer_cancel). |
| `browser/`          | 3     | CDP browser automation, execute JS, navigate, screenshot. |
| `web-fetch/`        | 5     | Clean markdown web fetching, headers, secrets detection.  |
| `vision/`           | 1     | Image analysis (visual/UI/layout, sprites, OCR).          |

Total: 8 sub-extensions.

## Key Architecture

**latent-activator:** Behaviors are implicit state shifts. Activate via `activate_behavior(behavior)` or `activate_mix(scenario)`.

**healthcheck:** Validates tools, extensions, builtin capabilities, system resources.

## See Also

- [healthcheck.md](healthcheck.md) — diagnostics
