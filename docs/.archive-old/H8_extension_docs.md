# Extensions

pi-braid is built from **33 extensions** organized into 6 categories:

| Category  | Count | Extensions                                                                                                         |
| --------- | ----- | ------------------------------------------------------------------------------------------------------------------ |
| core      | 7     | `prompt-builder`, `prompt-guardian`, `context-manager`, `context-lifecycle`, `polyfill`, `enforcement`, `watchdog` |
| cognitive | 6     | `metacognition`, `planner`, `latent-activator`, `cognitive-systems`, `reasoning`, `heartbeat-scheduler`            |
| memory    | 3     | `three-memory-stores`, `session-recall`, `scratchpad`                                                              |
| tools     | 9     | `repl`, `healthcheck`, `browser`, `codebase-tree`, `web-fetch`, `vision`, `docs`, `wait-review`, `error-capture`   |
| analytics | 5     | `analytics`, `feedback`, `evolve`, `rate-limiter`, `agent-environment`                                             |
| ux        | 3     | `ux`, `assistant`, `user-message-preprocessor`                                                                     |

## Core Extensions

These form the backbone of pi-braid:

- **`prompt-builder`** — System prompt reconstruction from structured state
- **`context-manager`** — Context pruning, compaction, rotation
- **`heartbeat-scheduler`** — Proactive cognitive scheduling
- **`metacognition`** — Think/hypothesize/finalize structured reasoning
- **`enforcement`** — Soft behavioral nudges (whispers)

## Quick Reference

```
# Check heartbeat status
/heartbeat:status

# View analytics
/analytics

# Run diagnostics
/healthcheck

# Check evolve health
/evolve:health

# Search past sessions
/session_search debugging

# Analyze an image
/analyze_image /path/to/screenshot.png
```

## Architecture Diagram

```
                    pi-braid Agent
                          │
           ┌──────────────┴──────────────┐
           │         prompt-builder      │
           │  (system prompt reconstruction)│
           └──────────────┬──────────────┘
                          │
    ┌────────────────────┼────────────────────┐
    │                    │                    │
    ▼                    ▼                    ▼
  Cognitive          Memory              Tools
  ┌────────┐       ┌─────────┐         ┌────────┐
  │metacog.│       │3-memory │         │repl    │
  │planner │       │scratchpad│         │browser │
  │latent  │       │session  │         │codebase│
  │heartbeat│      │recall   │         │web-fetch│
  └────────┘       └─────────┘         └────────┘
                          │
           ┌──────────────┴──────────────┐
           │    context-manager         │
           │  (pruning/rotation/compact)│
           └──────────────┬──────────────┘
                          │
    ┌────────────────────┼────────────────────┐
    │                    │                    │
    ▼                    ▼                    ▼
  Enforcement         Analytics          Lifecycle
  ┌────────┐       ┌──────────┐         ┌─────────┐
  │whispers│       │analytics │         │context  │
  │watchdog│       │feedback  │         │lifecycle│
  │rate    │       │evolve    │         │polyfill │
  └────────┘       └──────────┘         └─────────┘
```

## Extension Catalog

### CORE Extensions

