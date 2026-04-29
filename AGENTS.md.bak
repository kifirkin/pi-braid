# pi-braid Developer Guide

## Project Structure

```
src/
  index.ts              # Main entry point (uses module loader)
  modules/              # Module system (NEW)
    definitions.ts      # Module definitions + extension groupings
    loader.ts           # Config-driven module loader
    api.ts              # Subagent API for runtime toggling
  extensions/           # Extensions grouped by module (mirrors definitions.ts)
    core/               # Foundation (always on): polyfill, metacognition, planner, scratchpad, preprocessor
    cognitive/          # RepE enforcement, reasoning, evidence, verification, topic-drift
    memory/             # Three stores, session recall, context compaction + lifecycle
    heartbeat/          # Proactive cognitive scheduling — paper 2604.14178
    retry/              # Error recovery with backoff
    prompt/             # System prompt builder + injection defence
    tools/              # Utility: codebase-tree, repl, docs, healthcheck, timer, latent-activator
    browser/            # CDP automation, web fetch, vision
    assistant/          # Identity state, feedback whisper
    watchdog/           # Error monitoring (opt-in)
    evolve/             # Self-maintenance (opt-in)
    rate-limiter/       # Usage throttling (opt-in)
    agent-environment/  # Runtime context (opt-in)
  lib/                  # Shared libraries
    extension-state.ts      # Session-scoped state factory
    evidence-pool.ts        # Evidence tracking + conflict detection
    conflict-qa.ts          # Conflict QA + resolution questions
    error-classifier.ts     # Error classification + retry logic
    ... (20 more)
skills/                 # Bundled agent skills
test/runtime/           # Runtime tests (.mjs)
```

## Module System

Extensions are grouped into **modules** (`src/modules/definitions.ts`). Each module
maps to a research track or logical concern:

| Module | Research | Extensions | Toggleable |
|--------|----------|------------|------------|
| `core` | Foundation | polyfill, metacognition, planner, scratchpad, preprocessor | Always on |
| `cognitive` | RepE contrast, evidence | cognitive-systems, reasoning, enforcement, verification, topic-drift | Yes |
| `memory` | Three memory stores (2604.14475) | three-memory-stores, session-recall, context-manager, context-lifecycle | Yes |
| `heartbeat` | Cognitive scheduling (2604.14178) | heartbeat-scheduler, analytics | Yes |
| `retry` | Error recovery | retry, error-capture | Yes |
| `prompt` | Prompt management | prompt-builder, prompt-guardian | Yes |
| `tools` | Utility tools | codebase-tree, repl, docs, healthcheck, timer, latent-activator | Yes |
| `browser` | Web interaction | browser, web-fetch, vision | Yes |
| `assistant` | UX & feedback | assistant, feedback | Yes |
| `evolve` | Self-maintenance | evolve | Opt-in |
| `watchdog` | Error monitoring | watchdog | Opt-in |
| `rate-limiter` | Usage throttling | rate-limiter | Opt-in |
| `agent-environment` | Runtime context | agent-environment | Opt-in |

### Config-Driven Loading

Modules are loaded based on `BRAID_MODULES` environment variable:

```bash
# Enable everything (default)
export BRAID_MODULES="all"

# Enable specific modules (opt-in mode)
export BRAID_MODULES="core,cognitive,memory,retry"

# Start from defaults, disable specific modules
# (format not supported yet — use runtime API instead)
```

### Subagent API (runtime toggling)

Researcher subagents can toggle modules during benchmark sessions:

| Command | Effect |
|---------|--------|
| `/modules-list` | Show all modules and their state |
| `/modules-enable <name>` | Enable a module (next session) |
| `/modules-disable <name>` | Disable a module (next session) |
| `/modules-toggle <name>` | Toggle a module on/off |
| `/modules-status` | Show current load state |
| `/modules-reset` | Reset all runtime overrides |

This enables A/B testing of feature sets without editing config.

## Build & Test

- **Type check**: `npm run typecheck`
- **Build**: `npm run build` (tsc tree output to `dist/`)
- **Run locally**: `pi -e /Users/kifir/projects/agents/pi-braid/src/index.ts`
- **Run tests**: `npm test`
- **Clean**: `npm run clean`

## State Management

- Use `getExtensionState(ctx, key, factory)` for session-scoped state
- Never use module-level `let` for mutable state (except disk-persisted config)
- Event handlers receive `(event, ctx: ExtensionContext)` as parameters
- Tool execute functions receive `(toolCallId, params, signal, onUpdate, ctx)`

## Document & Visual Tool Decision Tree

When working with PDFs, images, or screenshots, use this decision tree:

```
Is it a PDF?
├── YES → Is it text-based (selectable text)?
│   ├── YES → read_document (extracts text, fastest)
│   └── NO / UNSURE → render_pdf_page (renders page as PNG)
│       → analyze_image (visual analysis of the PNG)
└── NO → Is it an image/screenshot?
    ├── YES → analyze_image (visual/UI/layout analysis)
    └── NO → read_document (doc, docx, html, txt, rtf)
```

**Key rules:**
- `read_document` → **TEXT EXTRACTION** from documents. Never use for visual analysis.
- `render_pdf_page` → **RENDER** PDF page as image. Use when PDF is image-based or has complex layouts.
- `analyze_image` → **VISUAL ANALYSIS** (UI elements, sprites, layout, design critique). NOT OCR. For text in images, use `read_document` first.
- `browser_screenshot` → **CAPTURE** browser viewport as image. Returns `details.filePath` for follow-up `analyze_image`.
- `web_fetch` → **FETCH** web page as markdown. Has browser headers to bypass anti-bot. Returns clean markdown.

## Key Conventions

- Extensions register via `pi.registerTool()` and `pi.on("event", handler)`
- Tools added by extensions are auto-enabled on first session (fixes missing tools bug)
- Prompt-builder completely overrides system prompt (no native loading)
- Decompose large handlers into `handlers/*.ts` sub-modules