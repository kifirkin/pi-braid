# pi-braid

Self-contained [pi](https://github.com/badlogic/pi-mono) extension bundling develop-branch functionality: cognitive systems, planning, enforcement, context management, and advanced tools.

## What's Included

### Extensions (25)

| Extension | Purpose |
|-----------|---------|
| `polyfill` | Patches ctx.getUtilityModel/getVisionModel onto ExtensionContext |
| `prompt-builder` | Replaces system prompt with develop-branch identity framing |
| `enforcement` | Tool usage validation with whisper-based nudges |
| `feedback` | Smart nudge and whisper system |
| `cognitive-systems` | Memory, knowledge integration, pattern learning |
| `context-manager` | Tag, log, checkout, prune, audit tools + session lifecycle |
| `scratchpad` | Per-loop persistent state with task management |
| `session-recall` | Search and query past sessions |
| `planner` | Goals, plans, and execution control |
| `metacognition` | Think, hypothesize with depth analysis |
| `error-capture` | Automatic error logging and recovery |
| `analytics` | Tool usage analytics and statistics |
| `evolve` | Self-evolution and health monitoring |
| `vision` | Image analysis with model resolution |
| `pijul-checkpoint` | Version control with Pijul |
| `codebase-tree` | Fast directory tree exploration |
| `healthcheck` | System capability validation |
| `prompt-guardian` | Block prompt injection |
| `user-message-preprocessor` | Message preprocessing |
| `rate-limiter` | RPM/TPM rate limiting |
| `reasoning` | Loop detection and reasoning state |
| `watchdog` | Session health monitoring |
| `repl` | Interactive code execution |
| `docs` | Documentation access |
| `file-tool` | File info commands |

### Tools (37 registered)

```
memory_store, memory_recall, memory_list, memory_get,
context_tag, context_log, context_checkout, context_prune, context_audit,
think, hypothesize,
scratchpad,
goal, plan, finalize,
signal_complete, signal_stuck,
error_list, error_get, error_clear, error_stats,
healthcheck, evolve, feedback_status,
read_document, analyze_image,
pijul_log, pijul_reset, pijul_surgical_rewind,
codebase_tree,
list_deleted_prompts, recover_prompt, save_current_prompt,
preprocessor_config, preprocessor_stats,
check_resources, set_budget, record_usage,
tool_usage_patterns, explore_paths,
session_search, session_query
```

### Skills (13)

`code-search`, `codebase-summary`, `compliance-audit`, `healthcheck`, `hyperagents-evolution`, `paper-writer`, `pi-reference`, `process-control`, `skill-creator`, `software-engineer`, `vcs-tools`, `visual-validator`, `web-search`

### Commands (23)

`/utility-model`, `/vision-model`, `/retry`, `/analytics`, `/analytics:all`, `/enforcement-on`, `/enforcement-off`, `/enforcement-stats`, `/feedback-*`, `/preprocessor`, `/watchdog-status`, `/rate-cancel`, `/analyze-image`, `/loop-*`, `/scratchpad-clear`, `/file-info`

## Installation

```bash
pi -e /path/to/pi-braid
```

Or in settings.json:

```json
{
  "extensions": ["/path/to/pi-braid"]
}
```

## Architecture

```
pi-braid/
├── src/
│   ├── index.ts           # Main entry point (loads 25 extensions)
│   ├── extensions/        # Extension modules
│   ├── lib/               # Utility modules (cognitive-memory, planner, etc.)
│   └── tools/             # Tool definitions
├── skills/                # 13 skill directories
├── docs/                  # Documentation
├── package.json           # pi.extensions = ["./src/index.ts"]
└── tsconfig.json
```

## Dependencies

- `@sinclair/typebox`
- `@mariozechner/pi-coding-agent` (peer)
- `@mariozechner/pi-agent-core` (peer)
- `@mariozechner/pi-ai` (peer)

## License

MIT
