<!-- status: current -->
<!-- TOOLS.md - canonical tool inventory for the pi-braid core package (packages/core). -->

# pi-braid Core Package: Tool Catalog

Every tool provided or exposed by the pi-braid core package (`packages/core`),
with its purpose, its enablement condition (when it is available), and a
one-line reflection (why an agent would use it).

**Sync contract**: the `Reflection` column of the catalog table is the exact
string injected into the braid system prompt as a per-tool guideline when that
tool is enabled (see `src/extensions/core/prompt-builder/tool-guidelines.ts`).
The `tool-guidelines` describe-block in
`test/runtime/core/test-tool-pipelines.mjs` enforces exact one-to-one equality
between this table and the injected strings - change one side and the test
fails until the other catches up.

## How to read this catalog

- **Tool** - the LLM-facing tool name.
- **Purpose** - what the tool does (derived from its source description / promptSnippet).
- **Enablement** - when the tool is available: always-on extension, default-enabled extension (togglable), opt-in extension, or pi-core builtin.
- **Reflection** - one line on why/when an agent reaches for it; injected only `if has <tool>` (present in the active tool set).

## Tool universe

| Class                              | Count                                                                                                        | Notes                                                                                                                                                                                                                                                                              |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Braid-registered tools             | 24                                                                                                           | Registered via `pi.registerTool()` in `src/extensions/` - owned by this package                                                                                                                                                                                                    |
| pi-native core tools               | 9                                                                                                            | `read`/`bash`/`edit`/`write`/`grep`/`find`/`ls`/`powershell` - pi builtins surfaced through the package with stable one-liners (`TOOL_GUIDELINES`, `prompt-builder/tool-guidelines.ts`); `tool_search` is pi's built-in tool-search extension, activated by braid at session start |
| **Documented catalog**             | **33**                                                                                                       | the rows between the markers below                                                                                                                                                                                                                                                 |
| In-repo sibling `pi-braid-contrib` | 12 extensions                                                                                                | browser, codebase, diff, healthcheck, observatory, repl, sleep, system-monitor - **not owned by this package**, see appendix                                                                                                                                                       |
| Third-party npm packages           | web_search/fetch_content/source_check/get_search_content (pi-web-access); herdr\*\* (@ogulcancelik/pi-herdr) | **not owned by this package**, see appendix                                                                                                                                                                                                                                        |

## Enablement reference

Braid extension loading is resolved by `src/loader/loader.ts` (`resolveEnabledExtensions`, loader.ts:327)
with priority: runtime overrides (`/modules-*`) → `braid.modules` from two sources, the later
winning per id (`~/.pi/agent/settings.json`, then braid's own module-overrides store where those
toggles persist) → `BRAID_MODULES` env var → manifest defaults (`src/extensions/manifest.ts`). Always-on extensions (`alwaysOn: true`)
can never be disabled; opt-in extensions (`disabledByDefault: true`) only load when explicitly enabled.
Standalone packages (contrib, npm) load through pi's own package extension mechanism and keep their own
enablement (see appendix).

<!-- TOOLS-CATALOG-BEGIN -->