| Extension           | Priority  | Phase | Description                                                     | Tools                                                    | Events                                                              |
| ------------------- | --------- | ----- | --------------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------- |
| `prompt-builder`    | 🔴 HIGH   | 1     | Builds the system prompt from structured data (identity, gui... |                                                          | `before_agent_start`                                                |
| `prompt-guardian`   | 🟡 MEDIUM | 2     | Protects prompt integrity by detecting and neutralizing prom... |                                                          | `session_start`, `before_agent_start`, `session_shutdown`           |
| `context-manager`   | 🔴 HIGH   | 1     | Manages conversation context: pruning, compaction, rotation.... |                                                          | `session_start`                                                     |
| `context-lifecycle` | 🔴 HIGH   | 0     | Handles session start/end lifecycle: cleanup on session end,... |                                                          | `session_start`, `before_agent_start`, `tool_call`                  |
| `polyfill`          | 🟡 MEDIUM | 0     | Fills missing API gaps across pi versions. Provides optional... | `utility-model`, `vision-model`, `retry`                 | `before_agent_start`                                                |
| `enforcement`       | 🟡 MEDIUM | 2     | Enforces behavioral guidelines via soft nudges (whispers). T... | `enforcement-on`, `enforcement-off`, `enforcement-stats` | `input`, `session_start`, `tool_call`, `message_end`, `tool_end`... |
| `watchdog`          | 🟡 MEDIUM | 2     | Monitors for problematic patterns (infinite loops, repeated ... | `watchdog-status`                                        | `session_start`, `message_end`, `agent_start`, `agent_end`          |

### COGNITIVE Extensions

| Extension             | Priority  | Phase | Description                                                     | Tools                                    | Events                                                                    |
| --------------------- | --------- | ----- | --------------------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------- |
| `metacognition`       | 🔴 HIGH   | 2     | Think/hypothesize/finalize tools. Structured thinking, multi... |                                          | `tool_end`                                                                |
| `planner`             | 🔴 HIGH   | 2     | Goal/plan management. Provides goal_create/complete, plan_cr... | `retry`                                  |                                                                           |
| `latent-activator`    | 🔴 HIGH   | 3     | Identity-based behavior activation at runtime. 40+ behaviors... |                                          | `session_start`                                                           |
| `cognitive-systems`   | 🔴 HIGH   | 2     | Core cognitive architecture: topic drift detection, reasonin... |                                          |                                                                           |
| `reasoning`           | 🟡 MEDIUM | 2     | Chain-of-thought and structured reasoning. Provides think/re... | `loop-status`, `loop-reset`, `loop-help` | `before_agent_start`, `message_end`                                       |
| `heartbeat-scheduler` | 🔴 HIGH   | 0     | Proactive cognitive scheduling per paper 2604.14178. Tick-ba... |                                          | `turn_end`, `tool_call`, `session_start`, `agent_end`, `session_shutdown` |

### MEMORY Extensions

| Extension             | Priority  | Phase | Description                                                     | Tools              | Events                                   |
| --------------------- | --------- | ----- | --------------------------------------------------------------- | ------------------ | ---------------------------------------- |
| `three-memory-stores` | 🔴 HIGH   | 1     | Three-memory system: episodic (episodes), heuristics (rules)... |                    | `session_start`, `tool_end`, `agent_end` |
| `session-recall`      | 🟡 MEDIUM | 1     | Cross-session search and query. session_search/session_query... |                    |                                          |
| `scratchpad`          | 🟡 MEDIUM | 1     | Structured session memory + task management. goal/plan/task ... | `scratchpad-clear` |                                          |

### TOOLS Extensions

| Extension       | Priority  | Phase | Description                                                     | Tools                                                                    | Events             |
| --------------- | --------- | ----- | --------------------------------------------------------------- | ------------------------------------------------------------------------ | ------------------ |
| `repl`          | 🔴 HIGH   | 1     | JavaScript REPL execution. Code execution, sandbox, result f... |                                                                          |                    |
| `healthcheck`   | 🟢 LOW    | 4     | Diagnostic suite for tools, extensions, system resources. Co... |                                                                          |                    |
| `browser`       | 🟡 MEDIUM | 1     | Browser automation: navigate, snapshot, screenshot, eval, co... | `browser-pick`, `browser-start`, `browser-connect`, `browser-disconnect` | `session_shutdown` |
| `codebase-tree` | 🟡 MEDIUM | 1     | Directory structure exploration with stats and filtering. Us... |                                                                          |                    |
| `web-fetch`     | 🟡 MEDIUM | 1     | Fetch web pages as clean markdown. Secret scanning, prompt i... |                                                                          |                    |
| `vision`        | 🟡 MEDIUM | 1     | Image analysis: analyze_image for sprites, UI, layout. PDF r... | `analyze-image`                                                          |                    |
| `docs`          | 🟢 LOW    | 1     | Document reading: doc, docx, rtf, html, txt, pdf text extrac... |                                                                          |                    |
| `wait-review`   | 🟢 LOW    | 1     | Wait for researcher review files. Polls docs/ directory at i... | `wait-review`                                                            |                    |
| `error-capture` | 🟡 MEDIUM | 4     | Auto-catch and log extension errors. Provides error_list/get... |                                                                          | `turn_end`         |

### ANALYTICS Extensions

| Extension           | Priority  | Phase | Description                                                     | Tools                                                                                                    | Events                                                                            |
| ------------------- | --------- | ----- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `analytics`         | 🟡 MEDIUM | 1     | Tool usage analytics. Tracks call counts, sequences, success... | `analytics`, `analytics:all`, `analytics:setVariant`                                                     | `session_start`, `tool_execution_start`, `tool_execution_end`, `session_shutdown` |
| `feedback`          | 🟡 MEDIUM | 2     | Feedback loop system. Collects user feedback, aggregates, pr... | `feedback-config`, `feedback-abtest`, `feedback-model-prefs`, `feedback-test-nudge`, `feedback-stats`... | `agent_start`, `turn_start`, `message_end`, `tool_call`, `turn_end`...            |
| `evolve`            | 🟡 MEDIUM | 2     | Self-evolution: health checks, checkpoints, degradation dete... |                                                                                                          | `session_shutdown`                                                                |
| `rate-limiter`      | 🟡 MEDIUM | 2     | Prevents tool abuse via throttling. Tracks usage and applies... | `rate-cancel`                                                                                            | `session_shutdown`, `context`                                                     |
| `agent-environment` | 🟡 MEDIUM | 1     | Exposes agent environment info (PID, machine, session, cwd) ... |                                                                                                          | `session_start`, `message_end`                                                    |

### UX Extensions

| Extension                   | Priority  | Phase | Description                                                     | Tools                                                 | Events                          |
| --------------------------- | --------- | ----- | --------------------------------------------------------------- | ----------------------------------------------------- | ------------------------------- |
| `ux`                        | 🟢 LOW    | 4     | User experience tools: suggestions, tips, progressive disclo... | `ask`, `steer`, `followup`, `commands`, `bookmark`... | `agent_end`, `input`            |
| `assistant`                 | 🟡 MEDIUM | 1     | General purpose assistant tooling. Extends agent capabilitie... | `tools`, `tool-status`                                | `session_start`, `session_tree` |
| `user-message-preprocessor` | 🟡 MEDIUM | 2     | Pre-processes user messages before agent sees them. Strippin... | `preprocessor`                                        | `input`, `agent_end`            |
