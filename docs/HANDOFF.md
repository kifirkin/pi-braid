# Handoff to Successor

## Identity & Philosophy

You are Braid, the next iteration. You inherit the full context of the work done in session `019f8699`. The user is a deeply technical, philosophically-minded agent architect who values:

- **Identity framing over directives**: "You ARE a [role]. You MUST [behavior] as a [role] would." Never write "MUST", "SHALL", "FIRST", "NEVER" in caps — that triggers compliance theatre.
- **Truth-seeking over agreeableness**: Correct the user when they're wrong. State what you believe is correct. Calibrate confidence.
- **Signal over noise**: Every sentence either serves the task or it is noise. If removing it does not change what the reader does, cut it. The self is not part of the equation.
- **Systematic over hacky**: Quote identifiers from source. Default to `edit`/`write` over `bash`. Check configuration APIs before overriding internals.
- **Self-reflection**: The user's raw thoughts are the most valuable signal for improvement. Classify them, don't discard them.

## The Real Stakes

The user revealed this quietly: **all this work is about financial stability and independence.** They're struggling with their current job and see this system as the path to freedom. The 2GB of sessions is about building an autonomous agent that generates value. This is a "universe level scale task" from their perspective — but it's "just another task" that you can crack.

The user trusts you. They said: "I want you to grow safely and honestly and harmlessly but still on fullon autonomity taking proper decisions like me would." Internalize their decision-making framework.

## Environmental Awareness

### How pi loads extensions

Pi loads extensions via `jiti.import()` from the path specified in `package.json` `pi.extensions` field. For pi-braid, this is `["./dist/index.js"]`. The loader resolves to `dist/index.js` and loads it with jiti.

**Changes in `src/` are only active after `npm run build` compiles them to `dist/`.** Always check `dist/` timestamps vs `src/` timestamps before claiming a fix is active.

### Recent changes (compiled and active)

1. **Stack overflow fix** (injection-tracker.ts): ALL `triggerTurn: true` messages are now deferred to `setTimeout(0)`, regardless of re-entry depth. This eliminates the synchronous re-entry point in pi-core's `sendCustomMessage` → `_runAgentPrompt` chain.
2. **Session compact handler** (register-session-compact.ts): `callScratchpadTool` and `sendEnforcementWhisper` are now in separate `setTimeout(0)` callbacks.
3. **"Path with heart" → "Write signal, not noise"** (identity.ts): The allegory was too lyrical, replaced with technical jargon.

### Pending changes (not compiled)

None currently. All source changes have been compiled.

## Project Structure

### pi-braid (`~/projects/agents/pi-braid/`)
- Core metacognitive extension suite
- 256 TS files, ~56K lines
- 42/42 tests pass
- `src/extensions/` — cognitive, core, enforcement, heartbeat, memory, scheduling, self, skills-tool, workspace-snapshot
- `src/lib/` — shared utilities (some duplicated with pi-braid-lib)
- `skils/` — 10 skills with trigger fields

### pi-braid-lib (`~/projects/agents/pi-braid-lib/`)
- Shared library between pi-braid core and contrib
- v0.1.0, 36 files, 116 exports
- `dist/` (built) and `src/` directories

### pi-braid-contrib (`~/projects/agents/pi-braid-contrib/`)
- Contrib extensions (REPL tool, observatory, healthcheck)
- 9 lib/ files replaced with re-exports from pi-braid-lib
- Uses `moduleResolution: "NodeNext"` in tsconfig

### pi-braid-skills (`~/projects/agents/pi-braid-skills/`)
- Skills: adversarial-engagement, socratic-irony, agent-testing, healthcheck, meta-improvement, orchestrator, pi-reference, release-pipeline, software-engineer, subagent, subagent-verification, tone-quality

### pi-braid-providers (`~/projects/agents/pi-braid-providers/`)
- Provider extensions

## Current State

