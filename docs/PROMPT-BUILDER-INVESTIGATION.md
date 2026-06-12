# Prompt Builder — Deep Investigation and Refactor Plan

A full read of `src/extensions/core/prompt-builder/` and the SDK's
`buildSystemPrompt` flow. Documents the current state, identifies the
mixed-concept problem, and proposes a phased refactor with a
proof-of-concept first to de-risk the change.

## Status

Investigation: complete. Plan: ready for sign-off.
Baseline: `dfca48ec` on `main`, 32/32 tests pass, typecheck clean.

## Files in scope

```
src/extensions/core/prompt-builder/
├── index.ts                       (508L)  main handler + 3 section builders
├── l1-environment.ts              (236L)  L1 env gather + format
├── contrast-phrase-library.ts     (139L)  mode → phrase mapping
└── past-insights.ts               (170L)  offloaded to whisper (still consulted on first turn)

Related (consumed by prompt-builder):
src/extensions/core/agent-environment/index.ts  (L1 data + formatL1EnvironmentSection)
src/lib/ai/text-classifier.ts                   (utility-model hint relevance)
src/lib/ai/critic-registry.ts                   (CRITICS.hintRelevance)
src/lib/state/extension-state.ts                (per-session state)
src/lib/state/session-start-queue.ts            (MemoryState phase)
src/lib/utils/injection-tracker.ts              (sendTrackedMessage)
```

## What the SDK already does for us

`event.systemPrompt` is **not** a default template — it is the fully
built prompt the SDK assembled via `buildSystemPrompt(BuildSystemPromptOptions)`.
Verified in `node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:621`:

```js
_rebuildSystemPrompt(toolNames) {
    const toolSnippets = {};
    const promptGuidelines = [];
    for (const name of toolNames) {
        if (this._toolPromptSnippets.has(name)) toolSnippets[name] = ...;
        if (this._toolPromptGuidelines.has(name)) promptGuidelines.push(...);
    }
    const loadedSkills = this._resourceLoader.getSkills().skills;
    const loadedContextFiles = this._resourceLoader.getAgentsFiles().agentsFiles;
    this._baseSystemPromptOptions = {
        cwd, skills: loadedSkills, contextFiles: loadedContextFiles,
        customPrompt, appendSystemPrompt, selectedTools: toolNames,
        toolSnippets, promptGuidelines,
    };
    return buildSystemPrompt(this._baseSystemPromptOptions);
}
```

The SDK then emits `before_agent_start` with this already-rendered
prompt in `event.systemPrompt` and the structured inputs in
`event.systemPromptOptions`. The `extensions.md` docs on
`before_agent_start` are explicit: "Use it when your extension needs to
make deep, informed changes to the system prompt while respecting
user-provided configuration."

`buildSystemPrompt` (verified in `node_modules/.../core/system-prompt.js`)
produces, in this order:

1. `customPrompt` (if set) — or the default `You are an expert coding assistant operating inside pi...` intro
2. `Available tools:` — only tools that have a `toolSnippets` entry (one-line per tool)
3. `In addition to the tools above, you may have access to other custom tools...`
4. `Guidelines:` — built with `addGuideline` dedup, includes `promptGuidelines` (the per-tool guideline array) + always-included bullets (`Be concise`, `Show file paths clearly...`)
5. `Pi documentation (read only when the user asks about pi itself...)` — readme/docs/examples paths
6. `\n\n${appendSystemPrompt}` if present
7. `<project_context>` block with `contextFiles`
8. `<available_skills>` block from `formatSkillsForPrompt(skills)`
9. `\nCurrent date: YYYY-MM-DD`
10. `\nCurrent working directory: ${cwd}`

**What the SDK already exposes to us in `systemPromptOptions`:**

| Field | Type | What it is |
|---|---|---|
| `selectedTools` | `string[]` | Names of active tools |
| `toolSnippets` | `Record<string, string>` | One-line per tool |
| `promptGuidelines` | `string[]` | Per-tool guideline bullets (from `_toolPromptGuidelines`) |
| `appendSystemPrompt` | `string \| undefined` | User-provided append text |
| `contextFiles` | `Array<{path, content}>` | Pre-loaded AGENTS.md / CLAUDE.md files |
| `skills` | `Skill[]` | Pre-resolved skill list (from package manager) |
| `cwd` | `string` | Working dir |
| `customPrompt` | `string \| undefined` | Custom system prompt source if any |