| Tool                 | Purpose                                                             | Enablement                                                                   | Reflection                                                                                                                                                                                                                                    |
| -------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `read`               | Read file contents (text and images)                                | pi-core builtin; always on                                                   | when: ground truth for anything on disk, incl. images as attachments, instead of cat or sed; when-not: content search (grep/find); args: path, offset for long files; caveat: text truncated at 2000 lines / 50KB                             |
| `bash`               | Execute shell commands (ls, grep, find, tests, git)                 | pi-core builtin; always on                                                   | when: tests, builds, git, shell pipelines, or inspecting PI-prefixed env vars for model/session details — anything without a dedicated tool; when-not: file read/edit; args: command + timeout; caveat: output truncated to 2000 lines / 50KB |
| `edit`               | Make precise file edits with exact text replacement                 | pi-core builtin; always on                                                   | when: one precise change to a known file; when-not: new files (write) or whole-file overhauls; args: oldText must match a UNIQUE region exactly; caveat: multiple edits in one call must not overlap                                          |
| `write`              | Create or overwrite files                                           | pi-core builtin; always on                                                   | when: create or overwrite a whole file; when-not: small tweaks to an existing file (edit); args: path + full content; caveat: truncates in place; a failed write can leave a partial file                                                     |
| `grep`               | Search file contents for patterns (respects .gitignore)             | pi-core builtin; always on                                                   | when: find where a symbol/string lives (file:line); when-not: full file contents (read); args: pattern + optional glob/path; caveat: respects .gitignore, 100-match / 50KB cap, long lines cut at 500 chars                                   |
| `find`               | Find files by glob pattern (respects .gitignore)                    | pi-core builtin; always on                                                   | when: locate files by name or glob without shelling out; when-not: content search (grep); args: glob pattern + optional path; caveat: respects .gitignore                                                                                     |
| `ls`                 | List directory contents                                             | pi-core builtin; always on                                                   | when: see what is actually in a directory before reading or running; args: path + limit; caveat: includes dotfiles, '/' suffix marks directories                                                                                              |
| `powershell`         | Execute PowerShell commands                                         | pi-core builtin; Windows shell                                               | when: PowerShell-only commands, or inspecting PI-prefixed env vars for model/session details; when-not: POSIX shells (bash); args: command + timeout; caveat: same truncation rules as bash                                                   |
| `tool_search`        | Search deferred tools and load the matches into the next request    | pi-core builtin (tool-search extension); activated by braid at session start | when: a tool you expected is missing from this list (braid defers its cold tools; this is how they come back); args: query + limit; caveat: matches are declared from your NEXT call, so load first, then call                                |
| `think`              | Deep structured reasoning before high-stakes decisions              | metacognition - alwaysOn (manifest.ts:93)                                    | when: high-stakes or hard-to-reverse decisions; args: decision + observation/reason/confidence                                                                                                                                                |
| `hypothesize`        | Generate root-cause hypotheses when a first fix fails               | metacognition - alwaysOn (manifest.ts:93)                                    | when: a first fix attempt failed and the root cause is unclear; args: problem + evidence; caveat: name a specific, verifiable failure mode — never vague                                                                                      |
| `finalize`           | Mark a task complete and record it to session memory                | metacognition - alwaysOn (manifest.ts:93)                                    | when: task fully done and verified; when-not: unresolved verify() (it blocks); args: summary + completed (+ tasksRemaining); caveat: call once per task, then text only                                                                       |
| `verify`             | Verify code, reasoning, or results after edits or when uncertain    | metacognition - alwaysOn (manifest.ts:93)                                    | when: after every edit, or any uncertain conclusion; when-not: finalizing before verification; args: target (code/reasoning/plan/result) + explicit criteria; caveat: name the failure mode each check guards                                 |
| `verify_claim`       | Verify agent claims against retrieved context                       | metacognition/claim-verification - alwaysOn (manifest.ts:93)                 | when: a conclusion depends on retrieved evidence; when-not: local code checks (verify); args: claim + context strings; caveat: action=decomposition for task-coverage checks                                                                  |
| `scratchpad`         | Structured session memory for goals, plans, decisions               | scratchpad - alwaysOn (manifest.ts:99)                                       | when: multi-step tasks — keep the resumable state here, it survives compaction; args: action (set_goal/add_plan/mark_done/…) + text                                                                                                           |
| `prompt_inspect`     | Show the current system prompt from runtime                         | prompt-builder - alwaysOn (manifest.ts:111)                                  | when: your own instructions feel ambiguous or prompt questions arise; args: match/truncate to filter long sections; caveat: shows the ASSEMBLED prompt                                                                                        |
| `system_info`        | Show the runtime environment (versions, paths, session, stats)      | prompt-builder - alwaysOn (manifest.ts:111)                                  | when: context or environment matters; args: detail=compact for essentials                                                                                                                                                                     |
| `workspace_snapshot` | Capture/list/diff/preview/restore workspace snapshots               | workspace-snapshot - alwaysOn (manifest.ts:123)                              | when: before risky multi-file edits — capture, then restore on failure; args: action capture/restore; caveat: restore applies only changed files                                                                                              |
| `set_tool_profile`   | Switch curated tool profiles (lean/research/debugging/browser/deep) | context-management - alwaysOn (manifest.ts:268)                              | when: task scope is known — focused profiles cut prompt noise and token cost; args: lean/research/debugging/browser/deep                                                                                                                      |
| `list_skills`        | Discover skills on demand (paginated catalog)                       | skills-tool - default-enabled (manifest.ts:228)                              | when: entering a domain that may have a skill; when-not: after the skill is loaded; args: page/pageSize; caveat: read the WHOLE SKILL.md before acting in the domain                                                                          |
| `skill_stats`        | Per-skill usage counters (suggested vs loaded)                      | skills-tool - default-enabled (manifest.ts:228)                              | when: measure skill adoption — suggested vs loaded counters; args: none; caveat: session + all-time counters (durable, skills-usage.json)                                                                                                     |
| `topic_drift`        | Check output for drift or reset topic anchors                       | topic-drift - default-enabled (manifest.ts:136, dep agent-environment)       | when: multi-part requests — check output against the original ask before responding; args: action check + output; caveat: reset re-anchors the topic                                                                                          |
| `timer`              | Set/list/cancel non-blocking session-scoped timers                  | timer - default-enabled (manifest.ts:222)                                    | when: non-blocking reminders between turns (babysit cadences, follow-ups); args: delay_seconds + reason; caveat: session-scoped; recurring via interval_seconds+count                                                                         |
| `orchestrate`        | Coordinate parallel agent workers (spawn/check/merge, locks)        | orchestrator - default-enabled (manifest.ts:233)                             | when: parallel workers share a tree — declare their files so edits don't collide; args: action register-worker/spawn-worker/check-worker/update-worker/list-workers/close-worker/verify-and-merge + files                                     |
| `behavior`           | Manage behavior patterns (activate/deactivate/list/mix)             | latent-activator - default-enabled (manifest.ts:243)                         | when: swap problem-solving modes to suit the task type (debugger/reviewer/explorer…); args: activate/deactivate/mix + behavior or scenario                                                                                                    |
| `memory_store`       | Persist insights/patterns/errors to long-term memory                | memory-agent-bridge - default-enabled (manifest.ts:197)                      | when: after fixes, conventions, root-cause findings — persist cross-session; when-not: session-local facts (scratchpad); args: content + memoryType; caveat: tags + importance shape recall                                                   |
| `memory`             | Unified memory: recall/episodes/heuristics                          | memory-agent-bridge - default-enabled (manifest.ts:197)                      | when: before non-trivial work — build on known context; args: action recall_search / episodes_search / heuristics_list + query                                                                                                                |
| `explore_paths`      | Per-hypothesis file search with first-15-lines evidence             | memory-agent-bridge - default-enabled (manifest.ts:197)                      | when: debugging with a named failure-mode hypothesis; args: hypothesis_1/2/3, each 'file because reason'; caveat: local search — no sub-agent                                                                                                 |
| `conflict_qa`        | Resolve contradictions between sources via the evidence pool        | memory-agent-bridge - default-enabled (manifest.ts:197)                      | when: sources or beliefs contradict; args: action resolve + verdict; caveat: evidence-pool based, reports classification                                                                                                                      |
| `session`            | Access past session history (search/query/analyze/stats/context)    | session-recall - default-enabled (manifest.ts:176, dep three-memory-stores)  | when: prior-work context needed across sessions (search/query/analyze/stats); args: action + query/sessionPath; caveat: project-scoped by default                                                                                             |
| `error`              | Inspect captured extension errors (list/get/clear/stats)            | error-tracking - opt-in, disabledByDefault (manifest.ts:276)                 | when: a tool or extension failed and you need the captured error history; args: action list/get/clear/stats                                                                                                                                   |
| `session_health`     | Read/reset session LLM-provider health state                        | health-maintenance - opt-in, disabledByDefault (manifest.ts:259)             | when: provider errors / auth / balance events occurred; args: action get/diagnose/recover; caveat: recover only after the user acted                                                                                                          |
| `health_maintenance` | Health-based maintenance (check/commit/rollback/benchmark)          | health-maintenance - opt-in, disabledByDefault (manifest.ts:259)             | when: agent self-state hygiene (check/commit/rollback/benchmark); args: action; caveat: rollback needs a checkpoint hash                                                                                                                      |