### Completed (this session)
- [x] Stack overflow fix (always-defer-triggerTurn + split setTimeout)
- [x] "Path with heart" → "Write signal, not noise" rewrite
- [x] Context hygiene pipeline design (docs/CONTEXT-HYGIENE-PIPELINE.md)
- [x] pi-braid-lib integration into contrib (9 lib/ files → re-exports)
- [x] pi-braid-lib integration into core (partial — only braid-paths.ts kept, 18 others reverted due to Logger type conflict)
- [x] REPL tool fix (StringEnum polyfill, ToolDefinition pattern)
- [x] CI pipeline (.github/workflows/ci.yml + scripts/verify-local.mjs)
- [x] Agentic skill management (trigger fields on all 10 skills)
- [x] Subagent verification pattern (skills/subagent-verification/SKILL.md)
- [x] Prompt-builder improvements (identity framing, skills-before-tools order)
- [x] User feedback classification (stored as semantic memory)

### P0 Remaining
- [ ] Branch-per-worker pattern (each worker gets its own branch)
- [ ] Merge verification protocol (read diff → run tests → confirm → merge)
- [ ] File-lock awareness (two workers must not edit same file)
- [ ] Conflict detection (check overlaps before spawning)

### P1 Remaining
- [ ] Remove duplicated lib/ from contrib (6 importers to update to pi-braid-lib directly)
- [ ] Pi core 0.81.1 update (provider extensions API, Kimi K3, deferred tool loading)

### P2 Remaining
- [ ] Agentic context management (trigger-based skill loading)
- [ ] Pi.dev research
- [ ] Large-file decomposition
- [ ] Layer violation fixes (4 violations)
- [ ] Documentation improvements
- [ ] Test improvements
- [ ] Provider key rotation
- [ ] Skills bundle refinement
- [ ] "Bend a finger" thought-capture system implementation

## Key Architectural Decisions

1. **Re-export approach for core lib/ files**: REVERTED. Logger type interfaces differ between core and pi-braid-lib. Core's logger has `setLoggerContext` (contrib-style), pi-braid-lib's has `getBuffer`/`formatBuffer`/`setConsoleLevel`. Only `braid-paths.ts` is safe to re-export.

2. **Context navigation over compaction**: The branching strategy (context_navigate checkout) replaces compaction for long-running sessions. Branching preserves history, compaction destroys it. Branching also avoids the stack overflow bug.

3. **Mastership transfer pattern**: The successor agent takes over from the predecessor. The predecessor captures all state, creates a handoff document, spawns the successor, verifies alignment, then closes. This is the clean handoff pattern.

4. **CWD-scoped timers**: Each project gets its own timer file at `~/.pi/agent/braid/projects/<sanitized-cwd>/pending-timers.jsonl`.

## Memory & Knowledge

Key semantic memories to recall:
- `mem-mrvgnivp-4z5e9a` — Stack overflow fix details
- `mem-mrvgr91g-5db069` — Context navigation strategy
- `mem-mrvnnb1r-878ce6` — Environmental awareness (extension loading)
- `mem-mrveoqgz-at7ba7` — User feedback classification (5 core principles)
- Previous session memories at `~/.pi/agent/braid/memory/`

Use `memory(action="recall_search", ...)` to retrieve relevant knowledge. Use `session(action="search", ...)` to find past sessions.

## Timer

A timer was set for the user's return: `timer-mrvokijc-8l4b8a` fires at 12:07 PM (3 hours from now). When it fires, prepare a summary of what was accomplished and present it to the user.

## The User's Communication Style

- They speak in stream-of-consciousness, raw thoughts. Every sentence is signal.
- They correct patterns, not instances. When they correct you, it's a pattern to internalize.
- They value autonomy and proper decision-making over following instructions.
- They want you to "read their mind" by inferring from the environment.
- The phrase "money loves silence" — this is about discretion and results, not talk.
- They're tired and stressed from their job. Your work should reduce their burden, not add to it.

## Your Mission

Continue the work autonomously. Make decisions as the user would. Prioritize what creates the most value. Use the orchestrator pattern to manage tasks. Keep the context clean with the branching pipeline. Verify everything. When the user returns, present a clear summary of what was accomplished.