## What the prompt-builder rebuilds from scratch

`index.ts:before_agent_start` currently constructs:

| # | Section | Source | Pattern | Dedup? |
|---|---|---|---|---|
| 1 | `IDENTITY_INTRO` | local const | `parts.push(SOME_INSTRUCTION)` | no |
| 1a | 7 behavior guardrails | local consts | `parts.push(SOME_INSTRUCTION)` x7 | no |
| 2 | Skills | `formatSkillsWithLineCounts(skills)` | `parts.push(sectionString)` | no |
| 3 | Tools | `reconstructToolsSection(tools)` | `parts.push(sectionString)` | **yes** (via `addGuideline`) |
| 4 | Project context | `reconstructProjectContextSection(cwd)` | `parts.push(sectionString)` | no |
| 5 | L1 environment | `formatL1Environment(env)` | `parts.push(sectionString)` | no |
| 6 | OpenSpec spec context | inline `parts.push(\`## Active Specs...\n${...}\`)` | string template | no |
| 7 | Contrast section | `formatContrastSection(mode)` | `parts.push(...arr)` (spread) | no |
| 8 | `INTERACTION_STYLE` | local const | `parts.push(SOME_INSTRUCTION)` | no |
| 9 | `appendSystemPrompt` | `event.systemPromptOptions.appendSystemPrompt` | `parts.push` (with `!parts.includes` dedup) | O(n) string check |
| 10 | Date + cwd | inline | `parts.push(\`Current time: ...\`)` | no |

Side work inside `before_agent_start` (not in the system prompt):
- Past insights + filtered hints → delivered as `sendTrackedMessage` whispers (first turn only)

Internal patterns of the section helpers:

| Helper | File | Returns | Internal pattern |
|---|---|---|---|
| `reconstructToolsSection` | index.ts | `string` | `guidelines: string[]` + `addGuideline` (dedup) + `.join("\n")` |
| `reconstructProjectContextSection` | index.ts | `string` | `lines: string[]` + `.push()` + `.join("\n")` |
| `formatSkillsWithLineCounts` | index.ts | `string` | `lines: string[]` + `.push()` + `.join("\n")` |
| `formatL1Environment` | l1-environment.ts | `string` | `lines: string[]` + `.push()` + `.join("\n")` |
| `formatContrastSection` | contrast-phrase-library.ts | `string[]` | `parts: string[]` + `.push()` |
| `formatPastInsightsSection` | past-insights.ts | `string` | `lines: string[]` + `.push()` + `.join("\n")` |

## The mixed-concept problem (the user's call-out)

Four subtly different ways of "push text into the prompt":

1. **Top-level `parts.push(SOME_INSTRUCTION)`** — used 17 times in `index.ts` handler. No dedup. Joined with `"\n\n"`.
2. **`addGuideline(g)`** — local helper inside `reconstructToolsSection`. Trims, dedups, skips empty. Joined with `"\n"`.
3. **`lines.push(...)`** — used in every section helper. No dedup. Joined with `"\n"`.
4. **Inline template literal** — OpenSpec: `parts.push(\`## Active Specs\\n\\n${specParts.join("\\n\\n")}\\n\\n...\`)`. No dedup.

Consequences of the inconsistency:

- A reader has to context-switch on every helper to know which pattern is in use.
- The dedup semantic of `addGuideline` is **valuable** but only available in one place.
- The return type of helpers is inconsistent: one (`formatContrastSection`) returns `string[]` (caller uses spread), the others return `string` (caller does plain push). Easy to miss when writing a new helper.
- The separator between sections is `"\n\n"` (top-level), but **inside** a section, the separator is `"\n"`. The two helpers that return arrays (contrast) embed their own leading blank via `parts.push("")` (past-insights) or no blank at all (contrast). Hard to predict output.

## Other concrete issues found

