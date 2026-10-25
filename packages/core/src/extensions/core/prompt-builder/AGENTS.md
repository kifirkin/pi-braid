<!-- status: current -->
<!-- Status note: identity compressed + PHILOSOPHY block added after EPISTEMIC_STANCE; the placement-discipline block and the PHILOSOPHY senior-craft line were reverted after the prompt re-probe failed its keep rule, REPAIR_DISCIPLINE stays; Resources section deleted; context guidelines reduced to the two policy sentences; pipelines cover 2 domains; tool guideline lines trimmed. Skills render in the prompt as the skills floor: every visible skill is one `- name: description` row, with the read path derived from the skills' own file paths (one root for a single pack, a directory heading per pack for several) and the mechanical trigger last; `list_skills` stays the price tool (reach, headings, ranking). The pi docs seat is a pointer to the pi-reference skill (the native `<docs>` region is not re-emitted). Policy relocation: the skills floor text and its drift trigger live in the skills-tool module (`loading-guidance.ts`); SURFACE_DISCIPLINE is its own section file; REPAIR_DISCIPLINE and SELF_AUDIT are identity blocks. The multi-agent message-contract constant is removed: the `[agent:…]` tag contract named a message format with no producer in any shipped mechanism, so the standing prompt asserted a channel that does not exist. The floor's rows and the trigger's worked examples are derived at assembly from the live cache, tool names and skill names (`skillsLoadingText` in skills-tool/loading-guidance.ts); no tool, skill or install path is hardcoded in prompt text. -->

# src/extensions/core/prompt-builder/ - System Prompt Composition

Builds the agent's system prompt by composing `PromptSection` fragments.
Orchestrates once-per-session whisper deliveries from `cognitive/` and `memory/`.

## Purpose

Single concern: **what the LLM sees on every turn** - the system prompt (sections below) plus the tool-descriptor half of the request: registered tool descriptions on the provider tools channel (`tool-description-trim.ts`).

Every file in this folder either:

- Builds a `PromptSection` (a self-contained string rendered into the prompt), or
- Holds constants that the main handler turns into a `PromptSection`, or
- Defines the `PromptSection` primitive itself.

## Ownership

