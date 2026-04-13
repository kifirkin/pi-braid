# pi-braid

Self-contained [pi](https://github.com/badlogic/pi-mono) extension bundling all develop-branch functionality: cognitive systems, planning, enforcement, feedback, skills, and advanced tools.

## What's Included

### 55 Tools

| Category | Tools |
|----------|-------|
| **Planning** | `task_add`, `task_complete`, `task_fail`, `task_list`, `task_next`, `goal_create`, `goal_decompose`, `goal_complete`, `goal_fail`, `goal_block`, `goal_list`, `plan_create`, `plan_start`, `plan_step_complete`, `plan_step_fail`, `plan_adapt`, `plan_complete`, `plan_list` |
| **Metacognition** | `think`, `hypothesize`, `scratchpad` |
| **Cognitive** | `memory_store`, `memory_recall`, `memory_list`, `memory_get`, `store_documentation`, `search_documentation`, `get_by_topic`, `get_all_docs`, `store_pattern`, `search_patterns`, `get_patterns_by_repo`, `get_all_patterns`, `get_knowledge_summary`, `export_to_markdown`, `explore_paths` |
| **Agent Control** | `signal_complete`, `signal_stuck`, `finalize` |
| **Diagnostics** | `healthcheck`, `evolve`, `enforcement_status`, `enforcement_reset`, `feedback_status`, `preprocessor_config`, `preprocessor_stats` |
| **Documents** | `read_document`, `analyze_image` |
| **VCS** | `pijul_log`, `pijul_reset`, `pijul_surgical_rewind` |
| **Context** | `codebase_tree`, `list_deleted_prompts`, `recover_prompt`, `save_current_prompt` |

### 16 Skills

`code-search`, `codebase-summary`, `compliance-audit`, `healthcheck`, `hyperagents-evolution`, `paper-writer`, `pi-docs`, `pi-internals`, `pijul-checkpoint`, `process-hygiene`, `skill-creator`, `software-engineer`, `tmux`, `visual-validator`, `web-search`, `workspace-manager`

### 21 Extension Modules

| Extension | Purpose |
|-----------|---------|
| `polyfill` | Patches `ctx.getUtilityModel()`/`ctx.getVisionModel()` onto ExtensionContext (develop API on upstream_main) |
| `prompt-builder` | Replaces system prompt with develop-branch identity framing via `before_agent_start` |
| `planner` | Tasks, goals, plans, and execution control |
| `metacognition` | Self-awareness: think, hypothesize, time tracking |
| `scratchpad` | Per-loop task state persistence |
| `cognitive-systems` | Memory, knowledge integration, pattern learning |
| `docs` | Documentation access |
| `pijul-checkpoint` | Version control with Pijul |
| `codebase-tree` | Fast directory tree exploration |
| `healthcheck` | System capability validation |
| `prompt-guardian` | Block prompt injection |
| `evolve` | Self-evolution commands |
| `enforcement` | Tool usage enforcement and validation |
| `feedback` | Smart nudge and whisper system |
| `user-message-preprocessor` | Clean and preprocess user messages via utility model |
| `watchdog` | Session health monitoring |
| `rate-limiter` | RPM/TPM rate limiting for LLM calls |
| `vision` | Vision image analysis with configured models |
| `reasoning` | Loop detection and reasoning state tracking |
| `file-tool` | Additional file manipulation tools |

## Installation

### Option 1: Quick test with `-e` flag

```bash
pi -e /path/to/pi-braid
```

### Option 2: Global extensions directory

```bash
# Symlink or copy to global extensions
ln -s /path/to/pi-braid ~/.pi/agent/extensions/pi-braid
```

### Option 3: Settings.json

```json
{
  "extensions": ["/path/to/pi-braid"]
}
```

### Option 4: As a pi package (npm/git)

```json
{
  "packages": ["git:github.com/your-org/pi-braid"]
}
```

### 22 Commands

`/utility-model [pattern|clear]`, `/vision-model [pattern|clear]`, `/file-info`, `/retry`, `/analytics`, `/analytics:all`, `/enforcement-on`, `/enforcement-off`, `/enforcement-stats`, `/feedback-config`, `/feedback-abtest`, `/feedback-model-prefs`, `/feedback-test-nudge`, `/feedback-stats`, `/feedback-reset`, `/feedback-report`, `/preprocessor`, `/watchdog-status`, `/rate-cancel`, `/analyze-image`, `/loop-status`, `/loop-reset`, `/loop-help`

**Note**: `/retry` provides abort functionality on upstream_main. Full retry (removing last message and re-running) requires the develop branch with `session.continue()`.

## Architecture

```
pi-braid/
├── src/
│   ├── index.ts           # Main entry point
│   ├── extensions/        # 22 extension modules
│   ├── lib/               # 13 utility modules
│   └── tools/             # 17 tool definitions
├── skills/                # 16 skill directories
├── package.json           # pi.extensions config
└── tsconfig.json
```

All imports use the public `ExtensionAPI` from `@mariozechner/pi-coding-agent`. No private internals are used.

## Dependencies

- `@sinclair/typebox` — schema definitions for tool parameters
- `@mariozechner/pi-coding-agent` (peer) — ≥0.65.0
- `@mariozechner/pi-agent-core` (peer) — ≥0.65.0
- `@mariozechner/pi-ai` (peer) — ≥0.65.0

## License

MIT
