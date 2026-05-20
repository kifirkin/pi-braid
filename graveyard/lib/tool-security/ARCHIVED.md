# tool-security.ts — Tool Restrictions for Subagents

**Origin**: Commit `71c959c0` — "feat: clean benchmark pipeline with security isolation"

**What it was supposed to do**: Provide `restrictTools()` to remove bash from active tools,
`createSafeSession()` for subagent isolation, and a `SAFE_TOOL_KEEP` whitelist.
Designed for benchmark subagents that shouldn't have shell access.

**Why it was abandoned**: Never wired to any extension or benchmark runner. Pi's builtin
`SAFE_MODE` environment variable covers the same use case at the framework level.
The file was left behind when its sole consumer (the benchmark pipeline) was refactored.

**What replaced it**: Pi's native `SAFE_MODE=true` env var.

**Tests**: None.