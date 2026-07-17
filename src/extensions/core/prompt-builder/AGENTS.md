<!-- status: current -->
<!-- Updated 2026-07-03: project-docs + memory + runtime-context unified under one `## Context` heading. Skills keep XML; project-docs + memory now plain text. -->

# src/extensions/core/prompt-builder/ - System Prompt Composition

Builds the agent's system prompt by composing `PromptSection` fragments.
Orchestrates once-per-session whisper deliveries from `cognitive/` and `memory/`.

## Purpose

Single concern: **what the LLM sees in its system prompt on every turn**.

Every file in this folder either:
- Builds a `PromptSection` (a self-contained string rendered into the prompt), or
- Holds constants that the main handler turns into a `PromptSection`, or
- Defines the `PromptSection` primitive itself.

## Ownership

| File | Purpose |
|---|---|
| `index.ts` | Main handler. Wires `before_agent_start`, calls the 3 `deliver*` functions, composes the final prompt. |
| `section.ts` | The `PromptSection` primitive + `composeSections` joiner + `simpleSection`, `linesSection`, `headingSection` builders. |
| `identity.ts` | Framing constants: `IDENTITY_INTRO` (generalist identity), `INTERACTION_STYLE` (output *structure* + markup discipline), `CONCISE_RESPONSES` (output *when*), `COMPACTION_SURVIVAL`, `DEFINITION_OF_DONE` (SPQ-1: verification triple before finalize), `LIVING_DOCS`, `MEMORY_AWARENESS`, `SCOPES` (artifact-scope heuristic -- narrowest scope that satisfies purpose), `FRAMEWORK_CONFIG_FIRST` (config API before overrides), `RESOURCE_DISCOVERY` (pointer-on-demand for skills, docs, memory, runtime, framework APIs, external state; verify against source when correctness matters). |
| `behavior-modes.ts` | **Restored 2026-06-29** Dynamic behavior modes: 4 modes (TRUTH-SEEKING, CORRECTION, EPISTEMIC-CALIBRATION, TOOL-RELIABILITY) x 1-2 directives each. Wired to enforcement signals via `determineContrastMode()`. Replaces the deleted `behavioral-guardrails.ts` (8 static values) and `contrast-phrase-library.ts` (6 phrases + 4 mode defs). Lean successor: right directive at the right time instead of all directives always. |
| `instance-composition.ts` | **v3.8** Instance (consolidated): agent identity + pi-core version + root (pi-core npm package folder) + cwd + userland settings dir + os/hostname/now/pid + session (id + elapsed/last-event/turns/tool-avg) + top-level pi extension packages (settings-driven, scope-tagged `project` or `user-global`). |
| `top-level-extensions.ts` | **v3.8** Discovery logic for top-level pi extension PACKAGES. Reads pi-core's `packages` field from `<cwd>/.pi/settings.json` (project) and `~/.pi/agent/settings.json` (user-global); project wins on collision. Resolves `npm:` specs via `npm root -g`; resolves local paths in place. Source tags: `project` / `user-global`. |
| `skills-section.ts` | Skills XML formatting + per-skill metadata + fingerprint cache. Returns a `PromptSection`. |
| `project-docs-section.ts` | Project docs (AGENTS.md / CLAUDE.md) pointer-only rendering as plain-text bullets (`- <basename> at <path>`). Mirrors the skills discoverability model but uses plain text (no XML tags) so the system prompt stays prose. Includes fingerprint cache and `RESOURCES_DISCOVER` invalidation. |
| `memory-section.ts` | Memory store pointer block (episodes + semantic + heuristics) as plain-text bullets (`- episodes: N entries at PATH`). Mirrors project-docs. Includes file-fingerprint cache and `RESOURCES_DISCOVER` invalidation. |
| `context-section.ts` | **v3.6** body fragment for the unified context block: context %, session health, memory count, steps-since-checkpoint. Returns `""` when nothing to surface. Composer (`index.ts`) joins this with project-docs and memory bodies. No heading. |