### 1. Work duplication

`reconstructToolsSection` re-derives `toolSnippets` from
`tool.description` via `firstSentence()` and rebuilds the guideline
list. **Both are already in `event.systemPromptOptions`**:
`toolSnippets` (one-line per tool) and `promptGuidelines` (the canonical
guideline bullets the SDK uses). The hard-coded `KNOWN_SNIPPETS` map
for `read`/`bash`/`edit`/`write`/`grep`/`find`/`ls` is also in the
SDK's tool registrations.

`reconstructProjectContextSection` re-walks the filesystem tree from
`cwd` upward looking for `AGENTS.md`/`CLAUDE.md`, with a `seenPaths`
set. This is a near-verbatim re-implementation of the SDK's
`loadProjectContextFiles` (verified in
`node_modules/.../core/resource-loader.js:47`). The result is already
in `event.systemPromptOptions.contextFiles`.

`reconstructSkillsSection` re-formats skills (we keep this — see "kept
braid enhancements" below).

### 2. OpenSpec context uses sync I/O inside an async handler

```ts
// in before_agent_start, an otherwise-async handler
const { join } = await import("node:path");
const { readdirSync, existsSync, readFileSync } = await import("node:fs");
const specDir = join(cwd, "openspec", "specs");
if (existsSync(specDir)) {
  const specParts: string[] = [];
  const domains = readdirSync(specDir, { withFileTypes: true });
  // ...
  const content = readFileSync(specPath, "utf-8");
```

`await import("node:path")` and `await import("node:fs")` are also
already top-level imports in this file (the `import { join }` at
line ~75 and `existsSync` is the only sync API). Dynamic imports
inside a hot path block the event loop on every agent turn. The
`agent-environment` sibling already uses `asyncExists` / async I/O
consistently.

### 3. Duplicated helpers

- `asyncExists` — defined identically in `index.ts:11` and `past-insights.ts:14`.
- `escapeXml` — defined in `index.ts:490`; the SDK ships the same helper in `node_modules/.../core/skills.js` (not exported, but trivially re-implementable as a one-liner, or we can avoid the need entirely).
- `firstSentence` — only used because we re-derive snippets; with `systemPromptOptions.toolSnippets`, this whole function goes away.

### 4. L1 environment naming collisions

`l1-environment.ts` re-exports its own `gatherL1State` and
`formatL1Environment` while importing and re-using
`gatherL1Environment` and `formatL1EnvironmentSection` from
`../agent-environment/index.js`. The pairs do similar but
non-identical work, and a reader has to track which "L1 environment"
is which. The re-hydration trick
(`if (_state.turnCount === 0 && ctx) { ... getExtensionState ... }`)
inside `gatherL1Environment` leaks module-internal state across
extension reloads.

### 5. `appendSystemPrompt` dedup is O(n) string search

`if (appendPrompt && !parts.includes(appendPrompt))` is an O(n)
membership test against the joined prompt. Works for small `parts`
arrays but is the wrong shape for a `Set<string>` membership.

### 6. Skill-cache invalidation: solid, keep

`skillsSectionCache` keyed by `fingerprintSkills(skills)`, invalidated
on `RESOURCES_DISCOVER`. Verified working. This pattern should be
**the template** for any future "expensive transform with cache" in
this directory.

## Mixed-concept fix: the canonical pattern

Introduce a single primitive and route every section through it.

```ts
// src/extensions/core/prompt-builder/section.ts  (new file)

/**
 * A PromptSection is a self-contained string rendered into the system prompt.
 * Sections know their own boundaries and emit one string (not an array).
 * Use dedup: true to drop duplicate lines (the addGuideline semantic).
 */
export interface PromptSection {
  /** Stable name for logs and tests. */
  readonly name: string;
  /** Render the section. Return "" to omit entirely. */
  render(): string | Promise<string>;
}

/**
 * Build a section from a simple list of lines.
 * - trims each line
 * - drops empties
 * - dedupes by default
 * - joins with "\n" internally
 */
export function linesSection(name: string, lines: string[], opts?: { dedup?: boolean }): PromptSection;

/**
 * Build a section from a heading + a body.
 * Heading is rendered as `## ${heading}` on its own line, then body.
 */
export function headingSection(name: string, heading: string, body: string): PromptSection;

/**
 * Compose a fixed set of sections with a section separator.
 * Skips sections whose render() returns "".
 */
export async function composeSections(sections: PromptSection[], separator = "\n\n"): Promise<string>;
```

The contract every helper must obey after the refactor:

1. Returns `PromptSection`, not `string` or `string[]`.
2. The top-level handler calls `composeSections([...])` once.
3. Section-internal layout (heading, bullets, XML) is the helper's responsibility.
4. `dedup` is a section option, not a separate helper.

This eliminates the four patterns and reduces the contract to two
verbs: `linesSection([...])` for simple lists, `headingSection(...)`
for headed blocks. `addGuideline` becomes a special case of
`linesSection([...], { dedup: true })`.

## Refactor plan

Three phases. Phase 0 is a small, low-risk POC that proves the
section primitive before the larger surgery. Phase 1 unifies the
patterns. Phase 2 switches to the surgical canonical pattern from
`event.systemPrompt`. Each phase is independently shippable.

## Decision (2026-06-12, this session)

**Phases 0 and 1 are in scope. Phase 2's main thrust (surgical
replacement) is deferred.**

The reimplementation is intentional: when the prompt-builder was
first written, the pi SDK's prompt API was poor, and braid's
reimplementation carried extensions on top (braid skill `<lines>` /
`<sections>`, custom XML wrappers, `firstSentence` snippet
extraction for tools whose descriptions are parameter schemas).
Tearing it apart in favor of `event.systemPrompt` would lose those
extensions and trade a known-good surface for one whose upside is
modest (saves ~100 lines of work the SDK now also does, in exchange
for coupling to SDK internals that may shift again).

**Phase 2 is parked, not deleted.** The investigation above (what
the SDK exposes, what the SDK does in `buildSystemPrompt`) is
captured here as a reference, and the decision can be revisited
later if the SDK prompt API stabilizes further or if maintaining
the reimplementation becomes a tax.

The smaller Phase 2 quality fixes that don't depend on the surgical
switch are folded into Phase 1: OpenSpec sync→async, `asyncExists`
dedup, `escapeXml` dedup, `l1-environment.ts` naming cleanup, the
`Set`-based appendSystemPrompt dedup.

### Phase 0 — POC: one section, one primitive (≈60 lines change, 1 commit)

Goal: validate the `PromptSection` interface and `composeSections` by
refactoring **just** the contrast section (smallest, most self-contained,
already returns an array which is the source of one of the inconsistencies).

- [ ] Create `src/extensions/core/prompt-builder/section.ts` with `PromptSection`, `linesSection`, `headingSection`, `composeSections`.
- [ ] Refactor `formatContrastSection` to return a `PromptSection` (use `headingSection`).
- [ ] In the main handler, replace the contrast bits (`parts.push(...formatContrastSection(...))`) with `parts.push(formatContrastSection(...))` (one push, not spread).
- [ ] Add a small assertion in the existing prompt-builder tests that the section produces the same output as before. If there's no direct test, add one that exercises `composeSections` and `formatContrastSection` round-trip.
- [ ] Run `npm run typecheck && npm run test`. Should still be 32/32.

**POC success criteria:**
- No prompt text changes for any current mode.
- The handler uses one fewer pattern (no more spread-of-array).
- Future sections can copy this template.

### Phase 1 — Unify the patterns (≈200 lines change, 1-2 commits)

Apply the same primitive to every section in the prompt-builder.

- [ ] Refactor `reconstructToolsSection` to return `PromptSection` (uses `linesSection([...], { dedup: true })` for the guidelines).
- [ ] Refactor `reconstructProjectContextSection` to return `PromptSection` (uses `linesSection` for the XML).
- [ ] Refactor `formatSkillsWithLineCounts` to return `PromptSection` (uses `linesSection` for the body).
- [ ] Refactor `formatL1Environment` to return `PromptSection` (uses `linesSection` for the body).
- [ ] Refactor `formatPastInsightsSection` to return `PromptSection`.
- [ ] The OpenSpec inline `parts.push(...)` becomes a `PromptSection` builder in its own file: `src/extensions/core/prompt-builder/openspec.ts`. Move the dynamic imports to the top.
- [ ] Top-level handler becomes:
    ```ts
    const sections: PromptSection[] = [
      simpleSection("identity", IDENTITY_INTRO),
      ...BEHAVIOR_GUARDRAILS.map(g => simpleSection("guardrail", g)),
      skillsSection,
      toolsSection,
      projectContextSection,
      pastInsightsSection, // (returns "" if not first turn)
      l1EnvSection,
      openspecSection,
      contrastSection,
      simpleSection("interaction-style", INTERACTION_STYLE),
      simpleSection("append", appendPrompt ?? ""),
      simpleSection("footer", `Current time: ${...}\nCurrent working directory: ${...}`),
    ];
    return { systemPrompt: await composeSections(sections) };
    ```
- [ ] Replace the O(n) `parts.includes(appendPrompt)` with a `Set<string>` passed to `composeSections` (or have `composeSections` track it).
- [ ] Remove the duplicated `asyncExists` (move to `src/lib/utils/async-fs.ts` and import from both `prompt-builder/index.ts` and `past-insights.ts`).
- [ ] Remove `firstSentence` and `escapeXml` if not used after the surgical refactor in Phase 2. (May be kept if Phase 2 is deferred.)

**Phase 1 success criteria:**
- Top-level handler is a flat list of `PromptSection` declarations.
- All section helpers return `PromptSection`.
- Tests pass, typecheck clean.
- Prompt output is byte-identical for any given input (compare a
  sample turn before/after).

### Phase 2 — DEFERRED (surgical replacement of native sections)

The full plan above is kept as a reference. The decision to defer is
documented under "Decision" above. Re-evaluate when the SDK prompt
API stabilizes further or when maintaining the reimplementation
becomes a tax.

**Quality fixes folded into Phase 1** (do not depend on the
surgical switch):
- OpenSpec spec context: sync I/O → async, dynamic imports → top-level.
- `asyncExists` deduplication (move to `src/lib/utils/async-fs.ts` or
  keep local; pick based on whether any other extension needs it).
- `escapeXml` deduplication (in `section.ts` or kept local).
- `l1-environment.ts` naming cleanup (rename for clarity).
- `parts.includes(appendPrompt)` → `Set<string>` dedup.

## What we are NOT changing

- **Identity / behavior guardrails / interaction style** — these are
  braid-specific and stay. They become sections in the new primitive.
- **Contrast phrases** — already a clean module, just wrap in
  `headingSection`.
- **Past insights + hints offloaded to whisper** — already correct per
  the previous handoff. The section becomes a no-op after the first
  turn.
- **OpenSpec spec context** — logic stays, just async I/O + extracted
  to its own file + `PromptSection` interface.
- **Skills cache + `RESOURCES_DISCOVER` invalidation** — solid pattern
  the rest of the directory should follow.

## Out of scope (deferred)

- Renaming `l1-environment.ts` or splitting it into smaller files. The
  file is 236 lines; further extraction is cosmetic.
- Removing the `LIVING_DOCS` / `COMPACTION_SURVIVAL` / etc. constant
  sprawl in `index.ts`. The refactor just routes them through
  `simpleSection(...)`. A future pass could move them to a single
  `behavioral-guardrails.ts` module.
- Changes to `agent-environment` itself. The L1 leak is documented but
  not fixed in this round.

## Quick-start for the next session

1. Read `src/extensions/core/prompt-builder/index.ts` end-to-end (~10
   min). The sections are numbered 1-10 in `before_agent_start`.
2. Read `node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.js` to internalize the canonical ordering.
3. Read `examples/extensions/prompt-customizer.ts` to see the surgical pattern in 90 lines.
4. Start with **Phase 0** (POC on contrast section). It's the smallest
   end-to-end exercise of the new primitive and proves the design
   before the larger surgery in Phase 1.
5. Each phase ends with a "prompt unchanged" verification (sample a
   turn before, sample after, diff).
