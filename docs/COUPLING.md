# Extension Coupling Map

How pi-braid's 35 extensions connect through events, tools, and state.

## Event Flow Diagram

```
                    ┌─────────────────────────────────────┐
                    │           session_start              │
                    │  polyfill, agent-env, assistant,    │
                    │  analytics, watchdog, memory,        │
                    │  retry, enforcement, context-life,   │
                    │  prompt-guardian, latent-activator,  │
                    │  context-manager                     │
                    └──────────┬──────────────────────────┘
                               │
                    ┌──────────▼──────────────────────────┐
                    │         before_agent_start            │
                    │  polyfill, prompt-guardian,           │
                    │  prompt-builder, reasoning, feedback  │
                    └──────────┬──────────────────────────┘
                               │
                    ┌──────────▼──────────────────────────┐
                    │            agent_start                │
                    │  watchdog, feedback                   │
                    └──────────┬──────────────────────────┘
                               │
              ┌────────────────┼────────────────┐
              │                │                │
    ┌─────────▼──────┐ ┌──────▼───────┐ ┌─────▼──────────┐
    │    input       │ │  tool_call   │ │  message_end   │
    │ enforcement   │ │  enforcement  │ │  enforcement   │
    │ retry         │ │  heartbeat    │ │  watchdog      │
    │ ux            │ │  feedback     │ │  reasoning     │
    │ preprocessor  │ │  context-life │ │  feedback      │
    └─────────┬──────┘ └──────┬───────┘ │  agent-env     │
              │               │         └─────┬──────────┘
              │               │               │
              │    ┌──────────┘               │
              │    │                          │
    ┌─────────▼────▼──────────────────────────▼──────┐
    │                  agent_end                      │
    │  heartbeat, watchdog, memory, retry, ux,        │
    │  preprocessor                                    │
    └───────────────────────┬──────────────────────────┘
                            │
              ┌─────────────┼─────────────┐
              │             │             │
    ┌─────────▼──────┐ ┌────▼────┐ ┌─────▼──────────┐
    │   turn_end     │ │session  │ │ session_compact │
    │  analytics    │ │shutdown │ │ enforcement     │
    │  heartbeat   │ │analytics│ │                  │
    │  memory      │ │heartbeat│ └──────────────────┘
    │  enforcement│ │guardian │
    │  feedback   │ │memory   │
    │  timer      │ │enforce  │
    │  session-rec│ │evolve   │
    │  error-capt │ │browser  │
    └──────────────┘ └─────────┘
```

## Extensions per Event (Count)

| #Listeners | Event                                                                                                                                             |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 11         | `session_start`                                                                                                                                   |
| 8          | `session_shutdown`                                                                                                                                |
| 7          | `agent_end`                                                                                                                                       |
| 6          | `turn_end`                                                                                                                                        |
| 5          | `message_end`                                                                                                                                     |
| 5          | `before_agent_start`                                                                                                                              |
| 4          | `input`                                                                                                                                           |
| 4          | `tool_call`                                                                                                                                       |
| 3          | `tool_end`                                                                                                                                        |
| 3          | `agent_start`                                                                                                                                     |
| 3          | `auto_retry_end`                                                                                                                                  |
| 2          | `tool_execution_end`                                                                                                                              |
| 1          | `session_tree`, `session_compact`, `tool_execution_start`, `after_provider_response`, `auto_retry_start`, `model_select`, `context`, `turn_start` |

## Coupling Map by Module

| Module           | Key Events                                                           | Coupled With                                                              | Research Paper |
| ---------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------- | -------------- |
| **core**         | session_start, before_agent_start, agent_end, input                  | enforcement, prompt                                                       | —              |
| **cognitive**    | 10+ events (enforcement pervasive)                                   | memory (tool_end, turn_end), retry (auto_retry_end), heartbeat (turn_end) | RepE Contrast  |
| **memory**       | session_start, shutdown, agent_end, tool_end, turn_end, model_select | cognitive (turn_end), heartbeat (shutdown)                                | 2604.14475     |
| **heartbeat**    | turn_end, tool_call, session_start, shutdown, tool_execution         | cognitive (turn_end), memory (shutdown)                                   | 2604.14178     |
| **retry**        | session_start, input, agent_end, turn_end, auto_retry                | cognitive (auto_retry_end)                                                | —              |
| **prompt**       | before_agent_start, session_start, shutdown                          | core                                                                      | —              |
| **tools**        | turn_end (timer only)                                                | —                                                                         | —              |
| **browser**      | session_shutdown                                                     | —                                                                         | —              |
| **assistant**    | session_start, agent_start, message_end, tool_call, turn_end         | cognitive (message_end)                                                   | —              |
| **watchdog**     | session_start, agent_end, message_end                                | —                                                                         | —              |
| **evolve**       | session_shutdown                                                     | —                                                                         | —              |
| **rate-limiter** | session_shutdown, context                                            | —                                                                         | —              |

## Module Loading Order (Resolved Dependencies)

```
core → cognitive, memory, retry, prompt, tools, browser, assistant
core + memory → heartbeat
```

Opt-in modules load after their dependencies: evolve (core), watchdog (core), rate-limiter (core), agent-environment (core).