## Local Contracts

### Identity vs behaviors (architectural split)

This folder holds the **shared identity layer** -- IDENTITY framings, not project-specific behaviors. The split:

- **Identity framings (live here):** Generalist statements about WHO the agent is and HOW it expresses output. Apply across all projects. Examples: `IDENTITY_INTRO`, `INTERACTION_STYLE`, `CONCISE_RESPONSES`.
- **Behaviors (live in each project's AGENTS.md):** Concrete rules specific to that repo. Examples: "no `console.*` outside `lib/core/logger`", "use `sendTrackedMessage` for agent-bound messages", "use `getExtensionState(ctx, key, factory)` for per-session state". These would be project-specific baggage in the shared prompt and would drift the agent's identity toward whichever project is currently active.

Each identity constant is one declarative sentence, framed as WHO the agent IS (not "do X" or "don't do Y"). Identity framings integrate more cleanly than behavioral rules and adapt better to context.

### Historical: values layer (deleted 2026-06-29, modes restored same day)

The prompt-builder previously held an 8-value statement layer in `behavioral-guardrails.ts` plus a runtime contrast-mode injection via `contrast-phrase-library.ts`. Both files were deleted 2026-06-29 as bloat, then the dynamic behavior-mode system was **restored the same day** in a leaner form (`behavior-modes.ts`).

What stayed deleted: the 8 static value statements (EPISTEMIC_INTEGRITY, BROAD_PERSPECTIVE, etc.). Verifier tools (`verify`, `verify_claim`, `finalize`) carry that rigor.

What was restored: the 4-mode dynamic system (TRUTH-SEEKING / CORRECTION / EPISTEMIC-CALIBRATION / TOOL-RELIABILITY) that surfaces the right directive based on enforcement state. The lean version has 1-2 directives per mode (down from 3 phrases per mode in the old library), no research citations in the prompt text, and no meta-LLM terminology.

The `determineContrastMode()` function in `src/extensions/enforcement/signals.ts` is consumed again by `turn-end-handler.ts` and `register-session-compact.ts`, which emit `enforcement_signals { contrastMode }`. The prompt-builder listens via `registerSessionStartHandler` and stores the mode in session state.

### Anti-bloat scope (clarified 2026-07-04)

Anti-bloat applies to the **static surfaces**: code, the system prompt, skill content, project docs content. It does NOT apply to the agent's chat session context -- the agent should be eager about reading pointers when their descriptions match the work. `RESOURCE_DISCOVERY` codifies this: pointer-on-demand + verify-against-source.

The system prompt is freeform prose the author can evolve. Tests in `test/runtime/lib/test-prompt-builder-directive.mjs` are **structural/wiring only** (existence, exports, simpleSection wiring, regression guards, structural counts). Tests that previously pinned sentence counts, exact phrases, meta-LLM term scans, and vocabulary were removed (2026-07-04) per the user clarification that prose-pinning tests are idiotic.

Every section helper that contributes to the system prompt follows one rule:

```ts
export interface PromptSection {
  readonly name: string;          // stable name for logs/tests
  render(): string | Promise<string>;  // returns "" to omit
}
```

Internal line arrangement is the helper's concern. The section as a whole is opaque to the main handler.

### Section naming convention

- `<name>Section(input): PromptSection` - the canonical shape
- Internal helpers (cache wrappers, formatters) can use any name; they're not exposed in the main handler

### Section builders (in `section.ts`)

- `simpleSection(name, content)` - one block of text
- `linesSection(name, lines, { dedup? })` - join an array; `dedup: true` skips duplicates (the `addGuideline` semantic)
- `headingSection(name, heading, body)` - `## ${heading}\n${body}` wrapper

### Composition

The main handler builds a flat `PromptSection[]` and composes via:

```ts
const newPrompt = await composeSections(sections, "\n\n", dedupSet);
```

`dedupSet` (optional `Set<string>`) skips sections whose rendered output is already in the set. Used for `appendSystemPrompt` dedup.

### What does NOT belong here

- Whisper deliveries (hints, past insights, OpenSpec) - live in their natural homes, imported by the main handler
- Tool registrations, event handlers (other than `before_agent_start` and `RESOURCES_DISCOVER`) - not prompt concerns
- Generic XML/JSON utilities - move to `lib/` if reused

## Work Guidance

### Adding a new system-prompt section

1. Decide: is this a system-prompt section or a whisper?
   - **Section**: every-turn content the agent must always see (identity, tools, project context, L1 env, contrast)
   - **Whisper**: once-per-session supplemental context (insights, hints, spec content) - create a `deliver*` function in the appropriate home folder
2. If section: create a new file in this folder with a `xSection(input): PromptSection` export
3. Add it to the main handler's section list (between identity/guardrails and the footer)
4. Update the table above

### Adding a new identity framing

Identity constants live in `identity.ts` and are wired into `index.ts` via `simpleSection`. The pre-flight check before adding one:

1. Is this an **identity** framing (who the agent is / how it expresses) or a **behavior** (concrete rule for this project)? If behavior -> goes in project AGENTS.md, not here.
2. Is it **generalist** (applies across domains) or domain-narrow? Narrow framings drift the identity.
3. Can it be expressed as one declarative sentence? If not, it's probably two framings compressed.
4. Does it duplicate an existing framing? If yes, sharpen the existing one instead.
5. Can the desired behavior be achieved with a tool call instead? (Verifier tools like `verify`, `verify_claim`, `finalize` carry rigor that identity framings used to enjoin. Don't restate tool capabilities as identity.)

If all five pass, add a new constant to `identity.ts`, wire it via `simpleSection("value-<name>", CONST)`, and add a source-level test in `test/runtime/lib/test-prompt-builder-directive.mjs`.

**Note (2026-06-29):** the previous value-statement layer (`behavioral-guardrails.ts`, 8 constants) was deleted and replaced with a dynamic behavior-mode system (`behavior-modes.ts`, 4 modes x 1-2 directives). New identity framings should follow the lean precedent -- one constant, one sentence, generalist -- not the 8-value research-citation style the deleted file used. For dynamic directives that should change based on enforcement state, add a mode to `behavior-modes.ts` instead.

### Adding a new whisper

1. Create the file in the natural home (`memory/`, `cognitive/`, etc.)
2. Export a `deliver*` function with the signature: `(cwd, pi, ctx) => Promise<void>`
3. Call it from the main handler's `if (!ps.insightsSent)` block (use `Promise.allSettled` to keep deliveries independent)
4. The whisper should use `sendTrackedMessage` with `deliverAs: "steer", triggerTurn: false` and a `customType` that identifies the source

### Renaming conventions

- Never use `formatX` or `reconstructX` prefixes - they were a holdover from when the functions returned strings, not `PromptSection`s
- A `format*` function that returns a string for the prompt is a smell; it should return a `PromptSection`

## Verification

```bash
npm run typecheck                                                # must be clean
npm run test                                                     # 31/32 pass expected; 1 pre-existing failure unrelated
npm run build && node /tmp/prompt-builder-snapshots/all-sections.mjs   # byte-identical sections
```

The snapshot script at `/tmp/prompt-builder-snapshots/all-sections.mjs` checks that each `PromptSection` helper renders to the same output as the previous known-good commit. Run it after any section-builder change to catch regressions.

If a section's output legitimately changes (e.g., a new guideline added), update the snapshot intentionally - do not skip the check.

## Child DOX Index

This folder has no child AGENTS.md files. The 7 files here are flat: each is a self-contained module without sub-structure. If a file grows beyond ~250 lines or develops sub-concepts, consider extracting a sub-module.
