# edit-helper.ts — Safe File Edit Utilities

**Origin**: Commit `179b1d82` — "fix(context-manager): compaction v0.23"

**What it was supposed to do**: Provide `safeEdit`, `safeEditMulti`, `replaceInFile` that read
actual file content before modifying to avoid "exact text match" failures from stale reads.

**Why it was abandoned**: Pi's builtin `edit` tool already handles this. The edit-helper
approach was prototyped during compaction development but never wired to any extension.
The builtin edit tool's retry semantics were sufficient.

**What replaced it**: Pi's native `edit` tool with read-before-write semantics.

**Tests**: None.