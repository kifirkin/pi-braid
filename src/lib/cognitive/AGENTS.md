<!-- status: current -->

# lib/cognitive

Whisper-delivery libraries for cognitive features.

These were originally placed at `src/extensions/cognitive/` at the
namespace level, which is wrong: they are pure libraries (no
`default export function xExtension`), not extensions. The
namespace-level placement triggered check-deps warnings.

**Files:**

- `hints.ts` — `deliverRelevantHints()` function. Reads
  `~/.pi/agent/braid/hints/consolidated.jsonl` and delivers
  project-relevant hints via `sendTrackedMessage`. Used by
  `prompt-builder` (the `hints` section of the system prompt).

- `openspec.ts` — `deliverActiveSpecs()` function. Reads the
  `openspec/` directory and delivers active spec summaries.
  Used by `prompt-builder` (the `openspec` section of the
  system prompt).

**Why `lib/` not `extensions/`:**

- No `default export function xExtension` (they're functions,
  not extensions).
- They were never registered in `manifest.ts` (only files in
  subdirectories are loaded).
- They have no `pi.on(...)` event handlers.

These were misplaced during an earlier refactor that organized
cognitive/ into subdirectories. The two stragglers at the
namespace level were missed.

**Imports:**

Both files import from `../utils/`, `../ai/`, `../config/`,
`../constants/`, and `../memory/past-insights.js`. They are
consumers of the lib/ tree, not extensions.
