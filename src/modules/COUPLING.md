# Extension Coupling Map

## Events × Extensions Matrix

| Event | Listeners |
|-------|-----------|
| `session_start` | polyfill, grantee-environment, assistant, analytics, watchdog, three-memory-stores, retry, enforcement, context-lifecycle, prompt-guardian, latent-activator, context-manager |
| `session_shutdown` | analytics, heartbeat-scheduler, prompt-guardian, three-memory-stores, enforcement, evolve, browser, rate-limiter |
| `session_tree` | assistant |
| `session_compact` | enforcement |
| `before_agent_start` | prompt-guardian, prompt-builder, reasoning, feedback, polyfill |
| `agent_end` | heartbeat-scheduler, watchdog, three-memory-stores, retry, ux, user-message-preprocessor |
| `agent_start` | watchdog, feedback |
| `message_end` | watchdog, enforcement, reasoning, feedback, agent-environment |
| `turn_end` | analytics, heartbeat-scheduler, three-memory-stores, enforcement, feedback, timer, session-recall, error-capture |
| `turn_start` | feedback |
| `input` | enforcement, retry, ux, user-message-preprocessor |
| `tool_call` | heartbeat-scheduler, enforcement, feedback, context-lifecycle |
| `tool_end` | three-memory-stores, enforcement |
| `tool_execution_start` | analytics |
| `tool_execution_end` | analytics, metacognition |
| `after_provider_response` | retry |
| `auto_retry_start` | retry |
| `auto_retry_end` | enforcement, retry |
| `model_select` | session-recall |
| `context` | rate-limiter |
| `load` | polyfill |
| `transcription_ready` | feedback |

## Tool Registration

| Extension | Tools/Commands |
|-----------|---------------|
| metacognition | think, hypothesize, finalize, think-reflection |
| planner | planner, check-budget, set-budget |
| scratchpad | scratchpad |
| reasoning | reasoning (structured) |
| cognitive-systems | hypothesize/belief/conflict tools (6) |
| enforcement | (commands only) |
| verification | verify-claim, verify-decomposition |
| topic-drift | check-topic-drift, reset-topic-anchors |
| three-memory-stores | memory-search, memory-add, memory-list, memory-get |
| session-recall | session-search, session-query |
| context-manager | context-tag, context-compress, context-audit, context-proposals |
| context-lifecycle | conflict-qa, context-signal |
| heartbeat-scheduler | heartbeat-status |
| analytic | 3 analytic tools |
| error-capTURE | error-list, error-get, error-clear, error-stats |
| vision | analyze-image |
| healthcheck | healthcheck |
| timer | timer-set, timer-list, timer-cancel |
| web-fetch | web-fetch |
| browser | browser-navigate, browser-snapshot, browser-eval, browser-screenshot, browser-cookies, browser-content |
| ephemeral | 3 latent activator tools |
| codebase-tree | codebase-tree |
| docs | read-document, render-pdf-page |
| agent-environment | evolve tools |
| user-message-preprocessor | 2 preprocessor tools |

## Shared Library Dependencies

- `extension-state.ts` — heartbeat, context-lifecycle, metacognition, planner, topic-drift, three-memory-stores
- `model-resolver.ts` — polyfill, vision
- `language-hint.ts` — enforcement, user-message-preprocessor
- `reasoning-metrics.ts` — heartbeat
- `evidence-pool.ts` — cognitive-systems
- `timer-bus.ts` — timer, enforcement
- `degradation-detector.ts` — evolve