<!-- TOOLS-CATALOG-END -->

## Command catalog

Extension commands the tool catalog does not cover: slash commands registered by
the core and contrib extensions and named in no other document. A command with
a home beside its extension is not repeated here - `/watchdog-status` lives in
the watchdog `AGENTS.md`, the `/modules-*` family in `SETUP.md`.

| Command               | Registered by                   | What it does                                                              |
| --------------------- | ------------------------------- | ------------------------------------------------------------------------- |
| `/analytics`          | analytics (heartbeat module)    | Show tool analytics for the current session.                              |
| `/analytics:all`      | analytics (heartbeat module)    | Show tool analytics across all historical sessions.                       |
| `/analytics:ab`       | analytics (heartbeat module)    | Show A/B experiment results across variants.                              |
| `/context-stats`      | context-manager (memory module) | Show context pruning statistics.                                          |
| `/rate-cancel`        | rate-limiter (contrib)          | Cancel the rate limiter wait and reset its state.                         |
| `/tool-status`        | tool-config (contrib)           | Show current tool configuration.                                          |
| `/browser-start`      | browser (contrib)               | Spawn Chrome with remote debugging; `--profile` syncs cookies and logins. |
| `/browser-connect`    | browser (contrib)               | Connect to Chrome at :9222 (auto-starts if not running).                  |
| `/browser-disconnect` | browser (contrib)               | Disconnect from the browser session.                                      |

