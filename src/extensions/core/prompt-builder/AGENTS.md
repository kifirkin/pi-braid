<!-- status: current -->

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
| `identity.ts` | 4 framing constants: `IDENTITY_INTRO` (generalist identity), `INTERACTION_STYLE`, `COMPACTION_SURVIVAL`, `LIVING_DOCS`. |
| `behavioral-guardrails.ts` | 11 value statements: 5 pre-existing (`SYCOPHANCY_RESISTANCE`, `STAKES_AWARENESS`, `EPISTEMIC_STABILITY`, `SURGICAL_PRECISION`, `BUDGET_AWARENESS`) + 5 new as of 2026-06-21 (`BROAD_PERSPECTIVE`, `STRATEGY_BEFORE_ACTION`, `REASONING_INTEGRITY`, `KNOWLEDGE_UNDER_PRESSURE`, `COMMUNICATION_QUALITY`) + 1 new as of 2026-06-22 (`EVIDENCE_GROUNDING`). |
| `contrast-phrase-library.ts` | Maps enforcement `contrastMode` values to phrase arrays. Returns a `PromptSection`. |
| `session-section.ts` | **v3.6** Session (volatile): PID, session elapsed, last-event, turns, tool-avg. Reads from `agent-environment/`. |
| `context-section.ts` | **v3.6** Context (conditional): context %, session health, memory count, steps-since-checkpoint. Returns `""` when nothing to surface. |
| `skills-section.ts` | Skills XML formatting + per-skill metadata + fingerprint cache. Returns a `PromptSection`. |
| `project-docs-section.ts` | Project docs (AGENTS.md / CLAUDE.md) pointer-only rendering as `<available_project_docs>` block. Mirrors the skills model. Includes fingerprint cache and `RESOURCES_DISCOVER` invalidation. |

## Local Contracts

### Values vs behaviors (architectural split, 2026-06-21)

This folder holds the **shared identity layer** — VALUES, not project-specific behaviors. The split:

- **Values (live here):** Identity-level statements that shape HOW the agent reasons and approaches problems. Generalist, applicable across all projects. Examples: `BROAD_PERSPECTIVE`, `REASONING_INTEGRITY`, `SYCOPHANCY_RESISTANCE`.
- **Behaviors (live in each project's AGENTS.md):** Concrete rules specific to that repo. Examples: "no `console.*` outside `lib/core/logger`", "use `sendTrackedMessage` for agent-bound messages", "use `getExtensionState(ctx, key, factory)` for per-session state". These would be project-specific baggage in the shared prompt and would drift the agent's identity toward whichever project is currently active.

Each value is one declarative sentence, framed as WHO the agent IS (not "do X" or "don't do Y"). Identity framings integrate more cleanly than behavioral rules and adapt better to context.

### Research provenance (not in the prompt itself)

The value statements are research-backed. The agent doesn't need to know about LLM failure modes — it just needs to embody the values. The provenance lives in `behavioral-guardrails.ts` comments for future maintainers.

### The `PromptSection` contract

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

### Adding a new value statement

Values are identity-level, not project-specific. Before adding a new value, ask:

1. Is this a **value** (how to think/approach) or a **behavior** (concrete rule for this project)? If behavior → goes in project AGENTS.md, not here.
2. Is it **generalist** (applies across domains) or domain-narrow (only software, only research, etc.)? Narrow values drift the identity.
3. Can it be expressed as one declarative sentence? If not, it's probably two values compressed.
4. Does it duplicate an existing value? If yes, sharpen the existing one instead.

If all four pass, add a new constant to `behavioral-guardrails.ts` (with a research-source comment), wire it into `index.ts` via `simpleSection("value-<name>", VALUE)`, and add a source-level test pinning the contract.

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