| File                            | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.ts`                      | Main handler. Wires `before_agent_start`, calls the 4 `deliver*` functions, composes the final prompt. Renders the skills floor as its own guarded section (`skillsLoadingText` over the live visible catalog), after the identity seats and before the guidelines.                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `section.ts`                    | The `PromptSection` primitive + `composeSections` joiner + `simpleSection`, `linesSection`, `headingSection` builders.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `identity.ts`                   | Framing constants: `IDENTITY_INTRO` (generalist identity), `DISCOVERY` (D1 guarded exploration stance), `WORK_ETHIC` (methodical precision, signal-not-noise), `REPAIR_DISCIPLINE` (root cause named falsifiably before repair; re-derivation of claims that are not yours; weighted repair decisions), `SELF_MANAGEMENT` (memory workspace, evidence-carrying done items, known-open-check done gate), `COMMUNICATION` (conclusion-first, output style), `EPISTEMIC_STANCE` (identity-core: claim gate, self-state gate, retrieved-context preference), `SELF_AUDIT` (symmetric doubt; handoff ends with the unverified), `PHILOSOPHY` (character-level stance - silence, calm strategist, precise self-irony). |
| `surface-discipline-section.ts` | `SURFACE_DISCIPLINE` (signal discipline across code, commits, tests, docs, reports, logs) + `surfaceDisciplineSection()` - its own section, rendered between the identity and identity-core blocks. Text pinned verbatim by test-prompt-budget.mjs.                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `instance-composition.ts`       | **v3.8** Full Instance block: agent identity + pi-core version + core root + cwd + settings dir + os/pid + session (id + elapsed/last-event/turns/tool-avg) + top-level extension packages. Served on demand by the `system_info` tool. The prompt carries `renderCompactInstance`: braid build + install root, model, PID, session id, and skill/memory counts (process-stable facts only; see Local Contracts).                                                                                                                                                                                                                                                                                                |
| `top-level-extensions.ts`       | **v3.8** Discovery logic for top-level pi extension PACKAGES. Reads pi-core's `packages` field from `<cwd>/.pi/settings.json` (project) and `~/.pi/agent/settings.json` (user-global); project wins on collision. Resolves `npm:` specs in pi's managed install tree (`<agentDir>/npm/node_modules`) first, falling back to the global npm root (`npm root -g`); resolves local paths in place. Source tags: `project` / `user-global`.                                                                                                                                                                                                                                                                          |
| `project-docs-section.ts`       | Project docs (AGENTS.md / CLAUDE.md) pointer-only rendering as plain-text bullets (`- <basename> at <path>`). Mirrors the skills discoverability model but uses plain text (no XML tags) so the system prompt stays prose. Includes fingerprint cache and `RESOURCES_DISCOVER` invalidation.                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `memory-section.ts`             | Memory store pointer block (episodes + semantic + heuristics) as plain-text bullets (`- episodes at PATH`; count-free - per-store counts go stale at print time and are not rendered). Mirrors project-docs. Cached per session (static content, no fingerprint needed); invalidated on `RESOURCES_DISCOVER`.                                                                                                                                                                                                                                                                                                                                                                                                    |
| `context-section.ts`            | **v3.6** body fragment for the unified context block: context %, session health, steps-since-checkpoint. Returns `""` when nothing to surface. Composer (`index.ts`) joins this with project-docs and memory bodies. No heading. (Memory stores render pointer-only: per-store entry counts are not rendered; the whisper carries token counts, not memory counts.)                                                                                                                                                                                                                                                                                                                                              |
| `awareness-whisper.ts`          | Once-per-session context-hygiene steer whisper (customType `hygiene`): tokens in context + delta since the previous emission's baseline, the inspector pointer, and the injection-channel catalog; `formatAwarenessText` is tool-availability-aware; the TG inbound row is state-aware: it asserts reachability only when the poller liveness registry (`lib/state/telegram-poller-liveness.ts`) says the poller is running, else it hedges and names `telegram_poller status`. The catalog describes subsystem whispers by their stable envelope (produced by `lib/utils/whisper-format.ts`) instead of enumerating subsystems.                                                                                 |
| ~~`contrast-phrases.ts`~~       | **DELETED 2026-08-12 (keep+cut)** - legacy RepE-style phrase library (TRUTH_FIRST, ANTI_SYCOPHANCY, EPISTEMIC_STABILITY, KNOWLEDGE_BOUNDARY). Consolidated into `EPISTEMIC_STANCE` (identity.ts) on 2026-07-16; zero importers; provenance in the deleted file's git history.                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ~~`resources-section.ts`~~      | **DELETED** - the standalone `Resources: N skills` pointer line was dead: duplicated by the skills-loading contract and the list_skills tool description. The counts return only on the compact instance line (`Resources: N skills, M memories`) as a load signal. `excludeSkillsBlock` in `inspect.ts` keeps its Resources parser (absent-degrades-to-0) for non-braid prompt shapes.                                                                                                                                                                                                                                                                                                                          |
| `tool-pipelines.ts`             | Guarded multi-tool usage pipelines (research/debugging - the implementation pipeline was dropped, merged into COMMUNICATION's understand-before-act; the verification pipeline was dropped as a restatement of the verify/verify_claim/finalize rows); pinned by test-tool-pipelines.mjs.                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `tool-guidelines.ts`            | Per-tool guideline sync: `TOOL_GUIDELINES` (tool → one-line reflection, synced 1:1 with `packages/core/TOOLS.md`; mirror when-nots were trimmed and description restatements) + `perToolGuidelines()` `if has <tool>`-gated renderer + `resolveOwnedToolLine()` (tools-section resolver: owned lines only, the description fallback renders no row); pinned by the `tool-guidelines` describe block in test-tool-pipelines.mjs.                                                                                                                                                                                                                                                                                  |
| `pi-reference-section.ts`       | Pi docs seat: `PI_REFERENCE_POINTER` + `piReferenceSection()` - a static pointer to the `pi-reference` skill (docs index + install paths), rendered after the tools section. Replaced the native `<docs>` re-emission; the parity registry marks the native `docs` key dropped.                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `system-info-tool.ts`           | `system_info` tool: full Instance data on demand (detail full or compact). The seat for volatile facts (elapsed, last event, turns, tool average) and the core/cwd/settings path triple; a tool result is not a cached prefix.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `inspect.ts`                    | `prompt_inspect` tool: reads the actual system prompt from runtime.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `tool-description-trim.ts`      | Third-party tool-description trim: `before_provider_request` handler that shortens registered descriptions of `herdr_*` tools to 1-2 lines in the API tools channel (curated map + prefix fallback); the deep form moved to the `herdr-topology` skill (progressive disclosure). When-gate preserved in every rewrite.                                                                                                                                                                                                                                                                                                                                                                                           |

## Local Contracts

### Compact instance line (volatility rule)

`renderCompactInstance` renders the one-line `instance` section in the system prompt. The system prompt is a cached prefix, so the line carries process-stable facts only: braid build + install root, model (provider/id), PID, session id, and skill/memory counts. A timestamp, elapsed time, turn count, tool average, or context size would rewrite that prefix on every request and cost more than the field is worth; those facts stay in the `system_info` tool, which is a fresh turn by construction. The counts answer "did the skill pack and memory stores load", not "how many exactly". `test-instance-block.mjs` pins the line: no cwd field, no timestamp or duration token, and a 320-byte cap.

### Identity vs behaviors (architectural split)

This folder holds the **shared identity layer** -- IDENTITY framings, not project-specific behaviors. The split:

- **Identity framings (live here):** Generalist statements about WHO the agent is and HOW it expresses output. Apply across all projects. Examples: `IDENTITY_INTRO`, `WORK_ETHIC`, `COMMUNICATION`, `EPISTEMIC_STANCE`.
- **Behaviors (live in each project's AGENTS.md):** Concrete rules specific to that repo. Examples: "no `console.*` outside `lib/core/logger`", "use `sendTrackedMessage` for agent-bound messages", "use `getExtensionState(ctx, key, factory)` for per-session state". These would be project-specific baggage in the shared prompt and would drift the agent's identity toward whichever project is currently active.

Each identity constant is a short declarative block, framed as WHO the agent IS (not "do X" or "don't do Y"). Identity framings integrate more cleanly than behavioral rules and adapt better to context.

### Historical: values layer (deleted 2026-06-30, behavior modes removed 2026-07-13)

The prompt-builder previously held an 8-value statement layer in `behavioral-guardrails.ts` plus a runtime contrast-mode injection via `contrast-phrase-library.ts`. Both files were deleted as bloat, then the dynamic behavior-mode system was **restored** in a leaner form (`behavior-modes.ts`, 4 modes x 1-2 directives, wired to enforcement signals via `determineContrastMode()`), and itself removed later: the directives were distilled into static identity invariants in `identity.ts`, and the prompt-builder no longer listens for enforcement signals. <!-- doc-ref-exempt: removed contrast-mode helper named as history -->

What stayed deleted: the 8 static value statements (EPISTEMIC_INTEGRITY, BROAD_PERSPECTIVE, etc.). Verifier tools (`verify`, `verify_claim`, `finalize`) carry that rigor.

The four contrast phrases (TRUTH_FIRST, ANTI_SYCOPHANCY, EPISTEMIC_STABILITY, KNOWLEDGE_BOUNDARY) were consolidated into the `EPISTEMIC_STANCE` identity constant (2026-07-16); the dead `contrast-phrases.ts` wrapper was deleted 2026-08-12 (keep+cut) with provenance archived.

### Anti-bloat scope

Anti-bloat applies to the **static surfaces**: code, the system prompt, skill content, project docs content. It does NOT apply to the agent's chat session context -- the agent should be eager about reading pointers when their descriptions match the work. The `DISCOVERY` stance codifies this: exploration is a parallel keep-in-mind habit, pointer-on-demand.

The system prompt is freeform prose the author can evolve. The prompt-builder runtime tests (test-memory-section, test-tool-pipelines, test-instance-block, test-awareness-whisper) are **structural/wiring only** (rendered-block shape, guard semantics, export contracts, regression guards). Tests that previously pinned sentence counts, exact phrases, meta-LLM term scans, and vocabulary were removed per the user clarification that prose-pinning tests are idiotic.

Every section helper that contributes to the system prompt follows one rule:

```ts
export interface PromptSection {
  readonly name: string; // stable name for logs/tests
  render(): string | Promise<string>; // returns "" to omit
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
- Tool registrations, event handlers (other than `before_agent_start`, `RESOURCES_DISCOVER`, and the `before_provider_request` trim) - not prompt concerns
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

If all five pass, add a new constant to `identity.ts`, wire it into the identity join list (or its own section when it must render at a fixed seat), and pin it in the structural guard `test/runtime/lib/test-prompt-budget.mjs`.

**Note:** the dynamic behavior-mode system (`behavior-modes.ts`) was removed and its directives distilled into static identity invariants. New identity framings should follow the lean precedent -- one constant, one sentence, generalist -- not the 8-value research-citation style the deleted file used. There is no dynamic-directive mechanism in the prompt anymore; state-dependent guidance travels via whispers (see awareness-whisper.ts) instead.

### Adding a new whisper

1. Create the file in the natural home (`memory/`, `cognitive/`, etc.)
2. Export a `deliver*` function with the signature: `(cwd, pi, ctx) => Promise<void>`
3. Call it from the main handler's `if (!ps.insightsSent)` block (use `Promise.allSettled` to keep deliveries independent)
4. The whisper should use `sendTrackedMessage` with an explicit delivery class and a `customType` that identifies the source. Prompt-build advisories (read at the start of the run) use the park class: `delivery: "park", deliverAs: "steer"`.

### Renaming conventions

- `reconstructX` is the accepted prefix for cached rebuilders that return the rendered string (`reconstructMemorySection`, `reconstructProjectDocsSection`) <!-- doc-ref-exempt: naming-convention prefix -->
- A `format*` function that returns a string for the prompt is a smell; a section helper should return a `PromptSection`

## Verification

```bash
npm run typecheck   # must be clean
npm run test        # all suites green
```

## Child DOX Index

This folder has no child AGENTS.md files. The modules here are flat: each is a self-contained module without sub-structure. If a file grows beyond ~250 lines or develops sub-concepts, consider extracting a sub-module.