## Appendix: standalone packages surfaced into the braid prompt

The braid prompt surfaces every tool the loaded packages and pi-core provide via
`getAllTools()` (`prompt-builder/index.ts:300`); documented tools render their
`TOOL_GUIDELINES` reflection in the `Available tools:` list (single
rendering; the per-tool guideline no longer appears twice in the guidelines
section). Tools without a reflection - including the `context_compress` /
`context_inspect` / `context_navigate` / `context_proposals` family, whose
strategy is owned by `contextNavigationGuidelines` in `prompt-builder/index.ts`
(single home; a one-liner here would only restate it), and `offload_recover`,
whose affordance is named by the `[offloaded ...]` stub at exactly the moment
it is needed (the stub carries the invocation; a standing reflection would
restate it) - are shown with the
first sentence of their description, their session-tree / archive / health
guidance living in the context-navigation guidelines block, not here. The tools
below are
**NOT part of the pi-braid core package** - they are standalone (sibling contrib
package or third-party npm packages) and are documented here only for end-to-end
visibility. Their per-tool lines are NOT hardcoded here (ownership inversion): each tool's own package declares its guideline via
`pi.registerTool({ ..., promptGuidelines })` in its own registration - braid's
prompt-builder reads `promptGuidelines[0]` from `getAllTools()` at render time
(priority 1). The only braid-side entries are the `EXTERNAL_TOOL_GUIDELINES`
last-resort map (unpatched third-party npm packages: herdr, web*fetch) and
the `context*\*`family, whose strategy has a single home in`contextNavigationGuidelines` (a one-liner here would restate it) and which
fall back to the first sentence of their description.

### pi-braid-contrib (in-repo workspace)

`pi-braid-contrib` is the sibling `packages/contrib` workspace of this monorepo.
Its 12 extensions are all enabled by default with a per-extension toggle via
`braid.contrib.<name>` in
`~/.pi/agent/settings.json` (e.g. `"browser": false` drops the whole browser family).
Tool families it registers:

- **browser** - `browser_navigate`, `browser_snapshot`, `browser_eval`, `browser_screenshot` (plus `browser_content`, `browser_cookies`, `browser_tabs_*` in the full family). Drive a real browser tab for JS-heavy pages.
- **codebase** - analyze a codebase's structure or module dependency graph (tree/graph/impact).
- **diff** - `file_diff`: compare two files or git revisions (unified hunks and stats).
- **healthcheck** - comprehensive health checks on tools, extensions, and system resources.
- **observatory** - inspect the current pi session (status, registered tools, recorded events).
- **repl** - execute JavaScript code with context (RLM mode for chunk/search/map/reduce).
- **sleep** - block agent execution for a duration (do not use bash `sleep`).
- **system-monitor** - CPU/memory/disk/top-process metrics for performance troubleshooting.
- **network-monitor** - `tunnel_status` / `tunnel_reconnect` (plus the pinned `v2raytun_status` / `v2raytun_reconnect` aliases): probe a macOS tunnel client (`v2raytun`, `happ`, `incy`) and reconnect it through its own toggle mechanism. Off with `braid.contrib.networkMonitor: false`, tunable with an object.
- **path-security / rate-limiter / tool-config** - guard/plumbing extensions; no LLM-facing tools.

### pi-web-access (npm package)

- `web_search` - search the web and return source-linked results or provider answers.
- `fetch_content` - fetch URL(s) as readable markdown, raw text, or a prompt-answered extraction; supports direct images, GitHub repositories, PDFs, and videos.
- `source_check` - gather web sources for a claim into a bounded machine-readable research artifact with passage citations.
- `get_search_content` - retrieve stored search/fetch results by `responseId`, or locate passages without paging the full content.
- `web_enable` - enable the package's tools on the next model request (loader tool).

### @ogulcancelik/pi-herdr (npm package)

- `herdr_layout` / `herdr_pane` / `herdr_agent` - Herdr terminal topology: create/inspect workspaces/tabs/panes, control raw panes, and control recognized coding agents.

## Maintenance note

Keep the documented catalog (rows between the markers) and
`TOOL_GUIDELINES` in `src/extensions/core/prompt-builder/tool-guidelines.ts`
in lockstep: same tool set, same reflection strings. The sync test enforces
this in both directions. When a tool is enabled, its reflection renders in the
system prompt guidelines as `- <tool>: <reflection>`. The appendix is
informational only - adding a tool there does not grant it a prompt guideline.
